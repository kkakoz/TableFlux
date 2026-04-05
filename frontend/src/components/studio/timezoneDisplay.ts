const STORAGE_KEY = "tableflux.display_timezone";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export const TIMEZONE_OPTIONS = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "America/New_York",
] as const;

export function readDisplayTimezone(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && v.trim()) return v.trim();
  } catch {
    /* ignore */
  }
  return DEFAULT_TIMEZONE;
}

export function writeDisplayTimezone(tz: string) {
  try {
    localStorage.setItem(STORAGE_KEY, tz);
  } catch {
    /* ignore */
  }
}

/** 将单元格值格式化为当前时区下的时间展示（尽力解析 ISO / 常见 SQL 时间串） */
export function formatCellForTimezone(value: unknown, columnName: string, timeZone: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  const looksTime =
    /time|date|_at$/i.test(columnName) ||
    /\d{4}-\d{2}-\d{2}/.test(s) ||
    /T\d{2}:\d{2}/.test(s);
  if (!looksTime) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}
