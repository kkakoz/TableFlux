/** 用于展示与筛选的 SQL 类型 */
export type SqlKind =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "CREATE"
  | "ALTER"
  | "DROP"
  | "TRUNCATE"
  | "DDL_OTHER"
  | "OTHER";

export type SqlFilterTab = "all" | "select" | "update" | "ddl";

/** 去掉块注释与行注释后，用首行首词判断类型 */
export function classifySql(sql: string): SqlKind {
  let t = sql.trim();
  t = t.replace(/^\/\*[\s\S]*?\*\//, "").trim();
  t = t.replace(/^--[^\n]*/gm, "").trim();
  const line = t.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  const m = /^(\w+)/i.exec(line);
  const word = (m?.[1] ?? "").toUpperCase();
  if (word === "SELECT") return "SELECT";
  if (word === "INSERT") return "INSERT";
  if (word === "UPDATE") return "UPDATE";
  if (word === "DELETE") return "DELETE";
  if (word === "CREATE") return "CREATE";
  if (word === "ALTER") return "ALTER";
  if (word === "DROP") return "DROP";
  if (word === "TRUNCATE") return "TRUNCATE";
  if (word === "GRANT" || word === "REVOKE" || word === "COMMENT" || word === "RENAME") return "DDL_OTHER";
  return "OTHER";
}

export function sqlKindLabel(kind: SqlKind): string {
  switch (kind) {
    case "DDL_OTHER":
      return "DDL";
    case "OTHER":
      return "SQL";
    default:
      return kind;
  }
}

export function sqlKindBadgeClass(kind: SqlKind): string {
  switch (kind) {
    case "SELECT":
      return "bg-sky-100 text-sky-800 ring-sky-200/80";
    case "UPDATE":
      return "bg-amber-100 text-amber-900 ring-amber-200/80";
    case "INSERT":
      return "bg-teal-100 text-teal-900 ring-teal-200/80";
    case "DELETE":
      return "bg-rose-100 text-rose-800 ring-rose-200/80";
    case "CREATE":
      return "bg-emerald-100 text-emerald-900 ring-emerald-200/80";
    case "ALTER":
      return "bg-violet-100 text-violet-900 ring-violet-200/80";
    case "DROP":
      return "bg-red-100 text-red-900 ring-red-200/80";
    case "TRUNCATE":
    case "DDL_OTHER":
      return "bg-purple-100 text-purple-900 ring-purple-200/80";
    default:
      return "bg-slate-200 text-slate-700 ring-slate-300/80";
  }
}

/** 筛选：UPDATE 选项包含 INSERT/UPDATE/DELETE（写入类 DML） */
export function matchesSqlFilter(kind: SqlKind, tab: SqlFilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "select") return kind === "SELECT";
  if (tab === "update") return kind === "UPDATE" || kind === "INSERT" || kind === "DELETE";
  return (
    kind === "CREATE" ||
    kind === "ALTER" ||
    kind === "DROP" ||
    kind === "TRUNCATE" ||
    kind === "DDL_OTHER"
  );
}

/** 简单提取主要对象名（表/视图），用于辅助信息 */
export function extractSqlObjectHint(sql: string): string | undefined {
  const s = sql.replace(/\s+/g, " ").trim();
  const from = /\bFROM\s+([\w.]+)/i.exec(s);
  if (from) return from[1];
  const join = /\bJOIN\s+([\w.]+)/i.exec(s);
  if (join) return join[1];
  const upd = /\bUPDATE\s+([\w.]+)/i.exec(s);
  if (upd) return upd[1];
  const into = /\bINTO\s+([\w.]+)/i.exec(s);
  if (into) return into[1];
  const del = /\bDELETE\s+FROM\s+([\w.]+)/i.exec(s);
  if (del) return del[1];
  return undefined;
}

/** 折叠时默认展示的行数 */
export const SQL_PREVIEW_LINES = 3;

export function splitSqlPreview(sql: string, expanded: boolean): { text: string; hasMore: boolean; lineCount: number } {
  const lines = sql.split(/\r?\n/);
  const lineCount = lines.length;
  if (expanded || lineCount <= SQL_PREVIEW_LINES) {
    return { text: sql, hasMore: false, lineCount };
  }
  return {
    text: lines.slice(0, SQL_PREVIEW_LINES).join("\n"),
    hasMore: true,
    lineCount,
  };
}
