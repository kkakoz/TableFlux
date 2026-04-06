/**
 * 是否允许「查看完整内容」等长文本展开：varchar/text/json 等；
 * 数值、时间、布尔等返回 false。依赖后端 ColumnTypes（DatabaseTypeName 小写）。
 */
export function isExpandableLongTextColumnType(dbType: string | undefined): boolean {
  if (dbType == null || dbType.trim() === "") return false;
  const t = dbType.toLowerCase().trim();

  if (
    /\b(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|money|serial|year|bit|bool|boolean)\b/.test(t) ||
    /\b(datetime|date|interval)\b/.test(t) ||
    t.includes("timestamp") ||
    /\b(time|timetz)\b/.test(t)
  ) {
    return false;
  }

  if (t.includes("varchar") || t.includes("nvarchar")) return true;
  if (t.includes("json")) return true;
  if (t.includes("text")) return true;
  if (t.includes("blob") || t.includes("clob")) return true;
  if (t.includes("binary") || t.includes("varbinary") || t.includes("bytea")) return true;
  if (/\b(enum|set)\b/.test(t)) return true;
  if (t.includes("char")) return true;

  return false;
}
