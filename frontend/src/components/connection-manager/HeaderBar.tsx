import { Settings2 } from "lucide-react";

type Props = {
  workspaceName?: string;
  onOpenSettings: () => void;
};

export default function HeaderBar({ workspaceName, onOpenSettings }: Props) {
  return (
    <header className="flex min-h-0 shrink-0 items-center justify-between gap-3 border-b border-slate-200/90 pb-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">TableFlux</h1>
          <span className="text-[13px] font-medium text-slate-700">连接管理</span>
          {workspaceName ? (
            <span className="truncate text-[11px] text-slate-400" title={workspaceName}>
              {workspaceName}
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="tf-btn-toolbar gap-1.5 text-[12px] font-medium shadow-sm"
        onClick={onOpenSettings}
        title="设置"
      >
        <Settings2 className="h-3.5 w-3.5" strokeWidth={2} />
        设置
      </button>
    </header>
  );
}
