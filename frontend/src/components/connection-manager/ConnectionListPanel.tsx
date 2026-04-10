import { Plus } from "lucide-react";
import type { ConnectionMeta } from "../../types";
import ConnectionCard from "./ConnectionCard";

type Props = {
  groupTitle: string;
  connectionCount: number;
  search: string;
  onSearchChange: (v: string) => void;
  connections: ConnectionMeta[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onTest: (c: ConnectionMeta) => void;
  onEdit: (c: ConnectionMeta) => void;
  onDelete: (c: ConnectionMeta) => void;
};

export default function ConnectionListPanel({
  groupTitle,
  connectionCount,
  search,
  onSearchChange,
  connections,
  selectedId,
  onSelect,
  onNew,
  onTest,
  onEdit,
  onDelete,
}: Props) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.host.toLowerCase().includes(q) ||
          c.user.toLowerCase().includes(q) ||
          (c.defaultDb && c.defaultDb.toLowerCase().includes(q)),
      )
    : connections;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-[13px] font-semibold text-slate-900">{groupTitle || "未选择分组"}</h2>
            <span className="text-[11px] text-slate-500">{connectionCount} 个连接</span>
          </div>
        </div>
        <div className="relative min-w-[160px] max-w-[220px] flex-1">
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索连接…"
            autoComplete="off"
            className="tf-control w-full px-3 text-[12px] text-slate-900 placeholder:text-slate-400"
          />
        </div>
        <button
          type="button"
          className="tf-btn-primary shrink-0 gap-1.5 text-[12px] disabled:opacity-40"
          onClick={onNew}
          disabled={!groupTitle}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          新建连接
        </button>
      </div>

      <div className="tf-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/40 p-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-10 text-center text-[12px] text-slate-500">
            <p>{connections.length === 0 ? "该分组下暂无连接" : "无匹配连接"}</p>
            {connections.length === 0 ? (
              <p className="text-[11px] text-slate-400">点击「新建连接」开始</p>
            ) : null}
          </div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(c.id);
                }
              }}
            >
              <ConnectionCard
                connection={c}
                selected={selectedId === c.id}
                onTest={() => onTest(c)}
                onEdit={() => onEdit(c)}
                onDelete={() => onDelete(c)}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
