import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { WorkspaceGroup } from "../../types";

type ContextState = { x: number; y: number; group: WorkspaceGroup };

type Props = {
  groups: WorkspaceGroup[];
  selectedGroupId: string;
  groupConnCounts: Record<string, number>;
  groupName: string;
  onGroupNameChange: (v: string) => void;
  onCreateGroup: (e: FormEvent) => void;
  onSelectGroup: (id: string) => void;
  onOpenWorkbench: () => void;
  canOpenWorkbench: boolean;
  onEditGroup: (g: WorkspaceGroup) => void;
  onDeleteGroup: (g: WorkspaceGroup) => void;
};

function clampMenuPosition(x: number, y: number) {
  const w = 148;
  const h = 88;
  const margin = 8;
  const nx = Math.min(x, window.innerWidth - w - margin);
  const ny = Math.min(y, window.innerHeight - h - margin);
  return { x: Math.max(margin, nx), y: Math.max(margin, ny) };
}

export default function WorkspaceSidebar({
  groups,
  selectedGroupId,
  groupConnCounts,
  groupName,
  onGroupNameChange,
  onCreateGroup,
  onSelectGroup,
  onOpenWorkbench,
  canOpenWorkbench,
  onEditGroup,
  onDeleteGroup,
}: Props) {
  const [ctx, setCtx] = useState<ContextState | null>(null);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const t = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  const openContextMenu = (e: React.MouseEvent, g: WorkspaceGroup) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenuPosition(e.clientX, e.clientY);
    setCtx({ x, y, group: g });
  };

  const menu =
    ctx &&
    createPortal(
      <div
        className="fixed z-[200] min-w-[140px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-[12px] shadow-lg shadow-slate-900/15"
        style={{ left: ctx.x, top: ctx.y }}
        role="menu"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50"
          onClick={() => {
            onEditGroup(ctx.group);
            setCtx(null);
          }}
        >
          <Pencil className="h-3.5 w-3.5 text-slate-500" strokeWidth={2} />
          编辑
        </button>
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
          onClick={() => {
            onDeleteGroup(ctx.group);
            setCtx(null);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
          删除
        </button>
      </div>,
      document.body,
    );

  return (
    <aside className="flex h-full min-h-0 w-[220px] shrink-0 flex-col gap-2 self-stretch border-r border-slate-200 bg-slate-50/50 pr-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">工作区</div>
      <form className="flex gap-1.5" onSubmit={onCreateGroup}>
        <input
          className="tf-control min-w-0 flex-1 text-[12px]"
          value={groupName}
          onChange={(e) => onGroupNameChange(e.target.value)}
          placeholder="新分组…"
        />
        <button
          type="submit"
          className="tf-btn-toolbar shrink-0 px-2 text-[12px] font-medium"
        >
          新增
        </button>
      </form>

      <nav className="tf-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {groups.map((g) => {
          const active = selectedGroupId === g.id;
          const count = groupConnCounts[g.id] ?? 0;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelectGroup(g.id)}
              onContextMenu={(e) => openContextMenu(e, g)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition ${
                active
                  ? "bg-blue-50 font-medium text-blue-900 ring-1 ring-blue-200/80"
                  : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
              <span className="min-w-0 flex-1 truncate">{g.name}</span>
              <span
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                  active ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {menu}

      <button
        type="button"
        className="tf-btn-primary w-full shrink-0 justify-center text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canOpenWorkbench}
        onClick={onOpenWorkbench}
      >
        打开工作台
      </button>
    </aside>
  );
}
