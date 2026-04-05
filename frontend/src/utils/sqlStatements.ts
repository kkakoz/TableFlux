/**
 * 用于 gutter 识别「语句起始行」的关键字（可扩展）。
 * 行首（忽略前导空白）匹配，且关键字后须为空白/结束/左括号。
 */
export const GUTTER_STATEMENT_KEYWORDS = [
  "SELECT",
  "UPDATE",
  "ALTER",
  "DELETE",
  "INSERT",
  "CREATE",
  "DROP",
  "TRUNCATE",
  "WITH",
  "EXPLAIN",
] as const;

export type ParsedSqlStatement = {
  /** 1-based */
  startLine: number;
  /** 1-based，包含结束分号所在行 */
  endLine: number;
  sql: string;
};

function isKeywordStatementStart(trimmedLine: string): boolean {
  const m = trimmedLine.match(/^([A-Za-z_]+)(\s|$|\()/);
  if (!m) return false;
  const kw = m[1].toUpperCase();
  if (!(GUTTER_STATEMENT_KEYWORDS as readonly string[]).includes(kw)) return false;
  const after = trimmedLine.slice(m[1].length);
  return after === "" || /^\s/.test(after) || after.startsWith("(");
}

/**
 * 从 startLineIndex（0-based）开始扫描，直到遇到未在字符串内的分号。
 */
function extractStatementFromLines(lines: string[], startLineIndex: number): { sql: string; endLineIndex: number } | null {
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let j = startLineIndex; j < lines.length; j++) {
    const line = lines[j];
    if (j > startLineIndex) buf += "\n";
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      const prev = k > 0 ? line[k - 1] : "";
      if (inSingle) {
        buf += ch;
        if (ch === "'" && prev !== "\\") inSingle = false;
        continue;
      }
      if (inDouble) {
        buf += ch;
        if (ch === '"' && prev !== "\\") inDouble = false;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        buf += ch;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        buf += ch;
        continue;
      }
      if (ch === ";") {
        buf += ch;
        return { sql: buf.trim(), endLineIndex: j };
      }
      buf += ch;
    }
  }
  return null;
}

/**
 * 解析多段 SQL：每段以关键字行起始，以分号结束（支持跨行、简单引号内分号忽略）。
 */
export function parseSqlStatements(text: string): ParsedSqlStatement[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedSqlStatement[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith("--")) {
      i++;
      continue;
    }
    if (!isKeywordStatementStart(trimmed)) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const got = extractStatementFromLines(lines, i);
    if (!got) {
      i++;
      continue;
    }
    const { sql, endLineIndex } = got;
    if (sql.length > 0) {
      out.push({
        startLine,
        endLine: endLineIndex + 1,
        sql,
      });
    }
    i = endLineIndex + 1;
  }
  return out;
}

/** 光标所在行（1-based）属于哪条已解析语句；无则 null */
export function findStatementAtLine(statements: ParsedSqlStatement[], lineOneBased: number): ParsedSqlStatement | null {
  for (const s of statements) {
    if (lineOneBased >= s.startLine && lineOneBased <= s.endLine) return s;
  }
  return null;
}
