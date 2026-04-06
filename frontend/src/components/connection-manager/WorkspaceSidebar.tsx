import type { FormEvent } from "react";
import type { WorkspaceGroup } from "../../types";

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
};

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
}: Props) {
  return (
    <aside className="flex h-full min-h-0 w-[220px] shrink-0 flex-col gap-2 self-stretch border-r border-slate-200 bg-slate-50/50 pr-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">工作区</div>
      <form className="flex gap-1.5" onSubmit={onCreateGroup}>
        <input
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15"
          value={groupName}
          onChange={(e) => onGroupNameChange(e.target.value)}
          placeholder="新分组…"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
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

      <button
        type="button"
        className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-[12px] font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canOpenWorkbench}
        onClick={onOpenWorkbench}
      >
        打开工作台
      </button>
    </aside>
  );
}
