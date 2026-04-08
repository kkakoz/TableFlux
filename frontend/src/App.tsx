import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DataEditor,
  GridCellKind,
  GridColumnMenuIcon,
  getDefaultTheme,
  type DataEditorRef,
  type GridColumn,
  type Item,
  type GridCell,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { editor as MonacoEditorNS, IDisposable, IRange, languages } from "monaco-editor";
import {
  ChevronRight,
  Database,
  History,
  House,
  Menu,
  Play,
  RefreshCw,
  Settings2,
  SquareCode,
  Table2,
  X,
} from "lucide-react";
import { api } from "./api";
import type {
  ConnectionMeta,
  ExecuteSQLResult,
  TableSchema,
  WorkspaceGroup,
} from "./types";
import SettingsPanel from "./components/SettingsPanel";
import ConnectionManager from "./components/connection-manager/ConnectionManager";
import DatabaseVisibilityModal from "./components/studio/DatabaseVisibilityModal";
import { formatCellForTimezone, readDisplayTimezone } from "./components/studio/timezoneDisplay";
import { TableQueryRequest } from "../bindings/changeme";
import SqlEditorWithGutter from "./components/studio/SqlEditorWithGutter";
import SqlHistoryModal from "./components/studio/SqlHistoryModal";
import { pushSqlHistory, readSqlHistory } from "./utils/sqlHistory";
import { findStatementAtLine, parseSqlStatements, splitStatementsBySemicolon } from "./utils/sqlStatements";
import {
  extractQualifierBeforeDot,
  mergeDotCompletionItems,
  resolveTableSchemaRequest,
} from "./utils/sqlDotCompletion";
import { isExpandableLongTextColumnType } from "./utils/gridColumnTypes";

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
  /** 最近一次执行/解释所用的 SQL（用于底部状态栏展示） */
  lastExecutedSql: string;
  connectionId: string;
  contextDb: string;
  contextTable: string;
  result: ExecuteSQLResult | null;
  error: string;
  /** 表标签页：SELECT COUNT(*) 总行数 */
  tableTotal?: number;
  /** 当前页 offset */
  tableOffset?: number;
  /** 当前页 limit（与设置 queryLimit 一致） */
  tablePageLimit?: number;
  tableSortColumn?: string;
  tableSortDesc?: boolean;
};

const createSqlTab = (index: number, connectionId: string, database: string): WorkbenchTab => ({
  id: crypto.randomUUID(),
  title: `查询 ${index}`,
  type: "sql",
  sql: "",
  lastExecutedSql: "",
  connectionId,
  contextDb: database,
  contextTable: "",
  result: null,
  error: "",
});

/** 为表名/列名加引号，避免保留字（如 order、user）导致语法错误 */
function quoteSqlIdentifier(name: string, dialect: "mysql" | "postgres"): string {
  if (dialect === "postgres") {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

function queryResultPageToExecuteSQLResult(page: {
  columns: string[];
  columnTypes?: string[];
  rows: Array<Record<string, unknown>>;
  durationMs: number;
}): ExecuteSQLResult {
  return {
    columns: page.columns,
    columnTypes: page.columnTypes,
    rows: page.rows,
    rowsAffected: 0,
    lastInsertId: 0,
    message: `表数据（本页 ${page.rows.length} 行）`,
    truncated: false,
    durationMs: Number(page.durationMs) || 0,
  };
}

function buildTableBrowseSqlDisplay(
  tableName: string,
  dialect: "mysql" | "postgres",
  orderBy: string,
  orderDesc: boolean,
  limit: number,
  offset: number,
): string {
  const t = quoteSqlIdentifier(tableName, dialect);
  let order = "";
  if (orderBy.trim()) {
    const c = quoteSqlIdentifier(orderBy, dialect);
    order = ` ORDER BY ${c} ${orderDesc ? "DESC" : "ASC"}`;
  }
  return `SELECT * FROM ${t}${order} LIMIT ${limit} OFFSET ${offset}`;
}

/** 与设置面板 `localStorage.settings` 及后端 GetSettings 对齐；优先本地（保存后立即生效） */
async function resolveQueryLimit(): Promise<number> {
  try {
    const raw = localStorage.getItem("settings");
    if (raw) {
      const parsed = JSON.parse(raw) as { queryLimit?: number };
      if (typeof parsed.queryLimit === "number" && parsed.queryLimit >= 100) {
        return parsed.queryLimit;
      }
    }
  } catch {
    /* ignore */
  }
  const s = await api.getSettings();
  return Math.max(100, s.queryLimit || 5000);
}

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
  baseFontStyle: "12px",
  headerFontStyle: "600 12px",
  editorFontSize: "12px",
  markerFontStyle: "10px",
  lineHeight: 1.4,
  cellVerticalPadding: 2,
  cellHorizontalPadding: 6,
  headerIconSize: 15,
};

const GRID_ROW_HEIGHT = 28;
const GRID_HEADER_HEIGHT = 30;
/** 结果表 NULL 占位（与 slate-400 接近，区别于正文） */
const GRID_NULL_TEXT = "#94a3b8";
const ROW_MARKER_WIDTH = 42;

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const studioGroupId = params.get("groupId") ?? "";
  const mode: ViewMode = params.get("studio") === "1" ? "studio" : "main";

  if (mode === "studio") {
    return <StudioView groupId={studioGroupId} />;
  }
  return <ConnectionManager />;
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
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [editorHeight, setEditorHeight] = useState(340);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workbenchSubmenuOpen, setWorkbenchSubmenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dbVisibilityOpen, setDbVisibilityOpen] = useState(false);
  /** null：尚未从本地恢复，对象树暂显示全部库 */
  const [visibleDbSet, setVisibleDbSet] = useState<Set<string> | null>(null);
  const [displayTimezone, setDisplayTimezone] = useState(() => readDisplayTimezone());

  const completionWordsRef = useRef<string[]>([...SQL_KEYWORDS]);
  const completionContextRef = useRef<{
    connectionId: string;
    database: string;
    dialect: "mysql" | "postgres";
  }>({ connectionId: "", database: "", dialect: "mysql" });
  const tableSchemaCacheRef = useRef<Map<string, TableSchema>>(new Map());
  const completionDisposableRef = useRef<IDisposable | null>(null);
  const monacoEditorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const runSQLSingleAtCursorRef = useRef<() => void>(() => {});
  const addTabRef = useRef<() => void>(() => {});
  const openAiAssistRef = useRef<() => void>(() => {});
  const aiAssistInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragStateRef = useRef<
    | { type: "sidebar"; startX: number; startWidth: number }
    | { type: "editor"; startY: number; startHeight: number }
    | null
  >(null);
  /** 仅用于「库名列表变化」时合并新库进可见集；勿随 dbTree 引用变化而重置（展开/收起会改 dbTree） */
  const visibleDbNamesKeyRef = useRef<string>("");
  const visibleDbSyncConnIdRef = useRef<string | null>(null);

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

  const runTablePageQuery = useCallback(
    async (
      tabId: string,
      dbName: string,
      tableName: string,
      opts: { offset: number; orderBy: string; orderDesc: boolean },
    ) => {
      if (!activeConnectionId) return;
      const key = `${activeConnectionId}::${dbName || "__none__"}`;
      try {
        const limit = await resolveQueryLimit();
        const page = await api.queryTablePage(
          new TableQueryRequest({
            connectionId: activeConnectionId,
            database: dbName,
            schema: "",
            table: tableName,
            offset: opts.offset,
            limit,
            orderBy: opts.orderBy,
            orderDesc: opts.orderDesc,
          }),
        );
        const result = queryResultPageToExecuteSQLResult(page);
        const lastSql = buildTableBrowseSqlDisplay(
          tableName,
          sqlDialect,
          opts.orderBy,
          opts.orderDesc,
          page.limit,
          opts.offset,
        );
        setTabsByDatabase((prev) => {
          const list = prev[key] ?? [];
          return {
            ...prev,
            [key]: list.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    result,
                    error: "",
                    lastExecutedSql: lastSql,
                    tableTotal: page.total,
                    tableOffset: page.offset,
                    tablePageLimit: page.limit,
                    tableSortColumn: opts.orderBy || undefined,
                    tableSortDesc: opts.orderDesc,
                  }
                : t,
            ),
          };
        });
      } catch (e) {
        setTabsByDatabase((prev) => {
          const list = prev[key] ?? [];
          return {
            ...prev,
            [key]: list.map((t) =>
              t.id === tabId ? { ...t, error: String(e), result: null } : t,
            ),
          };
        });
      }
    },
    [activeConnectionId, sqlDialect],
  );

  /** 会话恢复或切换回表标签页时 result 为空，自动拉取（新建表标签由本逻辑加载；对象树再次点击已存在表仍由 appendSelectSQL 显式刷新） */
  useEffect(() => {
    if (!activeConnectionId || !activeTab) return;
    if (activeTab.type !== "table" || !activeTab.contextTable) return;
    if (activeTab.connectionId && activeTab.connectionId !== activeConnectionId) return;
    if (activeTab.result !== null || activeTab.error) return;

    void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
      offset: activeTab.tableOffset ?? 0,
      orderBy: activeTab.tableSortColumn ?? "",
      orderDesc: activeTab.tableSortDesc ?? false,
    });
  }, [
    activeConnectionId,
    activeTab?.id,
    activeTab?.type,
    activeTab?.result,
    activeTab?.error,
    activeTab?.contextTable,
    activeTab?.contextDb,
    activeTab?.connectionId,
    runTablePageQuery,
  ]);

  const activeConnMeta = connections.find((c) => c.id === activeConnectionId);
  const currentGroupName = allGroups.find((g) => g.id === groupId)?.name || groupId;
  const otherWorkbenches = useMemo(() => allGroups.filter((g) => g.id !== groupId), [allGroups, groupId]);
  const allDbNames = useMemo(() => dbTree.map((d) => d.name), [dbTree]);
  const visibilitySetForModal = visibleDbSet ?? new Set(allDbNames);
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
    completionContextRef.current = {
      connectionId: activeConnectionId,
      database: selectedDatabase,
      dialect: sqlDialect,
    };
  }, [activeConnectionId, selectedDatabase, sqlDialect]);

  useEffect(() => {
    tableSchemaCacheRef.current.clear();
  }, [activeConnectionId, selectedDatabase]);

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
          lastExecutedSql: "",
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

  const dbNamesKey = useMemo(() => dbTree.map((d) => d.name).sort().join("|"), [dbTree]);

  useEffect(() => {
    const onTz = () => setDisplayTimezone(readDisplayTimezone());
    window.addEventListener("tableflux-timezone-change", onTz);
    return () => window.removeEventListener("tableflux-timezone-change", onTz);
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      setWorkbenchSubmenuOpen(false);
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!activeConnectionId) {
      setVisibleDbSet(null);
      visibleDbSyncConnIdRef.current = null;
      visibleDbNamesKeyRef.current = "";
      return;
    }
    if (!dbNamesKey) return;

    if (visibleDbSyncConnIdRef.current !== activeConnectionId) {
      visibleDbSyncConnIdRef.current = activeConnectionId;
      visibleDbNamesKeyRef.current = "";
    }

    const names = dbNamesKey.split("|").filter(Boolean);
    const nameSet = new Set(names);
    const storageKey = `tableflux.studio.visible_dbs:${activeConnectionId}`;
    const raw = localStorage.getItem(storageKey);
    const prevNamesKey = visibleDbNamesKeyRef.current;

    if (!raw) {
      const all = new Set(names);
      setVisibleDbSet(all);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...all]));
      } catch {
        /* ignore */
      }
      visibleDbNamesKeyRef.current = dbNamesKey;
      return;
    }
    try {
      const arr = JSON.parse(raw) as string[];
      const next = new Set<string>();
      for (const n of arr) {
        if (nameSet.has(n)) next.add(n);
      }
      if (prevNamesKey && prevNamesKey !== dbNamesKey) {
        const prevNames = new Set(prevNamesKey.split("|").filter(Boolean));
        for (const n of names) {
          if (!prevNames.has(n)) next.add(n);
        }
      }
      visibleDbNamesKeyRef.current = dbNamesKey;
      setVisibleDbSet(next);
    } catch {
      setVisibleDbSet(new Set(names));
      visibleDbNamesKeyRef.current = dbNamesKey;
    }
  }, [activeConnectionId, dbNamesKey]);

  const baseObjectTree = useMemo(() => {
    if (visibleDbSet === null) return dbTree;
    return dbTree.filter((d) => visibleDbSet.has(d.name));
  }, [dbTree, visibleDbSet]);

  const persistVisibleDbs = (next: Set<string>) => {
    if (!activeConnectionId) return;
    const key = `tableflux.studio.visible_dbs:${activeConnectionId}`;
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
    setVisibleDbSet(new Set(next));
    setDbVisibilityOpen(false);
    visibleDbNamesKeyRef.current = dbNamesKey;
  };

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
    const target = dbTree.find((d) => d.name === dbName);
    const willExpand = target ? !target.expanded : true;
    let shouldLoad = false;
    setDbTree((prev) =>
      prev.map((d) => {
        if (d.name !== dbName) return d;
        const nextExpanded = !d.expanded;
        if (nextExpanded && !d.loaded) shouldLoad = true;
        return { ...d, expanded: nextExpanded };
      })
    );
    if (willExpand) {
      setSelectedDatabase(dbName);
    }
    if (shouldLoad) {
      await loadTablesForDB(dbName);
    }
  };

  const filteredTree = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) {
      return baseObjectTree.map((d) => ({ ...d, visibleTables: d.tables })).filter(Boolean);
    }
    return baseObjectTree.map((d) => {
      const visibleTables = d.expanded ? d.tables.filter((t) => t.toLowerCase().includes(q)) : d.tables;
      return { ...d, visibleTables };
    });
  }, [baseObjectTree, tableFilter]);

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

  const refreshActiveTableTab = useCallback(() => {
    if (!activeTab || activeTab.type !== "table" || !activeTab.contextTable) return;
    void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
      offset: activeTab.tableOffset ?? 0,
      orderBy: activeTab.tableSortColumn ?? "",
      orderDesc: activeTab.tableSortDesc ?? false,
    });
  }, [activeTab, runTablePageQuery]);

  const appendSelectSQL = (dbName: string, tableName: string) => {
    if (!activeConnectionId) return;
    setSelectedDatabase(dbName);
    const key = `${activeConnectionId}::${dbName || "__none__"}`;
    const existed = tabsByDatabase[key]?.find((t) => t.type === "table" && t.contextTable === tableName);
    const tableTabId = existed?.id ?? crypto.randomUUID();
    const tableSqlRef = quoteSqlIdentifier(tableName, sqlDialect);
    const selectSql = `SELECT * FROM ${tableSqlRef};`;
    if (existed) {
      setActiveForDatabase(dbName, tableTabId);
      void runTablePageQuery(tableTabId, dbName, tableName, { offset: 0, orderBy: "", orderDesc: false });
      return;
    }
    setTabsByDatabase((prev) => {
      const current = prev[key] ?? [createSqlTab(1, activeConnectionId, dbName)];
      const tableTab: WorkbenchTab = {
        id: tableTabId,
        title: tableName,
        type: "table",
        sql: selectSql,
        lastExecutedSql: "",
        connectionId: activeConnectionId,
        contextDb: dbName,
        contextTable: tableName,
        result: null,
        error: "",
      };
      return { ...prev, [key]: [...current, tableTab] };
    });
    setActiveForDatabase(dbName, tableTabId);
  };

  useEffect(() => {
    if (tableFilter.trim() === "") return;
    const unloaded = dbTree.filter((db) => !db.loaded).map((db) => db.name);
    unloaded.forEach((dbName) => {
      loadTablesForDB(dbName).catch((e) => setError(String(e)));
    });
  }, [tableFilter, dbTree]);

  const executeSqlForActiveTab = async (sql: string, mode: "single" | "batch") => {
    if (!activeConnectionId || !activeTab) return;
    const trimmed = (sql || "").trim();
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
        list.map((t) => (t.id === activeTab.id ? { ...t, result: r, error: "", lastExecutedSql: trimmed } : t))
      );
      setError("");
    } catch (e) {
      upsertDatabaseTabs(selectedDatabase, (list) =>
        list.map((t) => (t.id === activeTab.id ? { ...t, error: String(e), result: null, lastExecutedSql: trimmed } : t))
      );
      setError(String(e));
    }
  };

  /** 工具栏执行：选中优先，否则全文；多语句（按分号）走批量，仅展示执行摘要；单条则展示结果表。 */
  const runUnifiedSQL = async () => {
    if (!activeConnectionId || !activeTab) return;
    let sqlText = activeTab.sql;
    const ed = monacoEditorRef.current;
    if (ed) {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (model && sel && !sel.isEmpty()) {
        sqlText = model.getValueInRange(sel);
      } else if (model) {
        sqlText = model.getValue();
      }
    }
    const parts = splitStatementsBySemicolon(sqlText);
    const mode = parts.length > 1 ? "batch" : "single";
    await executeSqlForActiveTab(sqlText, mode);
  };

  /** Ctrl+R：执行选中或光标所在单条语句（始终 single，可展示结果表）。 */
  const runSQLSingleAtCursor = async () => {
    if (!activeConnectionId || !activeTab) return;
    let sqlText = activeTab.sql;
    const ed = monacoEditorRef.current;
    if (ed) {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (model && sel && !sel.isEmpty()) {
        sqlText = model.getValueInRange(sel);
      } else if (model) {
        const pos = ed.getPosition();
        if (pos) {
          const stmts = parseSqlStatements(model.getValue());
          const stmt = findStatementAtLine(stmts, pos.lineNumber);
          if (stmt) sqlText = stmt.sql;
        }
      }
    }
    await executeSqlForActiveTab(sqlText, "single");
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
    runSQLSingleAtCursorRef.current = runSQLSingleAtCursor;
    addTabRef.current = addTab;
  }, [runSQLSingleAtCursor, addTab]);

  const explain = async () => {
    if (!activeConnectionId || !activeTab) return;
    let sqlText = activeTab.sql;
    const ed = monacoEditorRef.current;
    if (ed) {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (model && sel && !sel.isEmpty()) {
        sqlText = model.getValueInRange(sel);
      } else if (model) {
        sqlText = model.getValue();
      }
    }
    const trimmed = sqlText.trim();
    if (!trimmed) return;
    try {
      const explainSql = `EXPLAIN ${trimmed}`;
      const r = await api.explainSQL({ connectionId: activeConnectionId, database: selectedDatabase, sql: trimmed });
      upsertDatabaseTabs(selectedDatabase, (list) =>
        list.map((t) => (t.id === activeTab.id ? { ...t, result: r, error: "", lastExecutedSql: explainSql } : t))
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => runSQLSingleAtCursorRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ, () => addTabRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => openAiAssistRef.current());
    if (!completionDisposableRef.current) {
      completionDisposableRef.current = monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: ["."],
        provideCompletionItems: async (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range: IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const keywords = completionWordsRef.current;
          const ctx = completionContextRef.current;
          const line = model.getLineContent(position.lineNumber);
          const qualifier = extractQualifierBeforeDot(line, position.column);

          if (qualifier && ctx.connectionId && ctx.database) {
            const req = resolveTableSchemaRequest(qualifier, ctx);
            if (req) {
              const cacheKey = `${ctx.connectionId}|${req.database}|${req.schema}|${req.table}`;
              let schema = tableSchemaCacheRef.current.get(cacheKey);
              if (!schema) {
                try {
                  schema = (await api.getTableSchema({
                    connectionId: ctx.connectionId,
                    database: req.database,
                    schema: req.schema,
                    table: req.table,
                  })) as TableSchema;
                  tableSchemaCacheRef.current.set(cacheKey, schema);
                } catch {
                  schema = undefined;
                }
              }
              if (schema?.columns) {
                return {
                  suggestions: mergeDotCompletionItems(monaco, range, schema.columns, keywords),
                };
              }
            }
            const keywordOnly: languages.CompletionItem[] = keywords.map((kw) => ({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw,
              range,
            }));
            return { suggestions: keywordOnly };
          }

          const suggestions: languages.CompletionItem[] = keywords.map((kw) => ({
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
        const next = Math.min(
          Math.max(280, drag.startWidth + delta),
          Math.min(380, Math.max(320, window.innerWidth - 360)),
        );
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
    <div className="tf-studio-root flex h-screen min-h-0 w-full flex-col overflow-hidden bg-slate-100 text-slate-900">
      <div className="flex min-h-0 flex-1 flex-row">
        <aside
          className="flex min-h-0 w-[var(--sw)] shrink-0 flex-col border-r border-slate-200 bg-white"
          style={{ ["--sw" as string]: `${sidebarWidth}px`, width: sidebarWidth }}
        >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
            <div ref={menuRef} className="relative shrink-0">
              <button
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-600 hover:bg-slate-100"
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                title="菜单"
              >
                <Menu className="h-4 w-4" strokeWidth={2} />
              </button>
              {menuOpen && (
                <div className="absolute left-0 z-40 mt-1 w-48 overflow-visible rounded-tf border border-slate-200 bg-white py-1 text-xs shadow-lg">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => {
                      setMenuOpen(false);
                      void api.focusMainWindow().catch(() => {
                        window.location.assign(`${window.location.pathname || "/"}`);
                      });
                    }}
                  >
                    <House className="h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={2} />
                    打开主页（连接管理）
                  </button>
                  <div
                    className="relative"
                    onMouseEnter={() => setWorkbenchSubmenuOpen(true)}
                    onMouseLeave={() => setWorkbenchSubmenuOpen(false)}
                  >
                    <div className="flex w-full cursor-default items-center justify-between gap-2 px-3 py-2 hover:bg-slate-50">
                      <span className="text-left">打开其它工作台</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
                    </div>
                    {workbenchSubmenuOpen && (
                      <div className="absolute left-full top-0 z-50 pl-0.5">
                        <div className="min-w-[10rem] max-w-[min(240px,70vw)] rounded-tf border border-slate-200 bg-white py-1 shadow-lg">
                          {otherWorkbenches.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-slate-400">暂无其它分组</div>
                          ) : (
                            otherWorkbenches.map((g) => (
                              <button
                                key={g.id}
                                type="button"
                                className="block w-full truncate px-3 py-2 text-left hover:bg-slate-50"
                                title={g.name}
                                onClick={() => {
                                  setMenuOpen(false);
                                  void api.openGroupWindow(g.id).catch((err) => setError(String(err)));
                                }}
                              >
                                {g.name}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => {
                      setHistoryOpen(true);
                      setMenuOpen(false);
                    }}
                  >
                    历史执行 SQL
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-slate-50"
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
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              title="管理左侧展示的数据库"
              onClick={() => setDbVisibilityOpen(true)}
              disabled={!activeConnectionId}
            >
              <Database className="h-3.5 w-3.5 text-blue-600" strokeWidth={2} />
              管理展示库
            </button>
          </div>

          <div className="tf-studio-object-tree min-h-0 flex-1 overflow-auto py-1 pl-0 pr-1">
            {/*<div className="px-2 pb-1 text-[11px] font-semibold text-slate-500">对象树</div>*/}
            <div className="space-y-0">
              {filteredTree.map((db) => {
                const expanded = db.expanded;
                const filterQ = tableFilter.trim();
                return (
                  <div key={db.name} className="rounded-sm border border-transparent">
                    <button
                      type="button"
                      className={`flex w-full items-center gap-0.5 rounded-sm py-px pl-0 pr-0.5 text-left ${
                        selectedDatabase === db.name
                          ? "bg-slate-100 ring-1 ring-slate-200/90"
                          : "hover:bg-slate-50/90"
                      }`}
                      onClick={() => void toggleDatabaseExpand(db.name)}
                      title={expanded ? "收起表列表" : "展开表列表"}
                    >
                      <span className="w-3.5 shrink-0 select-none text-[10px] leading-none text-slate-400">
                        {expanded ? "▾" : "▸"}
                      </span>
                      <Database className="h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-slate-800">
                        {db.name}
                      </span>
                    </button>
                    {expanded && (
                      <div className="ml-4 border-l border-slate-200/80 pl-3.5 pt-0.5">
                        {db.visibleTables.length === 0 && (
                          <div className="py-px pl-0.5 text-[10px] text-slate-400">
                            {filterQ && db.loaded && db.tables.length > 0 ? "无匹配" : "暂无表"}
                          </div>
                        )}
                        {db.visibleTables.map((tableName) => (
                          <button
                            key={`${db.name}.${tableName}`}
                            type="button"
                            title={`${tableName} · 双击打开`}
                            className="mb-px flex w-full min-w-0 items-center gap-1 rounded-sm py-px pl-0.5 pr-1 text-left font-mono text-[10px] font-normal text-slate-700 hover:bg-slate-50"
                            onDoubleClick={() => appendSelectSQL(db.name, tableName)}
                          >
                            <Table2 className="h-2.5 w-2.5 shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{tableName}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="shrink-0 border-t border-slate-200 px-1.5 py-1.5">
            <input
              className="h-6 w-full rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] leading-tight text-slate-800 outline-none ring-blue-500/30 focus:border-blue-300 focus:ring-2"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="搜索表（仅已展开的库）"
              aria-label="搜索表"
            />
          </div>
        </aside>
        <div
          className="w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-blue-300/60"
          onMouseDown={startSidebarResize}
          title="拖拽调整侧栏宽度"
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-100">
          <section className="flex min-h-0 flex-1 flex-col border-l border-slate-200 bg-white shadow-sm">
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
              <span
                className="min-w-0 max-w-[min(240px,40vw)] shrink truncate text-base font-semibold text-slate-800"
                title={currentGroupName}
              >
                {currentGroupName}
              </span>
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] ${
                  activeConnectionId ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100" : "bg-slate-100 text-slate-500"
                }`}
                title={activeConnMeta ? `${activeConnMeta.name} · ${activeConnMeta.host}:${activeConnMeta.port}` : undefined}
              >
                {activeConnectionId ? (activeConnMeta ? `${activeConnMeta.driver.toUpperCase()} · 就绪` : "已连接") : "未连接"}
              </span>
              <select
                className="max-w-[140px] rounded-tf border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] leading-tight text-slate-700"
                value={activeConnectionId}
                onChange={(e) => setActiveConnectionId(e.target.value)}
                aria-label="数据库连接"
              >
                <option value="">选择连接</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.driver})
                  </option>
                ))}
              </select>
              <span className="max-w-[200px] truncate text-xs text-slate-600" title={selectedDatabase || undefined}>
                {activeConnMeta ? `${activeConnMeta.name} (${activeConnMeta.driver})` : "未选连接"}
              </span>
              <span className="max-w-[160px] truncate text-xs text-slate-500" title={selectedDatabase || undefined}>
                {selectedDatabase ? `当前库 · ${selectedDatabase}` : "未选库"}
              </span>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                onClick={() => void reloadDbTree()}
                disabled={!activeConnectionId}
                title="刷新对象树"
              >
                <RefreshCw className="h-4 w-4" strokeWidth={2} />
              </button>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="hidden text-[11px] text-slate-400 lg:inline">Ctrl+L AI · Ctrl+R 执行当前语句</span>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-transparent text-emerald-600 hover:bg-transparent hover:text-emerald-600 disabled:cursor-not-allowed disabled:text-slate-300"
                  onClick={() => void runUnifiedSQL()}
                  disabled={!activeConnectionId || activeTab?.type !== "sql"}
                  title="执行选中或全文；多条语句时仅显示执行摘要 (与批量一致)"
                >
                  <Play className="h-4 w-4" fill="currentColor" strokeWidth={0} />
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                  onClick={() => void explain()}
                  title="EXPLAIN 选中或全文（与工具栏执行一致）"
                >
                  计划
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                  onClick={addTab}
                >
                  新标签
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                  onClick={() => setHistoryOpen(true)}
                  title="历史执行 SQL"
                >
                  <History className="h-3.5 w-3.5" strokeWidth={2} />
                  历史
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  title="设置"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            </header>

            <div className="tf-studio-tab-strip flex h-7 shrink-0 items-stretch gap-px overflow-x-auto border-b border-slate-200 bg-slate-100/90 px-0.5">
              {visibleTabs.map((t) => {
                const isActive = t.id === activeTab?.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={t.title}
                    className={`group/tab inline-flex h-6 min-w-0 max-w-[min(220px,32vw)] items-center gap-0.5 rounded-sm border px-1 text-left text-[11px] leading-none ${
                      isActive
                        ? "border-slate-200/90 bg-white font-medium text-slate-900 shadow-sm"
                        : "border-transparent bg-transparent font-normal text-slate-500 hover:bg-slate-200/40 hover:text-slate-700"
                    }`}
                    onClick={() => setActiveForDatabase(selectedDatabase, t.id)}
                  >
                    {t.type === "sql" ? (
                      <SquareCode
                        className={`h-3 w-3 shrink-0 ${isActive ? "text-slate-600" : "text-slate-400"}`}
                        strokeWidth={2}
                        aria-hidden
                      />
                    ) : (
                      <Table2
                        className={`h-3 w-3 shrink-0 ${isActive ? "text-slate-600" : "text-slate-400"}`}
                        strokeWidth={2}
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-slate-400 opacity-35 transition-[opacity,background-color,color] hover:bg-slate-200/80 hover:text-slate-700 hover:opacity-100 group-hover/tab:opacity-80"
                      role="button"
                      aria-label="关闭标签"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTab(t.id);
                      }}
                    >
                      <X className="h-2.5 w-2.5" strokeWidth={2} />
                    </span>
                  </button>
                );
              })}
            </div>

            {activeTab?.type === "sql" && (
              <div
                className={
                  showSqlResultPane
                    ? "flex shrink-0 flex-col"
                    : "flex min-h-0 flex-1 flex-col"
                }
              >
                <div
                  className={
                    showSqlResultPane
                      ? "shrink-0 bg-white"
                      : "min-h-0 flex-1 bg-white"
                  }
                  style={showSqlResultPane ? { height: `${editorHeight}px` } : { flex: 1, minHeight: 0 }}
                >
                  <SqlEditorWithGutter
                    height="100%"
                    value={activeTab?.sql ?? ""}
                    onChange={(v) => setTabSQL(v ?? "")}
                    onMount={onEditorMount}
                    executeDisabled={!activeConnectionId}
                    onExecuteStatement={(sql) => void executeSqlForActiveTab(sql, "single")}
                  />
                </div>
              </div>
            )}

            {showSqlResultPane && (
              <>
                <div
                  className="relative z-10 h-2 shrink-0 cursor-row-resize bg-slate-200 hover:bg-blue-300/60"
                  onMouseDown={startEditorResize}
                  title="拖拽调整编辑器/结果高度"
                />
                <section className="flex min-h-[200px] flex-1 flex-col gap-2 overflow-hidden border-t border-slate-200 bg-slate-50/40 p-3">
                  {(activeTabError || error) && <p className="text-xs text-red-600">{activeTabError || error}</p>}
                  {activeTabResult && (
                    <>
                      {activeTabResult.execLog && activeTabResult.execLog.length > 0 ? (
                        <>
                          <p className="shrink-0 text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                          <pre className="max-h-[min(320px,50vh)] min-h-0 flex-1 overflow-auto rounded-tf border border-slate-200 bg-white p-2 text-[11px] text-slate-700">
                            {activeTabResult.execLog.join("\n")}
                          </pre>
                        </>
                      ) : activeTabResult.rows && activeTabResult.rows.length > 0 ? (
                        <div className="result-content min-h-0 min-w-0 flex-1 overflow-hidden">
                          <VirtualResultGrid
                            columns={activeTabResult.columns ?? Object.keys(activeTabResult.rows[0] ?? {})}
                            columnTypes={activeTabResult.columnTypes}
                            rows={activeTabResult.rows as Array<Record<string, unknown>>}
                            displayTimezone={displayTimezone}
                            onCopyError={(msg) => setError(msg)}
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-slate-600">
                          {activeTabResult.message}（{activeTabResult.durationMs}ms）
                        </p>
                      )}
                    </>
                  )}
                </section>
              </>
            )}

            {activeTab?.type === "table" && (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-slate-200/90 bg-slate-50/80 px-3 py-1.5">
                  <div className="min-w-0 pt-0.5 font-mono text-[11px] text-slate-600">
                    <span className="text-slate-400">表</span>{" "}
                    <span className="font-medium text-slate-800" title={activeTab.contextTable}>
                      {activeTab.contextTable}
                    </span>
                    {activeTab.contextDb ? (
                      <span className="text-slate-400"> · {activeTab.contextDb}</span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {activeTab.tableTotal != null &&
                      activeTab.tablePageLimit != null &&
                      activeTab.tableTotal > activeTab.tablePageLimit && (
                        <>
                          <button
                            type="button"
                            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={(activeTab.tableOffset ?? 0) <= 0}
                            onClick={() => {
                              if (!activeTab.contextTable) return;
                              const lim = activeTab.tablePageLimit ?? 5000;
                              void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
                                offset: Math.max(0, (activeTab.tableOffset ?? 0) - lim),
                                orderBy: activeTab.tableSortColumn ?? "",
                                orderDesc: activeTab.tableSortDesc ?? false,
                              });
                            }}
                          >
                            上一页
                          </button>
                          <span className="text-[11px] tabular-nums text-slate-500">
                            {Math.floor((activeTab.tableOffset ?? 0) / (activeTab.tablePageLimit || 1)) + 1} /{" "}
                            {Math.max(1, Math.ceil(activeTab.tableTotal / (activeTab.tablePageLimit || 1)))} 页 · 每页{" "}
                            {activeTab.tablePageLimit} · 共 {activeTab.tableTotal} 行
                          </span>
                          <button
                            type="button"
                            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={(activeTab.tableOffset ?? 0) + (activeTab.tablePageLimit ?? 0) >= activeTab.tableTotal}
                            onClick={() => {
                              if (!activeTab.contextTable) return;
                              const lim = activeTab.tablePageLimit ?? 5000;
                              void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
                                offset: (activeTab.tableOffset ?? 0) + lim,
                                orderBy: activeTab.tableSortColumn ?? "",
                                orderDesc: activeTab.tableSortDesc ?? false,
                              });
                            }}
                          >
                            下一页
                          </button>
                        </>
                      )}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title="重新加载当前页"
                      disabled={!activeTab.contextTable}
                      onClick={() => refreshActiveTableTab()}
                    >
                      <RefreshCw className="h-3 w-3" strokeWidth={2} />
                      刷新
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
                  {(activeTabError || error) && <p className="text-xs text-red-600">{activeTabError || error}</p>}
                  {activeTabResult && (
                    <>
                      {activeTabResult.execLog && activeTabResult.execLog.length > 0 ? (
                        <>
                          <p className="shrink-0 text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                          <pre className="max-h-32 overflow-auto rounded-tf border border-slate-200 bg-white p-2 text-[11px] text-slate-700">
                            {activeTabResult.execLog.join("\n")}
                          </pre>
                        </>
                      ) : activeTabResult.columns && activeTabResult.columns.length > 0 ? (
                        <div className="result-content min-h-0 min-w-0 flex-1 overflow-hidden">
                          <VirtualResultGrid
                            columns={activeTabResult.columns}
                            columnTypes={activeTabResult.columnTypes}
                            rows={(activeTabResult.rows ?? []) as Array<Record<string, unknown>>}
                            displayTimezone={displayTimezone}
                            serverMode
                            sortColumn={activeTab.tableSortColumn}
                            sortDesc={activeTab.tableSortDesc}
                            rowNumberStart={(activeTab.tableOffset ?? 0) + 1}
                            onSortOrder={(colIndex, order) => {
                              if (!activeTab.contextTable) return;
                              const colName = activeTabResult.columns?.[colIndex];
                              if (!colName) return;
                              void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
                                offset: 0,
                                orderBy: colName,
                                orderDesc: order === "desc",
                              });
                            }}
                            onCopyError={(msg) => setError(msg)}
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-slate-600">
                          {activeTabResult.message}（{activeTabResult.durationMs}ms）
                        </p>
                      )}
                    </>
                  )}
                </div>
              </section>
            )}
          </section>

          <footer className="flex min-h-[32px] shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-500">
            <div
              className="min-w-0 flex-1 truncate font-mono text-[11px] leading-snug text-slate-700"
              title={activeTab?.lastExecutedSql || undefined}
            >
              {activeTab?.lastExecutedSql ? activeTab.lastExecutedSql : "—"}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-1">
              <span>
                时区：<span className="font-mono text-slate-700">{displayTimezone}</span>
              </span>
              <span>
                耗时：
                <span className="font-mono text-slate-700">{activeTabResult?.durationMs != null ? `${activeTabResult.durationMs}ms` : "—"}</span>
              </span>
              <span>
                行数：
                <span className="font-mono text-slate-700">
                  {activeTab?.type === "table" && activeTab.tableTotal != null
                    ? activeTab.tableTotal
                    : (activeTabResult?.rows?.length ?? "—")}
                </span>
              </span>
            </div>
          </footer>
        </div>
      </div>

      <DatabaseVisibilityModal
        open={dbVisibilityOpen}
        allDatabaseNames={allDbNames}
        visible={visibilitySetForModal}
        onClose={() => setDbVisibilityOpen(false)}
        onSave={(next) => persistVisibleDbs(next)}
      />

        <SqlHistoryModal
          open={historyOpen}
          items={historyEntries}
          onClose={() => setHistoryOpen(false)}
          onLoadToEditor={useHistorySql}
          onCleared={() => setHistoryRev((r) => r + 1)}
          onCopyError={(msg) => setError(msg)}
        />

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

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

type HeaderBounds = { x: number; y: number; width: number; height: number };

function VirtualResultGrid({
  columns,
  columnTypes,
  rows,
  onCopyError,
  displayTimezone,
  serverMode = false,
  sortColumn,
  sortDesc,
  rowNumberStart = 1,
  onSortOrder,
}: {
  columns: string[];
  /** 与 columns 同序；缺省时不提供「查看完整内容」 */
  columnTypes?: string[];
  rows: Array<Record<string, unknown>>;
  onCopyError: (msg: string) => void;
  displayTimezone: string;
  serverMode?: boolean;
  sortColumn?: string;
  sortDesc?: boolean;
  rowNumberStart?: number;
  /** 表标签页：列头右侧下拉选择升序/降序 */
  onSortOrder?: (colIndex: number, order: "asc" | "desc") => void;
}) {
  const PAGE_SIZE = 10000;
  const [page, setPage] = useState(1);
  const [gridSize, setGridSize] = useState({ width: 900, height: 360 });
  const [ctxMenu, setCtxMenu] = useState<{ left: number; top: number } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ colIndex: number; bounds: HeaderBounds } | null>(null);
  const [cellDetail, setCellDetail] = useState<{ column: string; rowLabel: string; text: string } | null>(null);
  /** 列拖拽调整后的宽度；列集合变化时重置为默认 */
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const gridHostRef = useRef<HTMLDivElement | null>(null);
  const dataEditorRef = useRef<DataEditorRef | null>(null);
  const lastContextClientPosRef = useRef<{ x: number; y: number } | null>(null);
  const contextMenuCellRef = useRef<Item | null>(null);
  /** glide-data-grid 在任意两次 mouseup 间隔 <500ms 都会设 isDoubleClick，不校验是否同一格；此处自行判定「同格双击」 */
  const lastCellPointerRef = useRef<{ col: number; row: number; at: number } | null>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, rows.length);
  const pageRows = serverMode ? rows : rows.slice(pageStart, pageEnd);
  const rowCount = pageRows.length;

  useEffect(() => {
    setPage(1);
  }, [rows, columns.join("|"), serverMode]);

  const columnsSig = columns.join("|");
  const defaultColWidth = 180;
  useEffect(() => {
    setColumnWidths(columns.map(() => defaultColWidth));
  }, [columnsSig]);

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

  useEffect(() => {
    if (!sortMenu) return;
    const close = () => setSortMenu(null);
    const id = window.setTimeout(() => {
      document.addEventListener("click", close);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", close);
    };
  }, [sortMenu]);

  useEffect(() => {
    if (!cellDetail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCellDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cellDetail]);

  const markerStart = serverMode ? rowNumberStart : pageStart + 1;

  const resolvedColumnWidths = useMemo(() => {
    if (columnWidths.length === columns.length) return columnWidths;
    return Array.from({ length: columns.length }, () => defaultColWidth);
  }, [columnsSig, columnWidths, columns.length]);

  const openCellDetail = useCallback(
    (cell: Item) => {
      const [c, r] = cell;
      if (r < 0 || c < 0 || c >= columns.length) return;
      const dbType = columnTypes?.[c];
      if (!isExpandableLongTextColumnType(dbType)) return;
      const colName = columns[c];
      if (colName == null) return;
      const raw = pageRows[r]?.[colName];
      const text =
        raw === null || raw === undefined
          ? "null"
          : formatCellForTimezone(raw, colName, displayTimezone);
      setCellDetail({
        column: colName,
        rowLabel: String(markerStart + r),
        text,
      });
    },
    [columns, columnTypes, pageRows, displayTimezone, markerStart],
  );

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((name, i) => {
        const base: GridColumn = { title: name, id: name, width: resolvedColumnWidths[i] ?? defaultColWidth };
        if (serverMode && onSortOrder) {
          return {
            ...base,
            hasMenu: true,
            menuIcon: GridColumnMenuIcon.Triangle,
          };
        }
        return base;
      }),
    [columns, resolvedColumnWidths, serverMode, onSortOrder],
  );

  const onColumnResize = useCallback(
    (_column: GridColumn, newSize: number, colIndex: number) => {
      setColumnWidths((prev) => {
        const len = columns.length;
        const next = prev.length === len ? [...prev] : columns.map(() => defaultColWidth);
        next[colIndex] = newSize;
        return next;
      });
    },
    [columns],
  );

  const getCellContent = useMemo(() => {
    return ([col, row]: Item): GridCell => {
      const colName = columns[col];
      const raw = colName ? pageRows[row]?.[colName] : undefined;
      if (colName && (raw === null || raw === undefined)) {
        return {
          kind: GridCellKind.Text,
          allowOverlay: false,
          readonly: true,
          displayData: "null",
          data: "null",
          themeOverride: {
            textDark: GRID_NULL_TEXT,
            textMedium: GRID_NULL_TEXT,
            textLight: GRID_NULL_TEXT,
          },
        };
      }
      const value = colName ? formatCellForTimezone(raw, colName, displayTimezone) : "";
      return {
        kind: GridCellKind.Text,
        allowOverlay: false,
        readonly: true,
        displayData: value,
        data: value,
      };
    };
  }, [columns, pageRows, displayTimezone]);

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
          key={`grid-${serverMode ? "srv" : "cli"}-${safePage}-${columns.join("|")}`}
          theme={gridTheme}
          columns={gridColumns}
          rows={rowCount}
          getCellContent={getCellContent}
          getCellsForSelection={true}
          width={gridSize.width}
          height={gridSize.height}
          rowHeight={GRID_ROW_HEIGHT}
          headerHeight={GRID_HEADER_HEIGHT}
          rowMarkers={{ kind: "number", width: ROW_MARKER_WIDTH, startIndex: markerStart }}
          rowSelectionMode="multi"
          smoothScrollX
          smoothScrollY
          overscrollX={16}
          onColumnResize={onColumnResize}
          onHeaderMenuClick={
            serverMode && onSortOrder
              ? (colIndex, bounds: HeaderBounds) => {
                  setSortMenu({ colIndex, bounds });
                }
              : undefined
          }
          onCellClicked={(cell) => {
            const [c, r] = cell;
            if (r < 0 || c < 0 || c >= columns.length) return;
            const dbType = columnTypes?.[c];
            if (!isExpandableLongTextColumnType(dbType)) {
              lastCellPointerRef.current = null;
              return;
            }
            const now = Date.now();
            const prev = lastCellPointerRef.current;
            const sameCell =
              prev != null && prev.col === c && prev.row === r && now - prev.at < 400;
            if (sameCell) {
              lastCellPointerRef.current = null;
              openCellDetail(cell);
              return;
            }
            lastCellPointerRef.current = { col: c, row: r, at: now };
          }}
          onCellContextMenu={(cell, event) => {
            event.preventDefault();
            contextMenuCellRef.current = cell;
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
      {!serverMode && rows.length > PAGE_SIZE && (
        <div className="result-pager">
          <button className="btn ghost" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            上一页
          </button>
          <span>
            第 {safePage} / {totalPages} 页（每页 {PAGE_SIZE} 条）
          </span>
          <button className="btn ghost" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            下一页
          </button>
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
          {contextMenuCellRef.current != null &&
          contextMenuCellRef.current[1] >= 0 &&
          contextMenuCellRef.current[0] >= 0 &&
          isExpandableLongTextColumnType(columnTypes?.[contextMenuCellRef.current[0]]) ? (
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                const c = contextMenuCellRef.current;
                if (c) openCellDetail(c);
                setCtxMenu(null);
              }}
            >
              查看完整内容
            </button>
          ) : null}
          <button className="context-menu-item" onClick={() => void copySelection().then(() => setCtxMenu(null))}>
            复制
          </button>
        </div>
      ) : null}
      {sortMenu && onSortOrder
        ? createPortal(
            <div
              className="fixed z-[10000] min-w-[108px] rounded-md border border-slate-200 bg-white px-0.5 py-1 font-mono text-xs leading-snug text-slate-700 shadow-md"
              style={{
                left: sortMenu.bounds.x + sortMenu.bounds.width - 112,
                top: sortMenu.bounds.y + sortMenu.bounds.height,
              }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`w-full rounded px-2.5 py-1.5 text-left font-mono text-xs text-slate-700 hover:bg-slate-100 ${sortColumn === columns[sortMenu.colIndex] && !sortDesc ? "bg-slate-100" : ""}`}
                onClick={() => {
                  onSortOrder(sortMenu.colIndex, "asc");
                  setSortMenu(null);
                }}
              >
                升序
              </button>
              <button
                type="button"
                className={`w-full rounded px-2.5 py-1.5 text-left font-mono text-xs text-slate-700 hover:bg-slate-100 ${sortColumn === columns[sortMenu.colIndex] && sortDesc ? "bg-slate-100" : ""}`}
                onClick={() => {
                  onSortOrder(sortMenu.colIndex, "desc");
                  setSortMenu(null);
                }}
              >
                降序
              </button>
            </div>,
            document.body,
          )
        : null}
      {cellDetail
        ? createPortal(
            <div
              className="modal-mask"
              style={{ zIndex: 10001 }}
              role="presentation"
              onClick={() => setCellDetail(null)}
            >
              <div className="modal-panel large" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h3 className="text-sm font-medium text-slate-800">
                    {cellDetail.column} · 行 {cellDetail.rowLabel}
                  </h3>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className="btn ghost text-xs"
                      onClick={() => {
                        void navigator.clipboard.writeText(cellDetail.text).catch(() => onCopyError("复制失败"));
                      }}
                    >
                      复制
                    </button>
                    <button type="button" className="btn ghost text-xs" onClick={() => setCellDetail(null)}>
                      关闭
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  className="w-full min-h-[200px] max-h-[min(60vh,480px)] resize-y rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] leading-relaxed text-slate-800"
                  value={cellDetail.text}
                  aria-label="单元格完整内容"
                />
                <p className="mt-2 text-[11px] text-slate-500">共 {cellDetail.text.length} 字符</p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default App;

