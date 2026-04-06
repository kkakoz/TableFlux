import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../api";
import type { ConnectionMeta } from "../../types";
import ConnectionForm from "./ConnectionForm";
import TestConnectionStatus from "./TestConnectionStatus";
import {
  defaultConnectionForm,
  parseMetaToForm,
  tagsFromForm,
  type ConnectionFormValues,
} from "./connectionFormTypes";

type TestPhase = "idle" | "loading" | "success" | "error";

type Props = {
  open: boolean;
  mode: "create" | "edit";
  groupId: string;
  /** 编辑模式下的连接对象；新建时 null */
  connection: ConnectionMeta | null;
  onClose: () => void;
  onSaved: () => void;
};

export default function ConnectionModal({ open, mode, groupId, connection, onClose, onSaved }: Props) {
  const [values, setValues] = useState<ConnectionFormValues>(defaultConnectionForm);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testPhase, setTestPhase] = useState<TestPhase>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [busy, setBusy] = useState(false);
  /** 新建弹窗内已通过「测试」等方式落库的连接 id，保存时应走更新 */
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  /** 仅 resolvedId 为本次弹窗新建时，取消可删除 */
  const [createdDraftId, setCreatedDraftId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setResolvedId(null);
    setCreatedDraftId(null);
    if (mode === "edit" && connection) {
      setValues(parseMetaToForm(connection));
      setResolvedId(connection.id);
    } else {
      setValues(defaultConnectionForm());
    }
    setAdvancedOpen(false);
    setTestPhase("idle");
    setTestMessage("");
  }, [open, mode, connection]);

  const effectiveId = resolvedId;

  const buildPayload = (favorite: boolean, prevTags: string[]) => {
    const tags = tagsFromForm(prevTags, values);
    return {
      groupId,
      name: values.name.trim(),
      driver: values.driver,
      host: values.host.trim(),
      port: Number(values.port),
      user: values.user,
      password: values.password,
      defaultDb: values.defaultDb,
      sslMode: values.sslMode,
      sshTunnel: false,
      tags,
      readOnlyFlag: false,
      favorite,
    };
  };

  const validate = (): string | null => {
    if (!values.name.trim()) return "请填写连接名称";
    if (!values.host.trim()) return "请填写主机";
    if (!values.user.trim()) return "请填写用户名";
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setTestPhase("error");
      setTestMessage(err);
      return;
    }
    if (!groupId) return;
    setBusy(true);
    try {
      if (effectiveId) {
        const prev =
          mode === "edit" && connection && connection.id === effectiveId
            ? connection
            : await fetchMetaForUpdate(effectiveId);
        await api.updateConnection(effectiveId, {
          ...buildPayload(prev.favorite, prev.tags),
          favorite: prev.favorite,
        });
      } else {
        await api.createConnection({
          ...buildPayload(false, []),
          favorite: false,
        });
      }
      setCreatedDraftId(null);
      onSaved();
      onClose();
    } catch (e) {
      setTestPhase("error");
      setTestMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  async function fetchMetaForUpdate(id: string): Promise<ConnectionMeta> {
    const list = await api.listGroupConnections(groupId);
    const found = list.find((c) => c.id === id);
    if (!found) throw new Error("找不到连接");
    return found;
  }

  const ensureConnectionIdForTest = async (): Promise<string | null> => {
    const err = validate();
    if (err) {
      setTestPhase("error");
      setTestMessage(err);
      return null;
    }
    if (!groupId) return null;
    if (effectiveId) return effectiveId;
    setBusy(true);
    try {
      const created = await api.createConnection({
        ...buildPayload(false, []),
        favorite: false,
      });
      setResolvedId(created.id);
      setCreatedDraftId(created.id);
      return created.id;
    } catch (e) {
      setTestPhase("error");
      setTestMessage(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setTestPhase("loading");
    setTestMessage("");
    const id = await ensureConnectionIdForTest();
    if (!id) {
      return;
    }
    try {
      const msg = await api.testConnection(id);
      setTestPhase("success");
      setTestMessage(msg || "连接成功");
      onSaved();
    } catch (e) {
      setTestPhase("error");
      setTestMessage(String(e));
    }
  };

  const handleCancel = async () => {
    const draft = createdDraftId;
    if (draft && mode === "create") {
      try {
        await api.deleteConnection(draft);
      } catch {
        /* ignore */
      }
    }
    setCreatedDraftId(null);
    onClose();
  };

  const closeIfBackdrop = () => {
    if (busy || testPhase === "loading") return;
    void handleCancel();
  };

  if (!open) return null;

  const title = mode === "create" ? "新建连接" : "编辑连接";
  const subtitle =
    mode === "create" ? "填写数据库连接信息" : `正在编辑：${connection?.name ?? ""}`;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeIfBackdrop();
      }}
    >
      <div
        className="flex max-h-[min(92vh,640px)] w-full max-w-[440px] flex-col overflow-hidden rounded-[10px] border border-slate-200 bg-white shadow-xl shadow-slate-900/10"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <h2 id="conn-modal-title" className="text-[15px] font-semibold tracking-tight text-slate-900">
              {title}
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={closeIfBackdrop}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="tf-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ConnectionForm
            values={values}
            onChange={setValues}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
            passwordHint={mode === "edit" ? "留空则不修改密码" : "密码"}
            autoFocus
          />
          <div className="mt-3">
            <TestConnectionStatus phase={testPhase} message={testMessage} />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-4 py-3">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50"
            onClick={() => void handleCancel()}
            disabled={busy || testPhase === "loading"}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={handleTest}
            disabled={busy || testPhase === "loading"}
          >
            测试连接
          </button>
          <button
            type="button"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            onClick={handleSave}
            disabled={busy || testPhase === "loading"}
          >
            保存连接
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
