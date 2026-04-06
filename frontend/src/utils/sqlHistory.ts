export type SqlHistoryItem = {
  id: string;
  sql: string;
  at: number;
};

export const SQL_HISTORY_KEY = "tableflux.sql_history";
export const SQL_HISTORY_LIMIT = 100;

export function readSqlHistory(): SqlHistoryItem[] {
  try {
    const raw = localStorage.getItem(SQL_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SqlHistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushSqlHistory(sql: string) {
  const text = (sql || "").trim();
  if (!text) return;
  const next: SqlHistoryItem[] = [
    { id: crypto.randomUUID(), sql: text, at: Date.now() },
    ...readSqlHistory().filter((i) => i.sql !== text),
  ].slice(0, SQL_HISTORY_LIMIT);
  localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next));
}

export function clearSqlHistory() {
  localStorage.removeItem(SQL_HISTORY_KEY);
}
