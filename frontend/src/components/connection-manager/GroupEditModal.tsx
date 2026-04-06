import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../api";
import type { WorkspaceGroup } from "../../types";

const COLOR_PRESETS = ["#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#ef4444", "#6366f1", "#8b5cf6", "#64748b"];

type Props = {
  open: boolean;
  group: WorkspaceGroup | null;
  onClose: () => void;
  onSaved: () => void;
  onError?: (msg: string) => void;
};

export default function GroupEditModal({ open, group, onClose, onSaved, onError }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#0ea5e9");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !group) return;
    setName(group.name);
    setColor(group.color || "#0ea5e9");
  }, [open, group]);

  if (!open || !group) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await api.updateGroup(group.id, {
        name: n,
        color,
        icon: group.icon || "database",
      });
      onSaved();
      onClose();
    } catch (err) {
      onError?.(String(err));
    } finally {
      setBusy(false);
    }
  };

  const modal = (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-edit-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[360px] rounded-[10px] border border-slate-200 bg-white shadow-xl shadow-slate-900/10"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 id="group-edit-title" className="text-[15px] font-semibold text-slate-900">
              编辑工作区分组
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">修改名称与标识色</p>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="space-y-3 px-4 py-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-600">分组名称</span>
            <input
              autoFocus
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="分组名称"
            />
          </label>
          <div>
            <span className="mb-1.5 block text-[12px] text-slate-600">标识色</span>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  className={`h-7 w-7 rounded-full ring-2 ring-offset-1 transition ${
                    color === c ? "ring-blue-500" : "ring-transparent hover:ring-slate-300"
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <input
              type="color"
              className="mt-2 h-8 w-full cursor-pointer rounded border border-slate-200 bg-white"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="自定义颜色"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={busy || !name.trim()}
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
