import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { ConnectionMeta, WorkspaceGroup } from "../../types";
import SettingsPanel from "../SettingsPanel";
import ConnectionModal from "./ConnectionModal";
import ConnectionListPanel from "./ConnectionListPanel";
import HeaderBar from "./HeaderBar";
import WorkspaceSidebar from "./WorkspaceSidebar";

const randomColor = () => {
  const colors = ["#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#ef4444", "#6366f1"];
  return colors[Math.floor(Math.random() * colors.length)];
};

export default function ConnectionManager() {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [groupConnCounts, setGroupConnCounts] = useState<Record<string, number>>({});
  const [groupName, setGroupName] = useState("");
  const [message, setMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editingConnection, setEditingConnection] = useState<ConnectionMeta | null>(null);

  const refreshGroupCounts = useCallback(async (groupList?: WorkspaceGroup[]) => {
    const list = groupList ?? (await api.listGroups());
    const counts: Record<string, number> = {};
    await Promise.all(
      list.map(async (g) => {
        try {
          const conns = await api.listGroupConnections(g.id);
          counts[g.id] = conns.length;
        } catch {
          counts[g.id] = 0;
        }
      }),
    );
    setGroupConnCounts(counts);
  }, []);

  const loadGroups = async () => {
    const list = await api.listGroups();
    const sorted = list.sort((a, b) => a.order - b.order);
    setGroups(sorted);
    if (!selectedGroupId && sorted.length > 0) {
      setSelectedGroupId(sorted[0].id);
    }
    await refreshGroupCounts(sorted);
  };

  const loadConnections = async (groupId: string) => {
    if (!groupId) {
      setConnections([]);
      return;
    }
    const list = await api.listGroupConnections(groupId);
    list.sort((a, b) => a.name.localeCompare(b.name));
    setConnections(list);
  };

  useEffect(() => {
    loadGroups().catch((e) => setMessage(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时拉取分组
  }, []);

  useEffect(() => {
    loadConnections(selectedGroupId).catch((e) => setMessage(String(e)));
    setSelectedConnId(null);
    setSearch("");
  }, [selectedGroupId]);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId);
  const workspaceTitle = selectedGroup?.name ?? "";

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    try {
      await api.createGroup(groupName.trim(), randomColor());
      setGroupName("");
      await loadGroups();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const onSaved = useCallback(async () => {
    await loadConnections(selectedGroupId);
    await refreshGroupCounts();
  }, [selectedGroupId, refreshGroupCounts]);

  const openCreateModal = () => {
    setModalMode("create");
    setEditingConnection(null);
    setModalOpen(true);
  };

  const openEditModal = (c: ConnectionMeta) => {
    setModalMode("edit");
    setEditingConnection(c);
    setModalOpen(true);
    setSelectedConnId(c.id);
  };

  const handleTest = async (c: ConnectionMeta) => {
    try {
      const msg = await api.testConnection(c.id);
      setMessage(msg || "测试成功");
      await loadConnections(selectedGroupId);
      await refreshGroupCounts();
    } catch (e) {
      setMessage(String(e));
    }
  };

  const handleDelete = async (c: ConnectionMeta) => {
    if (!window.confirm(`确定删除连接「${c.name}」？`)) return;
    try {
      await api.deleteConnection(c.id);
      if (selectedConnId === c.id) setSelectedConnId(null);
      await loadConnections(selectedGroupId);
      await refreshGroupCounts();
    } catch (e) {
      setMessage(String(e));
    }
  };

  return (
    <div className="light flex h-screen min-h-0 w-full flex-col overflow-hidden bg-[#f4f6f9]">
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2 sm:px-4 sm:py-3">
        <HeaderBar workspaceName={workspaceTitle} onOpenSettings={() => setSettingsOpen(true)} />

        <div className="mt-2 flex min-h-0 flex-1 gap-3 rounded-[10px] border border-slate-200 bg-white p-3 shadow-sm shadow-slate-900/5">
          <WorkspaceSidebar
            groups={groups}
            selectedGroupId={selectedGroupId}
            groupConnCounts={groupConnCounts}
            groupName={groupName}
            onGroupNameChange={setGroupName}
            onCreateGroup={createGroup}
            onSelectGroup={setSelectedGroupId}
            onOpenWorkbench={() => selectedGroupId && api.openGroupWindow(selectedGroupId)}
            canOpenWorkbench={Boolean(selectedGroupId)}
          />

          <ConnectionListPanel
            groupTitle={workspaceTitle}
            connectionCount={connections.length}
            search={search}
            onSearchChange={setSearch}
            connections={connections}
            selectedId={selectedConnId}
            onSelect={setSelectedConnId}
            onNew={openCreateModal}
            onTest={handleTest}
            onEdit={openEditModal}
            onDelete={handleDelete}
          />
        </div>

        {message ? (
          <div className="pointer-events-none fixed bottom-4 left-1/2 z-[90] max-w-[min(92vw,420px)] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 shadow-lg shadow-slate-900/10">
            <button
              type="button"
              className="pointer-events-auto float-right ml-2 text-slate-400 hover:text-slate-700"
              onClick={() => setMessage("")}
            >
              ×
            </button>
            {message}
          </div>
        ) : null}
      </div>

      {modalOpen ? (
        <ConnectionModal
          open={modalOpen}
          mode={modalMode}
          groupId={selectedGroupId}
          connection={editingConnection}
          onClose={() => setModalOpen(false)}
          onSaved={onSaved}
        />
      ) : null}

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
