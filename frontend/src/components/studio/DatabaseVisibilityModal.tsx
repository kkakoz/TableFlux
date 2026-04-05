import { useEffect, useMemo, useState } from "react";
import { CheckSquare, Square, X } from "lucide-react";

type Props = {
  open: boolean;
  allDatabaseNames: string[];
  visible: Set<string>;
  onClose: () => void;
  onSave: (next: Set<string>) => void;
};

export default function DatabaseVisibilityModal({ open, allDatabaseNames, visible, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Set<string>>(visible);

  useEffect(() => {
    if (open) setDraft(new Set(visible));
  }, [open, visible]);

  const sorted = useMemo(() => [...allDatabaseNames].sort((a, b) => a.localeCompare(b)), [allDatabaseNames]);

  if (!open) return null;

  const toggle = (name: string) => {
    setDraft((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  };

  const selectAll = () => setDraft(new Set(sorted));
  const clearAll = () => setDraft(new Set());

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/35 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-tf border border-slate-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tf-db-vis-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 id="tf-db-vis-title" className="text-sm font-semibold text-slate-900">
            管理展示数据库
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <p className="px-4 pt-3 text-xs text-slate-500">仅勾选的库会出现在左侧对象树中。</p>
        <div className="max-h-72 overflow-auto px-2 py-2">
          {sorted.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-slate-500">当前连接下暂无数据库</p>
          ) : (
            <ul className="space-y-0.5">
              {sorted.map((name) => {
                const on = draft.has(name);
                return (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => toggle(name)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-50"
                    >
                      {on ? <CheckSquare className="h-4 w-4 shrink-0 text-blue-600" /> : <Square className="h-4 w-4 shrink-0 text-slate-400" />}
                      <span className="truncate font-mono">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={selectAll}>
            全选
          </button>
          <button type="button" className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={clearAll}>
            清空
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              onClick={() => onSave(draft)}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
