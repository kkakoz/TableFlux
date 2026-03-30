import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  DataEditor,
  GridCellKind,
  getDefaultTheme,
  type DataEditorRef,
  type GridColumn,
  type Item,
  type GridCell,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { editor as MonacoEditorNS, IDisposable, languages } from "monaco-editor";
import { api } from "./api";
import type {
  ConnectionMeta,
  ExecuteSQLResult,
  WorkspaceGroup,
} from "./types";
import SettingsPanel from "./components/SettingsPanel";

type ViewMode = "main" | "studio";
type DbTreeNode = {
  name: string;
  expanded: boolean;
  loaded: boolean;
  tables: string[];
};

type WorkbenchTab = {
  id: string;
  title: string;
  type: "sql" | "table";
  sql: string;
  connectionId: string;
  contextDb: string;
  contextTable: string;
  result: ExecuteSQLResult | null;
  error: string;
};

const createSqlTab = (index: number, connectionId: string, database: string): WorkbenchTab => ({
  id: crypto.randomUUID(),
  title: `查询 ${index}`,
  type: "sql",
  sql: "",
  connectionId,
  contextDb: database,
  contextTable: "",
  result: null,
  error: "",
});

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER BY",
  "GROUP BY",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "ALTER",
  "DROP",
  "LIMIT",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "DISTINCT",
  "EXPLAIN",
];

const gridTheme: Theme = {
  ...getDefaultTheme(),
  bgCell: "#ffffff",
  bgCellMedium: "#f8fafc",
  bgHeader: "#f1f5f9",
  bgHeaderHovered: "#e2e8f0",
  bgHeaderHasFocus: "#e2e8f0",
  textDark: "#0f172a",
  textMedium: "#1e293b",
  textLight: "#334155",
  textHeader: "#0f172a",
  borderColor: "#cbd5e1",
  horizontalBorderColor: "#e2e8f0",
  accentColor: "#2563eb",
  accentLight: "rgba(37, 99, 235, 0.12)",
};

const GRID_ROW_HEIGHT = 32;
const GRID_HEADER_HEIGHT = 34;
const ROW_MARKER_WIDTH = 46;
const SQL_HISTORY_KEY = "tableflux.sql_history";
const SQL_HISTORY_LIMIT = 100;

type SqlHistoryItem = {
  id: string;
  sql: string;
  at: number;
};

function readSqlHistory(): SqlHistoryItem[] {
  try {
    const raw = localStorage.getItem(SQL_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SqlHistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pushSqlHistory(sql: string) {
  const text = (sql || "").trim();
  if (!text) return;
  const next: SqlHistoryItem[] = [
    { id: crypto.randomUUID(), sql: text, at: Date.now() },
    ...readSqlHistory().filter((i) => i.sql !== text),
  ].slice(0, SQL_HISTORY_LIMIT);
  localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next));
}

const randomColor = () => {
  const colors = ["#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#ef4444", "#6366f1"];
  return colors[Math.floor(Math.random() * colors.length)];
};

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const studioGroupId = params.get("groupId") ?? "";
  const mode: ViewMode = params.get("studio") === "1" ? "studio" : "main";

  if (mode === "studio") {
    return <StudioView groupId={studioGroupId} />;
  }
  return <MainView />;
}

function MainView() {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [groupName, setGroupName] = useState("");
  const [connForm, setConnForm] = useState({
    name: "",
    driver: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    defaultDb: "",
  });
  const [message, setMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadGroups = async () => {
    const list = await api.listGroups();
    setGroups(list.sort((a, b) => a.order - b.order));
    if (!selectedGroupId && list.length > 0) {
      setSelectedGroupId(list[0].id);
    }
  };

  const loadConnections = async (groupId: string) => {
    if (!groupId) {
      setConnections([]);
      return;
    }
    const list = await api.listGroupConnections(groupId);
    list.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    setConnections(list);
  };

  useEffect(() => {
    (async () => {
      await loadGroups();
    })().catch((e) => setMessage(String(e)));
  }, []);

  useEffect(() => {
    loadConnections(selectedGroupId).catch((e) => setMessage(String(e)));
  }, [selectedGroupId]);

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

  const createConnection = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedGroupId) return;
    try {
      await api.createConnection({
        groupId: selectedGroupId,
        name: connForm.name,
        driver: connForm.driver,
        host: connForm.host,
        port: Number(connForm.port),
        user: connForm.user,
        password: connForm.password,
        defaultDb: connForm.defaultDb,
        sslMode: "disable",
        sshTunnel: false,
        tags: [],
        readOnlyFlag: false,
        favorite: false,
      });
      setConnForm((prev) => ({ ...prev, name: "", password: "", defaultDb: "" }));
      await loadConnections(selectedGroupId);
    } catch (err) {
      setMessage(String(err));
    }
  };

  return (
    <div className="app-shell light">
      <header className="topbar">
        <div>
          <h1>TableFlux 数据库客户端</h1>
          <p className="sub">按分组管理连接，按分组打开独立工作台</p>
        </div>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
          ⚙ 设置
        </button>
      </header>

      <main className="main-grid">
        <section className="panel">
          <h2>连接分组</h2>
          <form className="row" onSubmit={createGroup}>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="新分组名称" />
            <button className="btn" type="submit">新增</button>
          </form>
          <div className="list">
            {groups.map((g) => (
              <button
                key={g.id}
                className={`list-item ${selectedGroupId === g.id ? "active" : ""}`}
                onClick={() => setSelectedGroupId(g.id)}
              >
                <span className="dot" style={{ backgroundColor: g.color }} />
                <span>{g.name}</span>
              </button>
            ))}
          </div>
          <button className="btn wide" disabled={!selectedGroupId} onClick={() => selectedGroupId && api.openGroupWindow(selectedGroupId)}>
            打开当前分组工作台
          </button>
        </section>

        <section className="panel">
          <h2>数据库连接</h2>
          <form onSubmit={createConnection} className="stack">
            <input value={connForm.name} onChange={(e) => setConnForm({ ...connForm, name: e.target.value })} placeholder="连接名称" />
            <div className="row">
              <select
                value={connForm.driver}
                onChange={(e) => setConnForm({ ...connForm, driver: e.target.value, port: e.target.value === "postgres" ? 5432 : 3306 })}
              >
                <option value="mysql">MySQL</option>
                <option value="postgres">PostgreSQL</option>
              </select>
              <input value={connForm.host} onChange={(e) => setConnForm({ ...connForm, host: e.target.value })} placeholder="主机" />
              <input type="number" value={connForm.port} onChange={(e) => setConnForm({ ...connForm, port: Number(e.target.value) })} placeholder="端口" />
            </div>
            <div className="row">
              <input value={connForm.user} onChange={(e) => setConnForm({ ...connForm, user: e.target.value })} placeholder="用户" />
              <input type="password" value={connForm.password} onChange={(e) => setConnForm({ ...connForm, password: e.target.value })} placeholder="密码" />
              <input value={connForm.defaultDb} onChange={(e) => setConnForm({ ...connForm, defaultDb: e.target.value })} placeholder="默认数据库" />
            </div>
            <button className="btn" type="submit">保存连接</button>
          </form>

          <div className="list">
            {connections.map((c) => (
              <div className="conn-card" key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <p>{c.driver} · {c.host}:{c.port}</p>
                </div>
                <div className="row">
                  <button className="btn ghost" onClick={() => api.testConnection(c.id).then(setMessage).catch((e) => setMessage(String(e)))}>
                    测试
                  </button>
                  <button className="btn ghost" onClick={() => api.setConnectionFavorite(c.id, !c.favorite).then(() => loadConnections(selectedGroupId))}>
                    {c.favorite ? "取消收藏" : "收藏"}
                  </button>
                  <button className="btn danger" onClick={() => api.deleteConnection(c.id).then(() => loadConnections(selectedGroupId))}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {message && <p className="message">{message}</p>}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function StudioView({ groupId }: { groupId: string }) {
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState("");
  const [dbTree, setDbTree] = useState<DbTreeNode[]>([]);
  const [selectedDatabase, setSelectedDatabase] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  const [tabsByDatabase, setTabsByDatabase] = useState<Record<string, WorkbenchTab[]>>({});
  const [activeTabByDatabase, setActiveTabByDatabase] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [editorHeight, setEditorHeight] = useState(360);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRev, setHistoryRev] = useState(0);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationMsg, setMigrationMsg] = useState("");
  const [allGroups, setAllGroups] = useState<WorkspaceGroup[]>([]);
  const [sourceGroupId, setSourceGroupId] = useState("");
  const [sourceConnectionId, setSourceConnectionId] = useState("");
  const [sourceDatabase, setSourceDatabase] = useState("");
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
  const [sourceTables, setSourceTables] = useState<string[]>([]);
  const [selectedSourceTables, setSelectedSourceTables] = useState<string[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [targetConnectionId, setTargetConnectionId] = useState("");
  const [targetDatabase, setTargetDatabase] = useState("");
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [targetTables, setTargetTables] = useState<string[]>([]);
  const [truncateTarget, setTruncateTarget] = useState(false);
  const [sourceGroupConnections, setSourceGroupConnections] = useState<ConnectionMeta[]>([]);
  const [targetGroupConnections, setTargetGroupConnections] = useState<ConnectionMeta[]>([]);
  const [aiAssistOpen, setAiAssistOpen] = useState(false);
  const [aiAssistPos, setAiAssistPos] = useState<{ left: number; top: number } | null>(null);
  const [aiAssistInput, setAiAssistInput] = useState("");
  const [aiAssistBusy, setAiAssistBusy] = useState(false);
  const [aiAssistErr, setAiAssistErr] = useState("");
  const [aiAssistFeedback, setAiAssistFeedback] = useState("");
  const [aiAssistResult, setAiAssistResult] = useState<{
    intent: string;
    type: string;
    content: string;
    explanation?: string;
    relevantTables?: string[];
    reason?: string;
  } | null>(null);

  const completionWordsRef = useRef<string[]>([...SQL_KEYWORDS]);
  const completionDisposableRef = useRef<IDisposable | null>(null);
  const monacoEditorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const runSQLRef = useRef<(mode: "single" | "batch") => void>(() => {});
  const addTabRef = useRef<() => void>(() => {});
  const openAiAssistRef = useRef<() => void>(() => {});
  const aiAssistInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStateRef = useRef<
    | { type: "sidebar"; startX: number; startWidth: number }
    | { type: "editor"; startY: number; startHeight: number }
    | null
  >(null);

  const databaseTabKey = `${activeConnectionId}::${selectedDatabase || "__none__"}`;
  const visibleTabs = tabsByDatabase[databaseTabKey] ?? [];
  const visibleActiveTabId = activeTabByDatabase[databaseTabKey] ?? "";
  const activeTab = visibleTabs.find((t) => t.id === visibleActiveTabId) ?? visibleTabs[0];
  const activeTabError = activeTab?.error ?? "";
  const activeTabResult = activeTab?.result ?? null;
  const sqlDialect = useMemo(() => {
    const c = connections.find((x) => x.id === activeConnectionId);
    return c?.driver === "postgres" ? "postgres" : "mysql";
  }, [connections, activeConnectionId]);
  const currentGroupName = allGroups.find((g) => g.id === groupId)?.name || groupId;
  const showSqlResultPane = activeTab?.type === "sql" && Boolean(activeTabResult || activeTabError);

  const saveSession = async (nextTabs: WorkbenchTab[], nextConn: string) => {
    try {
      await api.saveStudioSession({
        groupId,
        activeConnectionId: nextConn,
        tabs: nextTabs.map((t) => ({
          id: t.id,
          title: t.title,
          sql: t.sql,
          connectionId: t.connectionId,
          contextDb: t.contextDb,
          contextTable: t.contextTable,
        })),
      });
    } catch {
      // ignore non-blocking save failures
    }
  };

  useEffect(() => {
    const allTables = dbTree.flatMap((db) => db.tables);
    completionWordsRef.current = [...new Set([...SQL_KEYWORDS, ...allTables])];
  }, [dbTree]);

  useEffect(() => {
    if (!groupId) return;
    (async () => {
      const connList = await api.listGroupConnections(groupId);
      setConnections(connList);
      const groups = await api.listGroups();
      setAllGroups(groups);

      const session = await api.getStudioSession(groupId);
      const initialConn = session?.activeConnectionId || connList[0]?.id || "";
      if (session?.tabs?.length > 0) {
        const restoredTabs: WorkbenchTab[] = session.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          type: t.contextTable ? "table" : "sql",
          sql: t.sql,
          connectionId: t.connectionId,
          contextDb: t.contextDb,
          contextTable: t.contextTable,
          result: null,
          error: "",
        }));
        const defaultDb = restoredTabs[0]?.contextDb || "";
        const key = `${initialConn}::${defaultDb || "__none__"}`;
        setTabsByDatabase({ [key]: restoredTabs });
        setActiveTabByDatabase({ [key]: restoredTabs[0]?.id || "" });
      }
      setActiveConnectionId(initialConn);
      setSourceGroupId(groupId);
      setTargetGroupId(groupId);
    })().catch((e) => setError(String(e)));
  }, [groupId]);

  useEffect(() => {
    if (!sourceGroupId) {
      setSourceGroupConnections([]);
      return;
    }
    api
      .listGroupConnections(sourceGroupId)
      .then((list) => setSourceGroupConnections(list))
      .catch((e) => setError(String(e)));
  }, [sourceGroupId]);

  useEffect(() => {
    if (!targetGroupId) {
      setTargetGroupConnections([]);
      return;
    }
    api
      .listGroupConnections(targetGroupId)
      .then((list) => setTargetGroupConnections(list))
      .catch((e) => setError(String(e)));
  }, [targetGroupId]);

  useEffect(() => {
    if (!sourceConnectionId) {
      setSourceDatabases([]);
      setSourceDatabase("");
      setSourceTables([]);
      setSelectedSourceTables([]);
      return;
    }
    api
      .listDatabases(sourceConnectionId)
      .then((dbs) => {
        const names = (dbs || []).map((d: any) => d.name);
        setSourceDatabases(names);
        setSourceDatabase("");
        setSourceTables([]);
        setSelectedSourceTables([]);
      })
      .catch((e) => setError(String(e)));
  }, [sourceConnectionId]);

  useEffect(() => {
    if (!targetConnectionId) {
      setTargetDatabases([]);
      setTargetDatabase("");
      setTargetTables([]);
      return;
    }
    api
      .listDatabases(targetConnectionId)
      .then((dbs) => {
        const names = (dbs || []).map((d: any) => d.name);
        setTargetDatabases(names);
        setTargetDatabase("");
        setTargetTables([]);
      })
      .catch((e) => setError(String(e)));
  }, [targetConnectionId]);

  useEffect(() => {
    if (!sourceConnectionId || !sourceDatabase) {
      setSourceTables([]);
      setSelectedSourceTables([]);
      return;
    }
    api
      .listTables(sourceConnectionId, sourceDatabase, "")
      .then((tables) => {
        const names = (tables || []).map((t: any) => t.name).sort();
        setSourceTables(names);
        setSelectedSourceTables([]);
      })
      .catch((e) => setError(String(e)));
  }, [sourceConnectionId, sourceDatabase]);

  useEffect(() => {
    if (!targetConnectionId || !targetDatabase) {
      setTargetTables([]);
      return;
    }
    api
      .listTables(targetConnectionId, targetDatabase, "")
      .then((tables) => {
        const names = (tables || []).map((t: any) => t.name).sort();
        setTargetTables(names);
      })
      .catch((e) => setError(String(e)));
  }, [targetConnectionId, targetDatabase]);

  useEffect(() => {
    if (!activeConnectionId) return;
    saveSession(visibleTabs, activeConnectionId);
  }, [visibleTabs, activeConnectionId]);

  const reloadDbTree = async () => {
    if (!activeConnectionId) {
      setDbTree([]);
      setSelectedDatabase("");
      return;
    }
    try {
      const dbs = await api.listDatabases(activeConnectionId);
      const names = dbs.map((d: any) => d.name);
      setDbTree(
        names.map((name) => ({
          name,
          expanded: false,
          loaded: false,
          tables: [],
        }))
      );
      setSelectedDatabase("");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void reloadDbTree();
  }, [activeConnectionId, connections]);

  const loadTablesForDB = async (dbName: string) => {
    if (!activeConnectionId || !dbName) return;
    const current = dbTree.find((d) => d.name === dbName);
    if (current?.loaded) return;
    try {
      const list = await api.listTables(activeConnectionId, dbName, "");
      const tableNames = (list || []).map((t: any) => t.name);
      setDbTree((prev) =>
        prev.map((d) => (d.name === dbName ? { ...d, loaded: true, tables: tableNames } : d))
      );
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (!selectedDatabase) return;
    loadTablesForDB(selectedDatabase);
  }, [selectedDatabase, activeConnectionId]);

  useEffect(() => {
    if (!activeConnectionId || !selectedDatabase) return;
    const firstTab = createSqlTab(1, activeConnectionId, selectedDatabase);
    setTabsByDatabase((prev) => {
      if (prev[databaseTabKey] && prev[databaseTabKey].length > 0) return prev;
      return {
        ...prev,
        [databaseTabKey]: [firstTab],
      };
    });
    setActiveTabByDatabase((prev) => {
      if (prev[databaseTabKey]) return prev;
      return {
        ...prev,
        [databaseTabKey]: firstTab.id,
      };
    });
  }, [activeConnectionId, selectedDatabase, databaseTabKey]);

  const toggleDatabaseExpand = async (dbName: string) => {
    let shouldLoad = false;
    setDbTree((prev) =>
      prev.map((d) => {
        if (d.name !== dbName) return d;
        const nextExpanded = !d.expanded;
        if (nextExpanded && !d.loaded) shouldLoad = true;
        return { ...d, expanded: nextExpanded };
      })
    );
    if (shouldLoad) {
      await loadTablesForDB(dbName);
    }
  };

  const selectDatabase = async (dbName: string) => {
    setSelectedDatabase(dbName);
    const target = dbTree.find((d) => d.name === dbName);
    if (!target?.expanded) {
      setDbTree((prev) => prev.map((d) => (d.name === dbName ? { ...d, expanded: true } : d)));
    }
    if (!target?.loaded) {
      await loadTablesForDB(dbName);
    }
  };

  const filteredTree = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) {
      return dbTree.map((d) => ({ ...d, visibleTables: d.tables, forceExpanded: false })).filter(Boolean);
    }
    return dbTree
      .map((d) => {
        const dbMatched = d.name.toLowerCase().includes(q);
        const visibleTables = d.tables.filter((t) => t.toLowerCase().includes(q));
        if (!dbMatched && visibleTables.length === 0) {
          return null;
        }
        return { ...d, visibleTables: dbMatched ? d.tables : visibleTables, forceExpanded: true };
      })
      .filter((d): d is DbTreeNode & { visibleTables: string[]; forceExpanded: boolean } => Boolean(d));
  }, [dbTree, tableFilter]);

  const upsertDatabaseTabs = (dbName: string, updater: (tabs: WorkbenchTab[]) => WorkbenchTab[]) => {
    if (!activeConnectionId) return;
    const key = `${activeConnectionId}::${dbName || "__none__"}`;
    setTabsByDatabase((prev) => {
      const current = prev[key] ?? [createSqlTab(1, activeConnectionId, dbName)];
      return {
        ...prev,
        [key]: updater(current),
      };
    });
  };

  const setActiveForDatabase = (dbName: string, tabId: string) => {
    if (!activeConnectionId) return;
    const key = `${activeConnectionId}::${dbName || "__none__"}`;
    setActiveTabByDatabase((prev) => ({ ...prev, [key]: tabId }));
  };

  const setTabSQL = (sql: string) => {
    if (!activeTab) return;
    upsertDatabaseTabs(activeTab.contextDb || selectedDatabase, (list) =>
      list.map((t) => (t.id === activeTab.id ? { ...t, sql, connectionId: activeConnectionId, contextDb: selectedDatabase } : t))
    );
  };

  const appendSelectSQL = (dbName: string, tableName: string) => {
    if (!activeConnectionId) return;
    setSelectedDatabase(dbName);
    const key = `${activeConnectionId}::${dbName || "__none__"}`;
    const existed = tabsByDatabase[key]?.find((t) => t.type === "table" && t.contextTable === tableName);
    const tableTabId = existed?.id ?? crypto.randomUUID();
    setTabsByDatabase((prev) => {
      const current = prev[key] ?? [createSqlTab(1, activeConnectionId, dbName)];
      if (existed) return prev;
      const tableTab: WorkbenchTab = {
        id: tableTabId,
        title: tableName,
        type: "table",
        sql: `SELECT * FROM ${tableName}`,
        connectionId: activeConnectionId,
        contextDb: dbName,
        contextTable: tableName,
        result: null,
        error: "",
      };
      return { ...prev, [key]: [...current, tableTab] };
    });
    setActiveForDatabase(dbName, tableTabId);
    void (async () => {
      try {
        const r = await api.executeSQL({
          connectionId: activeConnectionId,
          database: dbName,
          sql: `SELECT * FROM ${tableName}`,
          mode: "single",
          rowLimit: 50000,
          timeoutMs: 30000,
        });
        setTabsByDatabase((prev) => {
          const list = prev[key] ?? [];
          return {
            ...prev,
            [key]: list.map((t) => (t.id === tableTabId ? { ...t, result: r, error: "" } : t)),
          };
        });
      } catch (e) {
        setTabsByDatabase((prev) => {
          const list = prev[key] ?? [];
          return {
            ...prev,
            [key]: list.map((t) => (t.id === tableTabId ? { ...t, error: String(e), result: null } : t)),
          };
        });
      }
    })();
  };

  useEffect(() => {
    if (tableFilter.trim() === "") return;
    const unloaded = dbTree.filter((db) => !db.loaded).map((db) => db.name);
    unloaded.forEach((dbName) => {
      loadTablesForDB(dbName).catch((e) => setError(String(e)));
    });
  }, [tableFilter, dbTree]);

  const runSQL = async (mode: "single" | "batch") => {
    if (!activeConnectionId || !activeTab) return;
    let sqlText = activeTab.sql;
    const ed = monacoEditorRef.current;
    if (ed) {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (model && sel && !sel.isEmpty()) {
        sqlText = model.getValueInRange(sel);
      }
    }
    const trimmed = (sqlText || "").trim();
    if (!trimmed) return;
    try {
      const r = await api.executeSQL({
        connectionId: activeConnectionId,
        database: selectedDatabase,
        sql: trimmed,
        mode,
        rowLimit: 50000,
        timeoutMs: 30000,
      });
      pushSqlHistory(trimmed);
      setHistoryRev((n) => n + 1);
      upsertDatabaseTabs(selectedDatabase, (list) =>
        list.map((t) => (t.id === activeTab.id ? { ...t, result: r, error: "" } : t))
      );
      setError("");
    } catch (e) {
      upsertDatabaseTabs(selectedDatabase, (list) =>
        list.map((t) => (t.id === activeTab.id ? { ...t, error: String(e), result: null } : t))
      );
      setError(String(e));
    }
  };

  const addTab = () => {
    if (!activeConnectionId || !selectedDatabase) return;
    const id = crypto.randomUUID();
    upsertDatabaseTabs(selectedDatabase, (list) => [
      ...list,
      {
        ...createSqlTab(list.filter((t) => t.type === "sql").length + 1, activeConnectionId, selectedDatabase),
        id,
      },
    ]);
    setActiveForDatabase(selectedDatabase, id);
  };

  const removeTab = (tabId: string) => {
    if (!activeConnectionId || !selectedDatabase) return;
    const key = `${activeConnectionId}::${selectedDatabase || "__none__"}`;
    const current = visibleTabs;
    const idx = current.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const next = current.filter((t) => t.id !== tabId);
    const fallback = next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? "";
    setTabsByDatabase((prev) => {
      return { ...prev, [key]: next };
    });
    setActiveTabByDatabase((prev) => ({ ...prev, [key]: fallback }));
  };

  const historyEntries = useMemo(() => readSqlHistory(), [historyRev]);

  const useHistorySql = (sql: string) => {
    setTabSQL(sql);
    setHistoryOpen(false);
  };

  const runMigration = async () => {
    if (!sourceConnectionId || !targetConnectionId || !sourceDatabase || !targetDatabase) {
      setMigrationMsg("请完整选择源连接、目标连接、源数据库和目标数据库");
      return;
    }
    if (selectedSourceTables.length === 0) {
      setMigrationMsg("请至少选择一个要迁移的源表");
      return;
    }
    setMigrationBusy(true);
    setMigrationMsg("");
    try {
      let successCount = 0;
      const failed: string[] = [];
      for (const tableName of selectedSourceTables) {
        try {
          await api.migrateTableData({
            sourceConnectionId: sourceConnectionId,
            sourceDatabase,
            sourceSchema: "",
            sourceTable: tableName,
            targetConnectionId: targetConnectionId,
            targetDatabase,
            targetSchema: "",
            targetTable: tableName,
            truncateTarget,
          });
          successCount += 1;
        } catch (e) {
          failed.push(`${tableName}: ${String(e)}`);
        }
      }
      const summary = `迁移完成：成功 ${successCount}/${selectedSourceTables.length} 个表`;
      setMigrationMsg(failed.length > 0 ? `${summary}\n失败:\n${failed.join("\n")}` : summary);
    } catch (e) {
      setMigrationMsg(String(e));
    } finally {
      setMigrationBusy(false);
    }
  };

  const toggleSourceTable = (tableName: string) => {
    setSelectedSourceTables((prev) =>
      prev.includes(tableName) ? prev.filter((t) => t !== tableName) : [...prev, tableName]
    );
  };

  const toggleSelectAllSourceTables = () => {
    setSelectedSourceTables((prev) => (prev.length === sourceTables.length ? [] : [...sourceTables]));
  };

  useEffect(() => {
    runSQLRef.current = runSQL;
    addTabRef.current = addTab;
  }, [runSQL, addTab]);

  const explain = async () => {
    if (!activeConnectionId || !activeTab) return;
    try {
      const r = await api.explainSQL({ connectionId: activeConnectionId, database: selectedDatabase, sql: activeTab.sql });
      upsertDatabaseTabs(selectedDatabase, (list) =>
        list.map((t) => (t.id === activeTab.id ? { ...t, result: r, error: "" } : t))
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const openAiAssist = useCallback(() => {
    if (activeTab?.type !== "sql") return;
    const ed = monacoEditorRef.current;
    if (!ed) return;
    const pos = ed.getPosition();
    const dom = ed.getDomNode();
    const rect = dom?.getBoundingClientRect();
    if (!rect) return;
    let left = rect.left + 48;
    let top = rect.top + 80;
    if (pos) {
      const coords = ed.getScrolledVisiblePosition(pos);
      if (coords) {
        left = Math.min(Math.max(8, rect.left + coords.left), window.innerWidth - 372);
        top = Math.min(Math.max(8, rect.top + coords.top + coords.height + 6), window.innerHeight - 320);
      }
    }
    setAiAssistPos({ left, top });
    setAiAssistInput("");
    setAiAssistErr("");
    setAiAssistFeedback("");
    setAiAssistResult(null);
    setAiAssistOpen(true);
  }, [activeTab?.type]);

  const appendSqlToEditorEnd = useCallback(
    (sql: string) => {
      const ed = monacoEditorRef.current;
      const model = ed?.getModel();
      if (!ed || !model) return;
      const t = sql.trim();
      if (!t) return;
      const val = model.getValue();
      const needsNl = val.length > 0 && !/\n$/.test(val);
      const insert = (needsNl ? "\n\n" : "") + t;
      const endLine = model.getLineCount();
      const endCol = model.getLineMaxColumn(endLine);
      ed.executeEdits("ai-assist-append", [
        {
          range: {
            startLineNumber: endLine,
            startColumn: endCol,
            endLineNumber: endLine,
            endColumn: endCol,
          },
          text: insert,
        },
      ]);
      setTabSQL(model.getValue());
      ed.focus();
    },
    [setTabSQL],
  );

  const submitAiAssist = async () => {
    const text = aiAssistInput.trim();
    if (!text) return;
    const ed = monacoEditorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    const sel = ed.getSelection();
    let selectedText = "";
    if (model && sel && !sel.isEmpty()) {
      selectedText = model.getValueInRange(sel);
    }
    setAiAssistBusy(true);
    setAiAssistErr("");
    setAiAssistFeedback("");
    setAiAssistResult(null);
    try {
      const r = await api.assistSQL({
        dialect: sqlDialect,
        inputText: text,
        selectedText,
        databaseName: selectedDatabase,
        connectionId: activeConnectionId,
      });
      if (r) {
        const rec = {
          intent: r.intent ?? "",
          type: r.type ?? "",
          content: r.content ?? "",
          explanation: r.explanation,
          relevantTables: r.relevantTables,
          reason: r.reason,
        };
        setAiAssistResult(rec);
        const typ = (rec.type || "").toLowerCase();
        const body = rec.content?.trim() ?? "";
        if ((typ === "sql" || typ === "rewrite") && body) {
          appendSqlToEditorEnd(body);
          setAiAssistFeedback("已追加到编辑器末尾");
        } else {
          setAiAssistFeedback("");
        }
      }
    } catch (e) {
      setAiAssistErr(String(e));
    } finally {
      setAiAssistBusy(false);
    }
  };

  useEffect(() => {
    openAiAssistRef.current = openAiAssist;
  }, [openAiAssist]);

  useEffect(() => {
    if (!aiAssistOpen) return;
    const t = window.setTimeout(() => aiAssistInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [aiAssistOpen]);

  const onEditorMount = (editor: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
    monacoEditorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => runSQLRef.current("single"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ, () => addTabRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => openAiAssistRef.current());
    if (!completionDisposableRef.current) {
      completionDisposableRef.current = monaco.languages.registerCompletionItemProvider("sql", {
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const suggestions: languages.CompletionItem[] = completionWordsRef.current.map((kw) => ({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
          }));
          return { suggestions };
        },
      });
    }
  };

  useEffect(() => {
    return () => {
      monacoEditorRef.current = null;
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      if (drag.type === "sidebar") {
        const delta = e.clientX - drag.startX;
        const next = Math.min(Math.max(220, drag.startWidth + delta), Math.max(420, window.innerWidth - 360));
        setSidebarWidth(next);
      } else {
        const delta = e.clientY - drag.startY;
        const next = Math.min(Math.max(180, drag.startHeight + delta), 760);
        setEditorHeight(next);
      }
    };
    const onMouseUp = () => {
      dragStateRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { type: "sidebar", startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const startEditorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { type: "editor", startY: e.clientY, startHeight: editorHeight };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  return (
    <div className="app-shell light studio-layout">
      <aside className="sidebar" style={{ width: `${sidebarWidth}px` }}>
        <div className="sidebar-head">
          <h2 className="sidebar-main-title">数据库</h2>
          <div className="sidebar-head-actions">
            <div className="top-menu-wrap">
              <button className="btn ghost mini-menu-btn" onClick={() => setMenuOpen((v) => !v)}>☰ 菜单</button>
              {menuOpen && (
                <div className="top-menu-panel">
                  <button
                    className="top-menu-item"
                    onClick={() => {
                      setHistoryOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    历史执行 SQL
                  </button>
                  <button
                    className="top-menu-item"
                    onClick={() => {
                      setMigrationOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    数据迁移
                  </button>
                </div>
              )}
            </div>
            <p className="sub">当前环境：{currentGroupName}</p>
          </div>
        </div>
        <div className="sidebar-object-head">
          <h3>对象</h3>
          <button className="btn ghost sidebar-refresh-btn" onClick={() => void reloadDbTree()} disabled={!activeConnectionId}>
            ↻ 刷新
          </button>
        </div>
        <div className="sidebar-object-divider" />
        <label className="field-label">数据库连接</label>
        <select className="connection-select" value={activeConnectionId} onChange={(e) => setActiveConnectionId(e.target.value)}>
          <option value="">请选择连接</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.driver})
            </option>
          ))}
        </select>

        <div className="table-list-wrap">
          <div className="table-title">数据库对象树</div>
          <div className="table-list">
            {filteredTree.map((db) => {
              const expanded = db.forceExpanded || db.expanded;
              return (
                <div key={db.name} className="tree-db-block">
                  <div className={`tree-db-row ${selectedDatabase === db.name ? "active" : ""}`}>
                    <button className="tree-toggle" onClick={() => toggleDatabaseExpand(db.name)}>
                      {expanded ? "▾" : "▸"}
                    </button>
                    <button className="tree-db-name" onClick={() => selectDatabase(db.name)}>
                      {db.name}
                    </button>
                  </div>
                  {expanded && (
                    <div className="tree-table-group">
                      {db.visibleTables.length === 0 && (
                        <div className="tree-empty">暂无表</div>
                      )}
                      {db.visibleTables.map((tableName) => (
                        <button
                          key={`${db.name}.${tableName}`}
                          className="tree-table-item"
                          onClick={() => appendSelectSQL(db.name, tableName)}
                        >
                          {tableName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="sidebar-filter">
          <label className="field-label">搜索过滤</label>
          <input
            value={tableFilter}
            onChange={(e) => setTableFilter(e.target.value)}
            placeholder="输入数据库或表名过滤"
          />
        </div>
      </aside>
      <div className="pane-splitter vertical" onMouseDown={startSidebarResize} />

      <section className="studio-main">
        <header className="topbar">
          <div className="studio-title-wrap">
            <div>
            <h1>数据库控制台</h1>
            <p className="sub">{selectedDatabase ? `数据库：${selectedDatabase}` : "请选择数据库开始"} · Ctrl+L AI 助手</p>
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => runSQL("single")}>执行</button>
            <button className="btn" onClick={() => runSQL("batch")}>批量执行</button>
            <button className="btn ghost" onClick={explain}>执行计划</button>
            <button className="btn ghost" onClick={addTab}>新增标签</button>
          </div>
        </header>

        <div className="tab-strip">
          {visibleTabs.map((t) => (
            <button key={t.id} className={`tab ${t.id === activeTab?.id ? "active" : ""}`} onClick={() => setActiveForDatabase(selectedDatabase, t.id)}>
              <span>{t.type === "table" ? `表: ${t.title}` : t.title}</span>
              <span
                className="tab-close"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(t.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>

        {activeTab?.type === "sql" && (
          <div
            className="editor-wrap studio-editor-pane"
            style={showSqlResultPane ? { height: `${editorHeight}px` } : { flex: 1, minHeight: 0 }}
          >
            <Editor
              height="100%"
              language="sql"
              value={activeTab?.sql ?? ""}
              onChange={(v) => setTabSQL(v ?? "")}
              onMount={onEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                wordWrap: "on",
                automaticLayout: true,
                suggestOnTriggerCharacters: true,
              }}
            />
          </div>
        )}

        {showSqlResultPane && (
          <>
            <div className="pane-splitter horizontal" onMouseDown={startEditorResize} />
            <section className="panel result-panel">
              <h2>执行结果</h2>
              {(activeTabError || error) && <p className="message error">{activeTabError || error}</p>}
              {activeTabResult && (
                <>
                  <p className="sub">{activeTabResult.message}（{activeTabResult.durationMs}ms）</p>
                  {activeTabResult.execLog && activeTabResult.execLog.length > 0 && (
                    <pre className="log">{activeTabResult.execLog.join("\n")}</pre>
                  )}
                  {activeTabResult.rows && activeTabResult.rows.length > 0 && (
                    <div className="result-content">
                      <VirtualResultGrid
                        columns={activeTabResult.columns ?? Object.keys(activeTabResult.rows[0] ?? {})}
                        rows={activeTabResult.rows as Array<Record<string, unknown>>}
                        onCopyError={(msg) => setError(msg)}
                      />
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {activeTab?.type === "table" && (
          <section className="panel result-panel">
            <h2>表数据</h2>
            {(activeTabError || error) && <p className="message error">{activeTabError || error}</p>}
            {activeTabResult && (
              <>
                <p className="sub">{activeTabResult.message}（{activeTabResult.durationMs}ms）</p>
                {activeTabResult.execLog && activeTabResult.execLog.length > 0 && (
                  <pre className="log">{activeTabResult.execLog.join("\n")}</pre>
                )}
                {activeTabResult.rows && activeTabResult.rows.length > 0 && (
                  <div className="result-content">
                    <VirtualResultGrid
                      columns={activeTabResult.columns ?? Object.keys(activeTabResult.rows[0] ?? {})}
                      rows={activeTabResult.rows as Array<Record<string, unknown>>}
                      onCopyError={(msg) => setError(msg)}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {historyOpen && (
          <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
            <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>历史执行 SQL</h3>
                <button className="btn ghost" onClick={() => setHistoryOpen(false)}>关闭</button>
              </div>
              <div className="history-list">
                {historyEntries.length === 0 ? (
                  <p className="sub">暂无历史记录</p>
                ) : (
                  historyEntries.map((item) => (
                    <button key={item.id} className="history-item" onClick={() => useHistorySql(item.sql)}>
                      <span className="sub">{new Date(item.at).toLocaleString()}</span>
                      <pre>{item.sql.length > 500 ? `${item.sql.slice(0, 500)}...` : item.sql}</pre>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {aiAssistOpen && aiAssistPos && (
          <>
            <div
              className="ai-assist-backdrop"
              role="presentation"
              onMouseDown={() => {
                setAiAssistOpen(false);
                setAiAssistPos(null);
              }}
            />
            <div
              className="ai-assist-popover"
              style={{ left: `${aiAssistPos.left}px`, top: `${aiAssistPos.top}px` }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="ai-assist-top">
                <textarea
                  ref={aiAssistInputRef}
                  className="ai-assist-input"
                  rows={2}
                  placeholder="编辑所选 SQL 或描述需求"
                  value={aiAssistInput}
                  onChange={(e) => setAiAssistInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void submitAiAssist();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ai-assist-close"
                  aria-label="关闭"
                  onClick={() => {
                    setAiAssistOpen(false);
                    setAiAssistPos(null);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="ai-assist-toolbar">
                <span className="ai-assist-toolbar-left">SQL 助手</span>
                <span className="ai-assist-toolbar-mid">选中内容</span>
                <button
                  type="button"
                  className="ai-assist-submit"
                  disabled={aiAssistBusy || !aiAssistInput.trim()}
                  title="发送 (Ctrl+Enter)"
                  onClick={() => void submitAiAssist()}
                >
                  {aiAssistBusy ? "…" : "↑"}
                </button>
              </div>
              {aiAssistErr ? <p className="ai-assist-err">{aiAssistErr}</p> : null}
              {aiAssistFeedback ? <p className="ai-assist-feedback">{aiAssistFeedback}</p> : null}
              {aiAssistResult && (aiAssistResult.type || "").toLowerCase() === "explanation" ? (
                <pre className="ai-assist-explain">{aiAssistResult.content}</pre>
              ) : null}
              {aiAssistResult &&
              (aiAssistResult.explanation || "").trim() !== "" &&
              (aiAssistResult.type || "").toLowerCase() !== "explanation" ? (
                <p className="ai-assist-explain-note">{aiAssistResult.explanation}</p>
              ) : null}
            </div>
          </>
        )}

        {migrationOpen && (
          <div className="modal-mask" onClick={() => setMigrationOpen(false)}>
            <div className="modal-panel large" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>数据迁移</h3>
                <button className="btn ghost" onClick={() => setMigrationOpen(false)}>关闭</button>
              </div>
              <div className="migration-grid">
                <div className="panel-lite">
                  <h4>源</h4>
                  <label>源分组</label>
                  <select value={sourceGroupId} onChange={(e) => setSourceGroupId(e.target.value)}>
                    <option value="">请选择分组</option>
                    {allGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <label>源连接</label>
                  <select value={sourceConnectionId} onChange={(e) => setSourceConnectionId(e.target.value)}>
                    <option value="">请选择连接</option>
                    {sourceGroupConnections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <label>源数据库</label>
                  <select value={sourceDatabase} onChange={(e) => setSourceDatabase(e.target.value)} disabled={!sourceConnectionId}>
                    <option value="">请选择数据库</option>
                    {sourceDatabases.map((db) => <option key={db} value={db}>{db}</option>)}
                  </select>
                  <div className="table-picker-tools">
                    <label>源表（可多选）</label>
                    <button className="btn ghost" type="button" onClick={toggleSelectAllSourceTables} disabled={sourceTables.length === 0}>
                      {selectedSourceTables.length === sourceTables.length && sourceTables.length > 0 ? "取消全选" : "全选"}
                    </button>
                  </div>
                  <div className="table-picker-list">
                    {sourceTables.length === 0 ? (
                      <p className="sub">请选择数据库后加载表</p>
                    ) : (
                      sourceTables.map((tableName) => (
                        <label key={tableName} className="table-picker-item">
                          <input
                            type="checkbox"
                            checked={selectedSourceTables.includes(tableName)}
                            onChange={() => toggleSourceTable(tableName)}
                          />
                          <span>{tableName}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
                <div className="panel-lite">
                  <h4>目标</h4>
                  <label>目标分组</label>
                  <select value={targetGroupId} onChange={(e) => setTargetGroupId(e.target.value)}>
                    <option value="">请选择分组</option>
                    {allGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <label>目标连接</label>
                  <select value={targetConnectionId} onChange={(e) => setTargetConnectionId(e.target.value)}>
                    <option value="">请选择连接</option>
                    {targetGroupConnections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <label>目标数据库</label>
                  <select value={targetDatabase} onChange={(e) => setTargetDatabase(e.target.value)} disabled={!targetConnectionId}>
                    <option value="">请选择数据库</option>
                    {targetDatabases.map((db) => <option key={db} value={db}>{db}</option>)}
                  </select>
                  <label>目标库表（只读预览）</label>
                  <div className="table-picker-list">
                    {targetTables.length === 0 ? (
                      <p className="sub">请选择数据库后加载表</p>
                    ) : (
                      targetTables.map((tableName) => (
                        <div key={tableName} className="table-picker-item view">
                          <span>{tableName}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <label className="row"><input type="checkbox" checked={truncateTarget} onChange={(e) => setTruncateTarget(e.target.checked)} />迁移前清空目标表</label>
                </div>
              </div>
              <div className="row">
                <button className="btn" onClick={runMigration} disabled={migrationBusy || selectedSourceTables.length === 0}>{migrationBusy ? "迁移中..." : "开始迁移"}</button>
                <span className="sub">已选择 {selectedSourceTables.length} 个源表，默认同名迁移到目标库</span>
                {migrationMsg && <span className="sub">{migrationMsg}</span>}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function VirtualResultGrid({
  columns,
  rows,
  onCopyError,
}: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  onCopyError: (msg: string) => void;
}) {
  const PAGE_SIZE = 10000;
  const [page, setPage] = useState(1);
  const [gridSize, setGridSize] = useState({ width: 900, height: 360 });
  const [ctxMenu, setCtxMenu] = useState<{ left: number; top: number } | null>(null);
  const gridHostRef = useRef<HTMLDivElement | null>(null);
  const dataEditorRef = useRef<DataEditorRef>(null);
  const lastContextClientPosRef = useRef<{ x: number; y: number } | null>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, rows.length);
  const pageRows = rows.slice(pageStart, pageEnd);
  const rowCount = pageRows.length;

  useEffect(() => {
    setPage(1);
  }, [rows, columns.join("|")]);

  useEffect(() => {
    const el = gridHostRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      setGridSize({
        width: Math.max(240, Math.floor(w)),
        height: Math.max(220, Math.floor(h)),
      });
    };
    apply(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      apply(rect.width, rect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [safePage, rowCount]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const id = window.setTimeout(() => {
      document.addEventListener("click", close);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", close);
    };
  }, [ctxMenu]);

  const gridColumns: GridColumn[] = useMemo(
    () => columns.map((name) => ({ title: name, id: name, width: 180 })),
    [columns]
  );

  const getCellContent = useMemo(() => {
    return ([col, row]: Item): GridCell => {
      const colName = columns[col];
      const value = colName ? String(pageRows[row]?.[colName] ?? "") : "";
      return {
        kind: GridCellKind.Text,
        allowOverlay: false,
        readonly: true,
        displayData: value,
        data: value,
      };
    };
  }, [columns, pageRows]);

  const copySelection = async () => {
    try {
      await dataEditorRef.current?.emit("copy");
    } catch (e) {
      onCopyError(`复制失败: ${String(e)}`);
    }
  };

  return (
    <div className="result-grid-root">
      <div
        ref={gridHostRef}
        className="result-grid-host"
        onContextMenuCapture={(e) => {
          lastContextClientPosRef.current = { x: e.clientX, y: e.clientY };
        }}
      >
        <DataEditor
          ref={dataEditorRef}
          key={`grid-${safePage}-${columns.join("|")}`}
          theme={gridTheme}
          columns={gridColumns}
          rows={rowCount}
          getCellContent={getCellContent}
          getCellsForSelection={true}
          width={gridSize.width}
          height={gridSize.height}
          rowHeight={GRID_ROW_HEIGHT}
          headerHeight={GRID_HEADER_HEIGHT}
          rowMarkers={{ kind: "number", width: ROW_MARKER_WIDTH, startIndex: pageStart + 1 }}
          rowSelectionMode="multi"
          smoothScrollX
          smoothScrollY
          onCellContextMenu={(_cell, event) => {
            event.preventDefault();
            const pos = lastContextClientPosRef.current;
            if (pos) {
              setCtxMenu({ left: pos.x, top: pos.y });
              return;
            }
            const host = gridHostRef.current;
            if (!host) return;
            const rect = host.getBoundingClientRect();
            setCtxMenu({ left: rect.left + event.localEventX, top: rect.top + event.localEventY });
          }}
        />
      </div>
      {rows.length > PAGE_SIZE && (
        <div className="result-pager">
          <button className="btn ghost" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
          <span>第 {safePage} / {totalPages} 页（每页 {PAGE_SIZE} 条）</span>
          <button className="btn ghost" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
        </div>
      )}
      {ctxMenu ? (
        <div
          className="context-menu"
          style={{ left: `${ctxMenu.left}px`, top: `${ctxMenu.top}px` }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => { void copySelection(); setCtxMenu(null); }}>
            复制
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default App;

