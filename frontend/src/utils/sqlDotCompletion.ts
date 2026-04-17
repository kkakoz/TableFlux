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

function normalizeSqlIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 从上一个分号到光标之间的片段里找当前库表名。这里不做完整 SQL 解析，只做标识符级别匹配，
 * 覆盖 `users`、"users"、db.users、schema.users 等常见写法。
 */
export function extractReferencedCurrentDatabaseTables(sqlFragment: string, tableNames: string[]): string[] {
  if (!sqlFragment.trim() || tableNames.length === 0) return [];

  const tableByLower = new Map(tableNames.map((name) => [name.toLowerCase(), name]));
  const found = new Set<string>();
  const identifierRe = /`(?:``|[^`])+`|"(?:[^"]|"")+"|[A-Za-z_][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = identifierRe.exec(sqlFragment)) !== null) {
    const identifier = normalizeSqlIdentifier(match[0]).toLowerCase();
    const tableName = tableByLower.get(identifier);
    if (tableName) found.add(tableName);
  }
  return [...found];
}

export function mergeContextTableColumnCompletionItems(
  monaco: typeof import("monaco-editor"),
  range: IRange,
  tableColumns: Array<{ tableName: string; columns: TableColumnSchema[] }>,
  keywords: string[],
): languages.CompletionItem[] {
  const fieldItems: languages.CompletionItem[] = [];
  const labels = new Set<string>();

  for (const table of tableColumns) {
    for (const col of table.columns) {
      const labelKey = `${table.tableName}.${col.name}`.toLowerCase();
      if (labels.has(labelKey)) continue;
      labels.add(labelKey);
      fieldItems.push({
        label: col.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: col.name,
        detail: table.tableName,
        documentation: [col.type, col.comment].filter(Boolean).join(" · "),
        sortText: `0_${col.name}_${table.tableName}`,
        range,
      });
    }
  }

  const fieldLabels = new Set(fieldItems.map((item) => String(item.label).toLowerCase()));
  const keywordItems: languages.CompletionItem[] = keywords
    .filter((kw) => !fieldLabels.has(kw.toLowerCase()))
    .map((kw) => ({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: kw,
      sortText: `1_${kw}`,
      range,
    }));

  return [...fieldItems, ...keywordItems];
}
