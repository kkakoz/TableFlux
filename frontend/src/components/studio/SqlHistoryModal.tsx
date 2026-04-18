import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, History, Trash2, X } from "lucide-react";
import { clearSqlHistory, type SqlHistoryItem } from "../../utils/sqlHistory";
import { showAppMessage } from "../../utils/message";
import {
  classifySql,
  extractSqlObjectHint,
  matchesSqlFilter,
  type SqlFilterTab,
  SQL_PREVIEW_LINES,
  sqlKindBadgeClass,
  sqlKindLabel,
  splitSqlPreview,
} from "../../utils/sqlClassify";

type Props = {
  open: boolean;
  items: SqlHistoryItem[];
  onClose: () => void;
  /** 载入到编辑器并关闭弹窗 */
  onLoadToEditor: (sql: string) => void;
  /** 清空历史后回调（用于父组件刷新列表） */
  onCleared?: () => void;
  onCopyError?: (msg: string) => void;
};

const FILTER_TABS: { id: SqlFilterTab; label: string; hint?: string }[] = [
  { id: "all", label: "全部" },
  { id: "select", label: "SELECT" },
  { id: "update", label: "写入", hint: "INSERT / UPDATE / DELETE" },
  { id: "ddl", label: "DDL" },
];

export default function SqlHistoryModal({ open, items, onClose, onLoadToEditor, onCleared, onCopyError }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SqlFilterTab>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const kind = classifySql(item.sql);
      if (!matchesSqlFilter(kind, filter)) return false;
      if (!q) return true;
      return item.sql.toLowerCase().includes(q);
    });
  }, [items, query, filter]);

  const copySql = useCallback(
    async (id: string, sql: string) => {
      try {
        await navigator.clipboard.writeText(sql);
        setCopiedId(id);
        showAppMessage({ variant: "success", title: "复制成功", message: "SQL 已复制到剪贴板" });
        window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
      } catch {
        onCopyError?.("复制失败");
      }
    },
    [onCopyError],
  );

  const handleClear = useCallback(() => {
    if (items.length === 0) return;
    if (!window.confirm("确定清空全部 SQL 历史？此操作不可恢复。")) return;
    clearSqlHistory();
    onCleared?.();
    setExpandedIds(new Set());
  }, [items.length, onCleared]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/35 p-3 backdrop-blur-[1px]" role="presentation">
      <div
        className="flex max-h-[min(560px,85vh)] w-[min(720px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-slate-100/95 shadow-[0_16px_48px_-12px_rgba(15,23,42,0.28)] ring-1 ring-slate-200/60"
        role="dialog"
        aria-labelledby="sql-history-title"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 顶部工具栏 */}
        <header className="shrink-0 border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/90 px-4 pb-3 pt-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-white shadow-sm">
                  <History className="h-4 w-4" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <h2 id="sql-history-title" className="text-[15px] font-semibold leading-tight tracking-tight text-slate-900">
                    SQL 历史
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                    最近执行的语句，可搜索、筛选后载入编辑器
                  </p>
                </div>
              </div>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50"
              onClick={onClose}
              aria-label="关闭"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索 SQL 内容…"
                autoComplete="off"
                className="h-10 w-full rounded-lg border border-slate-200 bg-white py-0 pl-10 pr-10 text-xs leading-normal text-slate-800 shadow-inner outline-none ring-slate-300/40 placeholder:text-slate-400 focus:border-sky-300 focus:ring-2"
              />
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {FILTER_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.hint}
                  onClick={() => setFilter(t.id)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    filter === t.id
                      ? "bg-slate-800 text-white shadow-sm"
                      : "border border-slate-200/90 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              <button
                type="button"
                disabled={items.length === 0}
                onClick={handleClear}
                className="inline-flex items-center gap-1 rounded-md border border-rose-200/90 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                title="清空全部历史"
              >
                <Trash2 className="h-3 w-3" strokeWidth={2} />
                清空
              </button>
            </div>
          </div>
        </header>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-14 text-center">
              <p className="text-sm font-medium text-slate-600">{items.length === 0 ? "暂无历史记录" : "没有匹配的记录"}</p>
              <p className="max-w-xs text-[11px] text-slate-500">
                {items.length === 0 ? "执行 SQL 后会自动记录在此。" : "试试调整搜索词或筛选条件。"}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2 pb-1">
              {filtered.map((item) => {
                const kind = classifySql(item.sql);
                const hint = extractSqlObjectHint(item.sql);
                const expanded = expandedIds.has(item.id);
                const { text: previewText, lineCount } = splitSqlPreview(item.sql, expanded);
                const longSql = lineCount > SQL_PREVIEW_LINES;
                const badgeCls = sqlKindBadgeClass(kind);
                const label = sqlKindLabel(kind);

                return (
                  <li key={item.id}>
                    <article className="group rounded-lg border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:shadow-md">
                      <div className="flex flex-col gap-2 p-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <time className="font-mono text-[10px] tabular-nums text-slate-500" dateTime={new Date(item.at).toISOString()}>
                              {new Date(item.at).toLocaleString()}
                            </time>
                            <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ring-1 ${badgeCls}`}>
                              {label}
                            </span>
                            {hint ? (
                              <span className="max-w-[200px] truncate font-mono text-[10px] text-slate-500" title={hint}>
                                · {hint}
                              </span>
                            ) : null}
                          </div>

                          <div className="overflow-hidden rounded-md border border-slate-200/80 bg-slate-50">
                            <pre className="max-h-[min(220px,42vh)] overflow-auto p-2.5 font-mono text-[11px] leading-relaxed text-slate-800 [tab-size:2]">
                              {previewText}
                            </pre>
                            {longSql && !expanded ? (
                              <div className="border-t border-slate-200/80 bg-slate-100/80 px-2 py-1 text-center font-mono text-[10px] text-slate-500">
                                … 共 {lineCount} 行，已折叠显示前 {SQL_PREVIEW_LINES} 行
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-row gap-1 sm:flex-col sm:items-stretch">
                          <button
                            type="button"
                            onClick={() => onLoadToEditor(item.sql)}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-sky-600 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-sm transition hover:bg-sky-700 sm:flex-none"
                          >
                            载入编辑器
                          </button>
                          <button
                            type="button"
                            onClick={() => void copySql(item.id, item.sql)}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-50 sm:flex-none"
                          >
                            <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                            {copiedId === item.id ? "已复制" : "复制"}
                          </button>
                          {longSql ? (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(item.id)}
                              className="inline-flex flex-1 items-center justify-center gap-0.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 sm:flex-none"
                            >
                              {expanded ? (
                                <>
                                  <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
                                  收起
                                </>
                              ) : (
                                <>
                                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                                  展开
                                </>
                              )}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="shrink-0 border-t border-slate-200/80 bg-white/90 px-4 py-2 text-[10px] text-slate-500">
          共 {filtered.length} 条
          {items.length !== filtered.length ? `（全部 ${items.length} 条）` : null}
        </footer>
      </div>
    </div>
  );
}
