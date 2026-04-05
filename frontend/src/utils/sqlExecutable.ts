/**
 * 可执行 SQL 关键字（可扩展）。匹配时忽略大小写。
 * 未来可追加 DELETE、INSERT、CREATE 等。
 */
export const SQL_EXECUTABLE_KEYWORDS = [
  "SELECT",
  "UPDATE",
  "ALTER",
  "DELETE",
  "INSERT",
  "CREATE",
] as const;

export type SqlExecutableCheck =
  | { ok: true }
  | { ok: false; reason: string };

const HINT =
  "SQL 必须以 SELECT / UPDATE / ALTER 等关键字开头，并以英文分号 ; 结尾";

/**
 * 规则：trim 后必须以允许的关键字开头（词边界），且必须以 ; 结尾。
 */
export function validateSqlExecutable(raw: string): SqlExecutableCheck {
  const sql = (raw ?? "").trim();
  if (!sql) {
    return { ok: false, reason: HINT };
  }
  if (!sql.endsWith(";")) {
    return { ok: false, reason: HINT };
  }
  const head = sql.replace(/^\s+/, "");
  const upper = head.toUpperCase();
  const matched = SQL_EXECUTABLE_KEYWORDS.some((kw) => {
    if (!upper.startsWith(kw)) return false;
    const next = upper.charAt(kw.length);
    return next === "" || /\s/.test(head.charAt(kw.length));
  });
  if (!matched) {
    return { ok: false, reason: HINT };
  }
  return { ok: true };
}

export const SQL_EXECUTABLE_HINT = HINT;
