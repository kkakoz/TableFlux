import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IDisposable, languages } from "monaco-editor";
import { api } from "./api";
import type {
  ConnectionMeta,
  ExecuteSQLResult,
  StudioTabSnapshot,
  WorkspaceGroup,
} from "./types";

type ViewMode = "main" | "studio";
type DbTreeNode = {
  name: string;
  expanded: boolean;
  loaded: boolean;
  tables: string[];
};

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
    </div>
  );
}

function StudioView({ groupId }: { groupId: string }) {
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState("");
  const [dbTree, setDbTree] = useState<DbTreeNode[]>([]);
  const [selectedDatabase, setSelectedDatabase] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  const [tabs, setTabs] = useState<StudioTabSnapshot[]>([{ id: crypto.randomUUID(), title: "SQL 1", sql: "", connectionId: "", contextDb: "", contextTable: "" }]);
  const [activeTabId, setActiveTabId] = useState("");
  const [result, setResult] = useState<ExecuteSQLResult | null>(null);
  const [error, setError] = useState("");
  const [selectedCell, setSelectedCell] = useState<{ rowIndex: number; column: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; value: string } | null>(null);

  const completionWordsRef = useRef<string[]>([...SQL_KEYWORDS]);
  const completionDisposableRef = useRef<IDisposable | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const saveSession = async (nextTabs: StudioTabSnapshot[], nextConn: string) => {
    try {
      await api.saveStudioSession({
        groupId,
        activeConnectionId: nextConn,
        tabs: nextTabs,
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

      const session = await api.getStudioSession(groupId);
      const initialConn = session?.activeConnectionId || connList[0]?.id || "";
      if (session?.tabs?.length > 0) {
        setTabs(session.tabs);
        setActiveTabId(session.tabs[0].id);
      } else {
        setActiveTabId((t) => t || tabs[0].id);
      }
      setActiveConnectionId(initialConn);
    })().catch((e) => setError(String(e)));
  }, [groupId]);

  useEffect(() => {
    if (!activeConnectionId || tabs.length === 0) return;
    saveSession(tabs, activeConnectionId);
  }, [tabs, activeConnectionId]);

  useEffect(() => {
    if (!activeConnectionId) {
      setDbTree([]);
      setSelectedDatabase("");
      return;
    }
    (async () => {
      try {
        const dbs = await api.listDatabases(activeConnectionId);
        const names = dbs.map((d: any) => d.name);
        const conn = connections.find((c) => c.id === activeConnectionId);
        const nextDB = conn?.defaultDb && names.includes(conn.defaultDb) ? conn.defaultDb : (names[0] || "");
        setDbTree(
          names.map((name) => ({
            name,
            expanded: name === nextDB,
            loaded: false,
            tables: [],
          }))
        );
        setSelectedDatabase(nextDB);
      } catch (e) {
        setError(String(e));
      }
    })();
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

  const appendSelectSQL = (dbName: string, tableName: string) => {
    setSelectedDatabase(dbName);
    setTabSQL(`${activeTab?.sql || ""}\nSELECT * FROM ${tableName} LIMIT 100;`);
  };

  useEffect(() => {
    if (tableFilter.trim() === "") return;
    const unloaded = dbTree.filter((db) => !db.loaded).map((db) => db.name);
    unloaded.forEach((dbName) => {
      loadTablesForDB(dbName).catch((e) => setError(String(e)));
    });
  }, [tableFilter, dbTree]);

  const setTabSQL = (sql: string) => {
    const next = tabs.map((t) => (t.id === activeTab.id ? { ...t, sql, connectionId: activeConnectionId, contextDb: selectedDatabase } : t));
    setTabs(next);
  };

  const runSQL = async (mode: "single" | "batch") => {
    if (!activeConnectionId || !activeTab) return;
    try {
      const r = await api.executeSQL({
        connectionId: activeConnectionId,
        database: selectedDatabase,
        sql: activeTab.sql,
        mode,
        rowLimit: 2000,
        timeoutMs: 30000,
      });
      setResult(r);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const addTab = () => {
    const id = crypto.randomUUID();
    const next = [...tabs, { id, title: `SQL ${tabs.length + 1}`, sql: "", connectionId: activeConnectionId, contextDb: selectedDatabase, contextTable: "" }];
    setTabs(next);
    setActiveTabId(id);
  };

  const explain = async () => {
    if (!activeConnectionId || !activeTab) return;
    try {
      const r = await api.explainSQL({ connectionId: activeConnectionId, database: selectedDatabase, sql: activeTab.sql });
      setResult(r);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const onEditorMount = (_editor: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
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
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = null;
    };
  }, []);

  useEffect(() => {
    const hideMenu = () => setContextMenu(null);
    window.addEventListener("click", hideMenu);
    return () => window.removeEventListener("click", hideMenu);
  }, []);

  const copyText = async (value: string) => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
    } catch (e) {
      setError(`复制失败: ${String(e)}`);
    }
  };

  return (
    <div className="app-shell light studio-layout">
      <aside className="sidebar">
        <h2>连接与表</h2>
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

      <section className="studio-main">
        <header className="topbar">
          <div>
            <h1>SQL 工作台</h1>
            <p className="sub">分组：{groupId} {selectedDatabase ? `｜数据库：${selectedDatabase}` : ""}</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => runSQL("single")}>执行</button>
            <button className="btn" onClick={() => runSQL("batch")}>批量执行</button>
            <button className="btn ghost" onClick={explain}>执行计划</button>
            <button className="btn ghost" onClick={addTab}>新增标签</button>
          </div>
        </header>

        <div className="tab-strip">
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${t.id === activeTab?.id ? "active" : ""}`} onClick={() => setActiveTabId(t.id)}>
              {t.title}
            </button>
          ))}
        </div>

        <div className="editor-wrap">
          <Editor
            height="360px"
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

        <section className="panel result-panel">
          <h2>执行结果</h2>
          {error && <p className="message error">{error}</p>}
          {result && (
            <>
              <p className="sub">{result.message}（{result.durationMs}ms）</p>
              {result.execLog && result.execLog.length > 0 && (
                <pre className="log">{result.execLog.join("\n")}</pre>
              )}
              {result.rows && result.rows.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>{(result.columns ?? Object.keys(result.rows[0] ?? {})).map((c) => <th key={c}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 100).map((row, i) => (
                        <tr key={i}>
                          {(result.columns ?? Object.keys(row)).map((c) => (
                            <td
                              key={c}
                              className={selectedCell?.rowIndex === i && selectedCell?.column === c ? "cell-selected" : ""}
                              onClick={() => setSelectedCell({ rowIndex: i, column: c })}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                const value = String(row[c] ?? "");
                                setSelectedCell({ rowIndex: i, column: c });
                                setContextMenu({ x: e.clientX, y: e.clientY, value });
                              }}
                            >
                              {String(row[c] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-item"
              onClick={() => {
                copyText(contextMenu.value);
                setContextMenu(null);
              }}
            >
              复制
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
