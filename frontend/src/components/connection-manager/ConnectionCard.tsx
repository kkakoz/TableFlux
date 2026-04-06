import { Pencil, PlugZap, Trash2 } from "lucide-react";
import type { ConnectionMeta } from "../../types";

function envFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith("env:")) return t.slice(4);
  }
  return null;
}

function driverLabel(driver: string): string {
  if (driver === "postgres") return "PostgreSQL";
  if (driver === "mysql") return "MySQL";
  return driver;
}

function formatShortTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type Props = {
  connection: ConnectionMeta;
  selected: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export default function ConnectionCard({ connection: c, selected, onTest, onEdit, onDelete }: Props) {
  const env = envFromTags(c.tags ?? []);
  const updated = formatShortTime(c.updatedAt);
  const healthOk = c.lastHealthCheckOk;
  const hasCheck = Boolean(c.lastHealthCheckAt);

  return (
    <div
      className={`relative rounded-lg border bg-white px-3 py-2.5 shadow-sm transition hover:border-slate-300 hover:shadow-md ${
        selected ? "border-blue-400 ring-1 ring-blue-200" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-slate-900">{c.name}</span>
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
              {driverLabel(c.driver)}
            </span>
            {env ? (
              <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                {env === "dev" ? "开发" : env === "test" ? "测试" : env}
              </span>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-[11px] text-slate-600">
            {c.host}:{c.port}
            <span className="mx-1.5 text-slate-300">·</span>
            {c.user}
            {c.defaultDb ? (
              <>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="text-slate-700">{c.defaultDb}</span>
              </>
            ) : null}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
            {hasCheck ? (
              <span
                className={
                  healthOk ? "text-emerald-600" : "text-amber-700"
                }
              >
                {healthOk ? "最近测试成功" : "最近测试失败"}
              </span>
            ) : (
              <span className="text-slate-400">未测试</span>
            )}
            {updated ? <span className="text-slate-400">更新 {updated}</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="测试连接"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-600 hover:bg-slate-100"
            onClick={(e) => {
              e.stopPropagation();
              onTest();
            }}
          >
            <PlugZap className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            title="编辑"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-600 hover:bg-slate-100"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            title="删除"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-red-600 hover:bg-red-50"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
