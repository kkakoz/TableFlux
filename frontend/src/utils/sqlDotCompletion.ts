/**
 * 在输入「标识符.」后解析表/模式前缀，供 Monaco 补全列名。
 */

import type { IRange, languages } from "monaco-editor";
import type { TableColumnSchema } from "../types";

export type SqlCompletionContext = {
  connectionId: string;
  database: string;
  dialect: "mysql" | "postgres";
};

/**
 * 光标紧跟在 `.` 之后时，提取 `.` 左侧的限定名（如 user、public.users、db.tbl）。
 * @param cursorColumn Monaco 列号（1-based），光标在点号之后
 */
export function extractQualifierBeforeDot(line: string, cursorColumn: number): string | null {
  const dotIdx = cursorColumn - 2;
  if (dotIdx < 0 || line[dotIdx] !== ".") return null;
  let end = dotIdx - 1;
  while (end >= 0 && /\s/.test(line[end])) end--;
  if (end < 0) return null;
  let start = end;
  while (start >= 0 && /[\w`\.]/.test(line[start])) start--;
  const raw = line
    .slice(start + 1, end + 1)
    .replace(/`/g, "")
    .trim();
  return raw || null;
}

/** 将限定名解析为 GetTableSchema 参数（仅支持 1～2 段，与常见写法一致） */
export function resolveTableSchemaRequest(
  qualifier: string,
  ctx: SqlCompletionContext,
): { database: string; schema: string; table: string } | null {
  const parts = qualifier
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return { database: ctx.database, schema: "", table: parts[0] };
  }
  if (parts.length === 2) {
    if (ctx.dialect === "postgres") {
      return { database: ctx.database, schema: parts[0], table: parts[1] };
    }
    return { database: parts[0], schema: "", table: parts[1] };
  }
  return null;
}

/** 点号后补全：列（字段）优先，其次 SQL 关键字；列与关键字重复时保留列 */
export function mergeDotCompletionItems(
  monaco: typeof import("monaco-editor"),
  range: IRange,
  columns: TableColumnSchema[],
  keywords: string[],
): languages.CompletionItem[] {
  const colItems: languages.CompletionItem[] = columns.map((col) => {
    const parts: string[] = [col.type];
    if (col.comment) parts.push(col.comment);
    const detail = parts.filter(Boolean).join(" · ");
    let doc = "";
    if (col.primaryKey) doc += "主键 ";
    doc += col.nullable ? "可空" : "非空";
    if (col.autoIncrement) doc += " · 自增";
    return {
      label: col.name,
      kind: monaco.languages.CompletionItemKind.Field,
      insertText: col.name,
      detail,
      documentation: doc.trim(),
      sortText: `0_${col.name}`,
      range,
    };
  });

  colItems.push({
    label: "*",
    kind: monaco.languages.CompletionItemKind.Value,
    insertText: "*",
    detail: "所有列",
    sortText: "0_*",
    range,
  });

  const colLabels = new Set(colItems.map((c) => c.label));
  const kwItems: languages.CompletionItem[] = keywords
    .filter((kw) => !colLabels.has(kw))
    .map((kw) => ({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw,
      sortText: `1_${kw}`,
      range,
    }));

  return [...colItems, ...kwItems];
}
