import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnMenuIcon,
  getDefaultTheme,
  type DataEditorRef,
  type EditableGridCell,
  type GridColumn,
  type Item,
  type GridCell,
  type GridSelection,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { editor as MonacoEditorNS, IDisposable, IRange, languages } from "monaco-editor";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  History,
  House,
  Loader2,
  Menu,
  Play,
  RefreshCw,
  Settings2,
  SquareCode,
  Table2,
  XCircle,
  X,
  Square,
} from "lucide-react";
import { api } from "./api";
import type {
  ConnectionMeta,
  DataMigrationJobSnapshot,
  ExecuteSQLResult,
  MigrationHistoryEntry,
  TableSchema,
  WorkspaceGroup,
} from "./types";
import SettingsPanel from "./components/SettingsPanel";
import AppMessageHost from "./components/AppMessageHost";
import ConnectionManager from "./components/connection-manager/ConnectionManager";
import DatabaseVisibilityModal from "./components/studio/DatabaseVisibilityModal";
import { formatCellForTimezone, readDisplayTimezone } from "./components/studio/timezoneDisplay";
import { PreviewInsertRowsRequest, TableQueryRequest, UpdateRowsRequest } from "../bindings/changeme";
import SqlEditorWithGutter from "./components/studio/SqlEditorWithGutter";
import SqlHistoryModal from "./components/studio/SqlHistoryModal";
import { pushSqlHistory, readSqlHistory } from "./utils/sqlHistory";
import { findStatementAtLine, parseSqlStatements, splitStatementsBySemicolon } from "./utils/sqlStatements";
import {
  extractQualifierBeforeDot,
  extractReferencedCurrentDatabaseTables,
  mergeContextTableColumnCompletionItems,
  mergeDotCompletionItems,
  resolveTableSchemaRequest,
} from "./utils/sqlDotCompletion";
import { isExpandableLongTextColumnType } from "./utils/gridColumnTypes";
import { showAppMessage } from "./utils/message";

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
  /** 表标签：正在请求分页/排序数据 */
  tableQueryLoading?: boolean;
  /** 查询标签：正在执行 SQL 或 EXPLAIN */
  sqlResultLoading?: boolean;
  /** 当前正在执行的 SQL 文本（用于 gutter 匹配高亮） */
  runningSQL?: string;
  /** 当前标签页最近一次发起、且仍允许回写状态的请求 ID */
  runningRequestId?: string;

  /** SQL 结果分页（客户端切片） */
  sqlGridPage?: number;
  /** 后端 SQL 结果缓存 ID，用于按页读取全量查询集 */
  sqlResultRequestId?: string;
  sqlResultTotal?: number;
  sqlResultOffset?: number;
  sqlResultPageLimit?: number;

  /** 表标签：主键列（用于更新） */
  tablePrimaryKey?: string[];
  /** 表标签：原始行快照（用于取消） */
  tableEditOriginalRows?: Array<Record<string, unknown>>;
  /** 表标签：脏行（key=当前页 rowIndex；value=列名→新值） */
  tableEditDirtyRows?: Record<number, Record<string, unknown>>;
  /** 表标签：预览 SQL Modal */
  tableEditPreviewOpen?: boolean;
  tableEditPreviewLoading?: boolean;
  tableEditPreviewStatements?: string[];
  tableEditApplyLoading?: boolean;
};

const CLIENT_GRID_PAGE_SIZE = 10000;

type GridTableContext = {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
};

type GridContextMenuContext = {
  cell: Item;
  colIndex: number;
  rowIndex: number;
  columnName?: string;
  rowData?: Record<string, unknown>;
  selectedRowIndexes: number[];
  selectedColumnIndexes: number[];
  selectedEditableColumnNames: string[];
  isLongTextCell: boolean;
  isPrimaryKeyColumn: boolean;
  canEditSelection: boolean;
  canCopyRowsAsInsert: boolean;
  canCopySelectionAsUpdate: boolean;
};

type GridContextMenuState = {
  left: number;
  top: number;
  context: GridContextMenuContext;
};

type GridContextMenuEntry =
  | {
      kind: "action";
      label: string;
      onSelect: () => void | Promise<void>;
      disabled?: boolean;
    }
  | {
      kind: "submenu";
      label: string;
      children: GridContextMenuEntry[];
      disabled?: boolean;
    }
  | {
      kind: "separator";
    };

type CellDetailMode = "raw" | "json-format" | "json-minify" | "url-decode" | "url-encode" | "base64-decode" | "base64-encode";

type CellDetailState = {
  column: string;
  rowLabel: string;
  rowIndex: number;
  colIndex: number;
  dbType: string;
  originalText: string;
  draftText: string;
  mode: CellDetailMode;
  error: string;
};

type CellTransformResult = {
  text: string;
  error?: string;
};

const CELL_DETAIL_TRANSFORMS: Array<{ mode: CellDetailMode; label: string }> = [
  { mode: "raw", label: "原文" },
  { mode: "json-format", label: "JSON格式化" },
  { mode: "json-minify", label: "JSON压缩" },
  { mode: "url-decode", label: "URL解码" },
  { mode: "url-encode", label: "URL编码" },
  { mode: "base64-decode", label: "Base64解码" },
  { mode: "base64-encode", label: "Base64编码" },
];

function tryFormatJson(text: string): CellTransformResult {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (e) {
    return { text, error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tryMinifyJson(text: string): CellTransformResult {
  try {
    return { text: JSON.stringify(JSON.parse(text)) };
  } catch (e) {
    return { text, error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tryUrlDecode(text: string): CellTransformResult {
  try {
    return { text: decodeURIComponent(text) };
  } catch (e) {
    return { text, error: `URL 解码失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tryUrlEncode(text: string): CellTransformResult {
  try {
    return { text: encodeURIComponent(text) };
  } catch (e) {
    return { text, error: `URL 编码失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tryBase64Decode(text: string): CellTransformResult {
  try {
    const binary = atob(text.trim());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes) };
  } catch (e) {
    return { text, error: `Base64 解码失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tryBase64Encode(text: string): CellTransformResult {
  try {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return { text: btoa(binary) };
  } catch (e) {
    return { text, error: `Base64 编码失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function transformCellDetailText(mode: CellDetailMode, draftText: string, originalText: string): CellTransformResult {
  switch (mode) {
    case "raw":
      return { text: originalText };
    case "json-format":
      return tryFormatJson(draftText);
    case "json-minify":
      return tryMinifyJson(draftText);
    case "url-decode":
      return tryUrlDecode(draftText);
    case "url-encode":
      return tryUrlEncode(draftText);
    case "base64-decode":
      return tryBase64Decode(draftText);
    case "base64-encode":
      return tryBase64Encode(draftText);
  }
}

function clampGridContextMenuPosition(x: number, y: number) {
  const w = 340;
  const h = 260;
  const margin = 8;
  const nx = Math.min(x, window.innerWidth - w - margin);
  const ny = Math.min(y, window.innerHeight - h - margin);
  return { left: Math.max(margin, nx), top: Math.max(margin, ny) };
}

function normalizeContextMenuEntries(entries: GridContextMenuEntry[]): GridContextMenuEntry[] {
  const normalized: GridContextMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator") {
      if (normalized.length === 0 || normalized[normalized.length - 1]?.kind === "separator") continue;
      normalized.push(entry);
      continue;
    }
    normalized.push(entry);
  }
  while (normalized[normalized.length - 1]?.kind === "separator") normalized.pop();
  return normalized;
}

function createEmptyGridSelection(): GridSelection {
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
}

function coerceEditedCellValue(original: unknown, text: string): unknown {
  const t = text.trim();
  if (t.toLowerCase() === "null") return null;
  if (original === null || original === undefined) {
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    return text;
  }
  if (typeof original === "number") {
    const n = Number(t);
    return Number.isNaN(n) ? text : n;
  }
  if (typeof original === "boolean") {
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
    return text;
  }
  return text;
}

function mergeTableRowsForDisplay(
  base: Array<Record<string, unknown>>,
  dirty: Record<number, Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  if (!dirty || Object.keys(dirty).length === 0) return base;
  return base.map((row, i) => {
    const patch = dirty[i];
    if (!patch) return row;
    return { ...row, ...patch };
  });
}

/** 仅包含主键列 + 已修改列，供 UPDATE 只 SET 实际变更的字段 */
function buildUpdateRowPayload(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  keyColumns: string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const k of keyColumns) {
    row[k] = base[k];
  }
  for (const k of Object.keys(patch)) {
    row[k] = patch[k];
  }
  return row;
}

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

const createRequestId = () => crypto.randomUUID();

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

function hasAllPrimaryKeysInColumns(primaryKeys: string[], columns: string[]): boolean {
  if (primaryKeys.length === 0) return false;
  const columnSet = new Set(columns.map((name) => name.toLowerCase()));
  return primaryKeys.every((pk) => columnSet.has(pk.toLowerCase()));
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

/** 读取查询超时设置（毫秒）；0 表示无超时限制 */
async function resolveQueryTimeout(): Promise<number> {
  try {
    const raw = localStorage.getItem("settings");
    if (raw) {
      const parsed = JSON.parse(raw) as { queryTimeout?: number };
      if (typeof parsed.queryTimeout === "number" && parsed.queryTimeout >= 0) {
        return parsed.queryTimeout;
      }
    }
  } catch {
    /* ignore */
  }
  const s = await api.getSettings();
  return s.queryTimeout ?? 30000;
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

const CONN_TREE_STORAGE_PREFIX = "tableflux.studio.conn_tree:";

function connTreeStorageKey(connectionId: string) {
  return `${CONN_TREE_STORAGE_PREFIX}${connectionId}`;
}

type ConnTreeSnapshot = {
  selectedDatabase: string;
  expandedDatabases: string[];
};

function readConnTreeSnapshot(connectionId: string): ConnTreeSnapshot | null {
  try {
    const raw = localStorage.getItem(connTreeStorageKey(connectionId));
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<ConnTreeSnapshot>;
    const selectedDatabase = typeof o.selectedDatabase === "string" ? o.selectedDatabase : "";
    const expandedDatabases = Array.isArray(o.expandedDatabases)
      ? o.expandedDatabases.filter((x): x is string => typeof x === "string")
      : [];
    return { selectedDatabase, expandedDatabases };
  } catch {
    return null;
  }
}
/** 未提交编辑单元格背景（与表格浅色主题协调） */
const GRID_DIRTY_CELL_BG = "#fffbeb";
const GRID_DIRTY_CELL_BG_MEDIUM = "#fef3c7";
const ROW_MARKER_WIDTH = 42;

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const studioGroupId = params.get("groupId") ?? "";
  const mode: ViewMode = params.get("studio") === "1" ? "studio" : "main";
  const view = mode === "studio" ? <StudioView groupId={studioGroupId} /> : <ConnectionManager />;

  return (
    <>
      {view}
      <AppMessageHost />
    </>
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
  const setError = useCallback((message: string) => {
    if (!message) return;
    showAppMessage({ variant: "error", title: "操作失败", message });
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [editorHeight, setEditorHeight] = useState(340);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workbenchSubmenuOpen, setWorkbenchSubmenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRev, setHistoryRev] = useState(0);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationProgressOpen, setMigrationProgressOpen] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationMsg, setMigrationMsg] = useState("");
  const [migrationWorkerCount, setMigrationWorkerCount] = useState(2);
  const [migrationBatchSize, setMigrationBatchSize] = useState(500);
  const [migrationTableFilter, setMigrationTableFilter] = useState("");
  const [migrationJob, setMigrationJob] = useState<DataMigrationJobSnapshot | null>(null);
  const [migrationHistory, setMigrationHistory] = useState<MigrationHistoryEntry[]>([]);
  const [migrationHistoryOpen, setMigrationHistoryOpen] = useState(false);
  const [migrationHistoryDetail, setMigrationHistoryDetail] = useState<MigrationHistoryEntry | null>(null);
  const migrationJobMetaRef = useRef<{
    sourceConnectionName: string;
    sourceDatabase: string;
    targetConnectionName: string;
    targetDatabase: string;
  } | null>(null);
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
  /** 对象树表行右键菜单 */
  const [tableCtxMenu, setTableCtxMenu] = useState<{
    x: number;
    y: number;
    dbName: string;
    tableName: string;
  } | null>(null);
  /** 正在执行后台操作的表（key = dbName::tableName） */
  const [tableOpsRunning, setTableOpsRunning] = useState<Set<string>>(new Set());
  /** 查看表结构弹窗 */
  const [tableSchemaModal, setTableSchemaModal] = useState<{
    dbName: string;
    tableName: string;
    schema: TableSchema | null;
    loading: boolean;
  } | null>(null);
  /** 危险操作确认弹窗 */
  const [tableConfirmModal, setTableConfirmModal] = useState<{
    type: "drop" | "truncate";
    dbName: string;
    tableName: string;
  } | null>(null);
  /** 复制表弹窗 */
  const [tableCopyModal, setTableCopyModal] = useState<{
    dbName: string;
    tableName: string;
    newName: string;
    running: boolean;
    error: string;
  } | null>(null);
  const [displayTimezone, setDisplayTimezone] = useState(() => readDisplayTimezone());

  const completionWordsRef = useRef<string[]>([...SQL_KEYWORDS]);
  const currentDatabaseTablesRef = useRef<string[]>([]);
  const completionContextRef = useRef<{
    connectionId: string;
    database: string;
    dialect: "mysql" | "postgres";
  }>({ connectionId: "", database: "", dialect: "mysql" });
  const tableSchemaCacheRef = useRef<Map<string, TableSchema>>(new Map());
  const completionDisposableRef = useRef<IDisposable | null>(null);
  const monacoEditorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const tableFilterInputRef = useRef<HTMLInputElement | null>(null);
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
  /** 当前 `dbTree` 对应的连接；与 `activeConnectionId` 不一致时不写入 localStorage（避免切换连接瞬间串数据） */
  const treeOwnerConnRef = useRef<string>("");
  /** 分组会话恢复的标签页首库，供首次拉取对象树且尚无 conn_tree 存档时对齐选中库 */
  const sessionPreferredDbRef = useRef<string>("");
  const activeConnectionIdRef = useRef(activeConnectionId);
  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId;
  }, [activeConnectionId]);

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

  const getOrFetchTableSchema = useCallback(
    async (connectionId: string, dbName: string, tableName: string, dialect: "mysql" | "postgres") => {
      const schemaName = dialect === "postgres" ? "public" : "";
      const cacheKey = `${connectionId}|${dbName}|${schemaName}|${tableName}`;
      const cached = tableSchemaCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const schema = (await api.getTableSchema({
        connectionId,
        database: dbName,
        schema: schemaName,
        table: tableName,
      })) as TableSchema;
      tableSchemaCacheRef.current.set(cacheKey, schema);
      return schema;
    },
    [],
  );

  const runTablePageQuery = useCallback(
    async (
      tabId: string,
      dbName: string,
      tableName: string,
      opts: { offset: number; orderBy: string; orderDesc: boolean },
    ) => {
      if (!activeConnectionId) return;
      const connectionId = activeConnectionId;
      const requestId = createRequestId();
      beginTableTabRequest(connectionId, dbName, tabId, requestId);
      try {
        let pkCols: string[] | undefined;
        try {
          const schema = await getOrFetchTableSchema(connectionId, dbName, tableName, sqlDialect);
          pkCols = (schema.primaryKey || []).filter(Boolean);
        } catch {
          pkCols = undefined;
        }

        const limit = await resolveQueryLimit();
        const page = await api.queryTablePage(
          new TableQueryRequest({
            connectionId,
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
        const originalRows = (result.rows ?? []).map((r) => ({ ...r })) as Array<Record<string, unknown>>;
        const lastSql = buildTableBrowseSqlDisplay(
          tableName,
          sqlDialect,
          opts.orderBy,
          opts.orderDesc,
          page.limit,
          opts.offset,
        );
        finishTableTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
          ...tab,
          result,
          error: "",
          lastExecutedSql: lastSql,
          tableTotal: page.total,
          tableOffset: page.offset,
          tablePageLimit: page.limit,
          tableSortColumn: opts.orderBy || undefined,
          tableSortDesc: opts.orderDesc,
          tablePrimaryKey: pkCols,
          tableEditOriginalRows: originalRows,
          tableEditDirtyRows: {},
        }));
      } catch (e) {
        finishTableTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
          ...tab,
          error: String(e),
          result: null,
        }));
      }
    },
    [activeConnectionId, getOrFetchTableSchema, sqlDialect],
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

  useEffect(() => {
    if (currentGroupName) {
      document.title = currentGroupName;
    }
  }, [currentGroupName]);
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
    currentDatabaseTablesRef.current = selectedDatabase
      ? (dbTree.find((db) => db.name === selectedDatabase)?.tables ?? [])
      : [];
  }, [dbTree, selectedDatabase]);

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
        sessionPreferredDbRef.current = defaultDb;
        const key = `${initialConn}::${defaultDb || "__none__"}`;
        setTabsByDatabase({ [key]: restoredTabs });
        setActiveTabByDatabase({ [key]: restoredTabs[0]?.id || "" });
      } else {
        sessionPreferredDbRef.current = "";
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

  const reloadDbTree = useCallback(async () => {
    const connId = activeConnectionId;
    if (!connId) {
      treeOwnerConnRef.current = "";
      setDbTree([]);
      setSelectedDatabase("");
      return;
    }
    treeOwnerConnRef.current = "";
    setDbTree([]);
    setSelectedDatabase("");
    try {
      const dbs = await api.listDatabases(connId);
      if (connId !== activeConnectionIdRef.current) return;
      const names = dbs.map((d: any) => d.name);
      const nameSet = new Set(names);
      const snap = readConnTreeSnapshot(connId);
      const expandedSet = new Set((snap?.expandedDatabases ?? []).filter((n) => nameSet.has(n)));

      let nextSelected = "";
      const pref = sessionPreferredDbRef.current;
      if (pref && nameSet.has(pref)) {
        nextSelected = pref;
        sessionPreferredDbRef.current = "";
      } else if (snap?.selectedDatabase && nameSet.has(snap.selectedDatabase)) {
        nextSelected = snap.selectedDatabase;
      }

      setDbTree(
        names.map((name) => ({
          name,
          expanded: expandedSet.has(name),
          loaded: false,
          tables: [],
        })),
      );
      setSelectedDatabase(nextSelected);
      treeOwnerConnRef.current = connId;
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [activeConnectionId]);

  useEffect(() => {
    void reloadDbTree();
  }, [reloadDbTree, connections]);

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
    if (treeOwnerConnRef.current !== activeConnectionId) return;
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

  const loadTablesForDB = useCallback(
    async (dbName: string) => {
      const connId = activeConnectionId;
      if (!connId || !dbName) return;
      const current = dbTree.find((d) => d.name === dbName);
      if (current?.loaded) return;
      try {
        const list = await api.listTables(connId, dbName, "");
        if (connId !== activeConnectionIdRef.current) return;
        const tableNames = (list || []).map((t: any) => t.name);
        setDbTree((prev) =>
          prev.map((d) => (d.name === dbName ? { ...d, loaded: true, tables: tableNames } : d)),
        );
      } catch (e) {
        setError(String(e));
      }
    },
    [activeConnectionId, dbTree],
  );

  useEffect(() => {
    if (!activeConnectionId || treeOwnerConnRef.current !== activeConnectionId) return;
    try {
      const expandedDatabases = dbTree.filter((d) => d.expanded).map((d) => d.name);
      localStorage.setItem(
        connTreeStorageKey(activeConnectionId),
        JSON.stringify({ selectedDatabase, expandedDatabases }),
      );
    } catch {
      /* ignore */
    }
  }, [activeConnectionId, selectedDatabase, dbTree]);

  useEffect(() => {
    if (!activeConnectionId || treeOwnerConnRef.current !== activeConnectionId) return;
    for (const db of dbTree) {
      if (db.expanded && !db.loaded) {
        void loadTablesForDB(db.name);
      }
    }
  }, [activeConnectionId, dbTree, loadTablesForDB]);

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

  const updateExistingDatabaseTabs = (
    connectionId: string,
    dbName: string,
    updater: (tabs: WorkbenchTab[]) => WorkbenchTab[],
  ) => {
    if (!connectionId) return;
    const key = `${connectionId}::${dbName || "__none__"}`;
    setTabsByDatabase((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return {
        ...prev,
        [key]: updater(current),
      };
    });
  };

  const updateTabById = (
    connectionId: string,
    dbName: string,
    tabId: string,
    updater: (tab: WorkbenchTab) => WorkbenchTab,
  ) => {
    updateExistingDatabaseTabs(connectionId, dbName, (list) => list.map((t) => (t.id === tabId ? updater(t) : t)));
  };

  const beginSqlTabRequest = (
    connectionId: string,
    dbName: string,
    tabId: string,
    requestId: string,
    runningSQL: string,
  ) => {
    updateTabById(connectionId, dbName, tabId, (tab) => ({
      ...tab,
      error: "",
      sqlResultLoading: true,
      runningSQL,
      runningRequestId: requestId,
    }));
  };

  const finishSqlTabRequest = (
    connectionId: string,
    dbName: string,
    tabId: string,
    requestId: string,
    updater: (tab: WorkbenchTab) => WorkbenchTab,
  ) => {
    updateTabById(connectionId, dbName, tabId, (tab) => {
      if (tab.runningRequestId !== requestId) return tab;
      return updater({
        ...tab,
        sqlResultLoading: false,
        runningSQL: "",
        runningRequestId: "",
      });
    });
  };

  const clearSqlTabRequest = (connectionId: string, dbName: string, tabId: string, requestId: string) => {
    finishSqlTabRequest(connectionId, dbName, tabId, requestId, (tab) => tab);
  };

  const beginTableTabRequest = (connectionId: string, dbName: string, tabId: string, requestId: string) => {
    updateTabById(connectionId, dbName, tabId, (tab) => ({
      ...tab,
      error: "",
      tableQueryLoading: true,
      runningRequestId: requestId,
    }));
  };

  const finishTableTabRequest = (
    connectionId: string,
    dbName: string,
    tabId: string,
    requestId: string,
    updater: (tab: WorkbenchTab) => WorkbenchTab,
  ) => {
    updateTabById(connectionId, dbName, tabId, (tab) => {
      if (tab.runningRequestId !== requestId) return tab;
      return updater({
        ...tab,
        tableQueryLoading: false,
        runningRequestId: "",
      });
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

  const patchActiveEditableTab = useCallback(
    (updater: (t: WorkbenchTab) => WorkbenchTab) => {
      if (!activeTab || !activeConnectionId) return;
      const db = activeTab.contextDb || selectedDatabase;
      const key = `${activeConnectionId}::${db || "__none__"}`;
      setTabsByDatabase((prev) => {
        const list = prev[key] ?? [];
        return {
          ...prev,
          [key]: list.map((t) => (t.id === activeTab.id ? updater(t) : t)),
        };
      });
    },
    [activeTab, activeConnectionId, selectedDatabase],
  );

  const handleTableCellEdit = useCallback(
    (rowIndex: number, colName: string, value: unknown) => {
      if (!activeTab) return;
      patchActiveEditableTab((t) => {
        const orig = t.tableEditOriginalRows?.[rowIndex];
        if (!orig) return t;
        const baseVal = orig[colName];
        const same =
          (baseVal === null || baseVal === undefined) && (value === null || value === undefined)
            ? true
            : baseVal === value;
        const nextDirty = { ...(t.tableEditDirtyRows ?? {}) };
        const rowPatch = { ...(nextDirty[rowIndex] ?? {}) };
        if (same) {
          delete rowPatch[colName];
          if (Object.keys(rowPatch).length === 0) delete nextDirty[rowIndex];
          else nextDirty[rowIndex] = rowPatch;
        } else {
          rowPatch[colName] = value;
          nextDirty[rowIndex] = rowPatch;
        }
        return { ...t, tableEditDirtyRows: nextDirty };
      });
    },
    [activeTab, patchActiveEditableTab],
  );

  const handleTableCancelEdit = useCallback(() => {
    patchActiveEditableTab((t) => ({ ...t, tableEditDirtyRows: {} }));
  }, [patchActiveEditableTab]);

  const handleTableOpenPreview = useCallback(async () => {
    if (!activeTab || !activeConnectionId || !activeTab.contextTable) return;
    const pk = activeTab.tablePrimaryKey ?? [];
    if (pk.length === 0) {
      setError("无法确定主键，无法生成更新语句");
      return;
    }
    const dirty = activeTab.tableEditDirtyRows ?? {};
    const dirtyIndices = Object.keys(dirty).map((k) => Number(k)).filter((i) => !Number.isNaN(i));
    if (dirtyIndices.length === 0) {
      setError("没有未提交的修改");
      return;
    }
    const orig = activeTab.tableEditOriginalRows ?? [];
    const rows: Array<Record<string, unknown>> = [];
    for (const i of dirtyIndices) {
      const patch = dirty[i];
      if (!patch || Object.keys(patch).length === 0) continue;
      const base = orig[i];
      if (!base) continue;
      rows.push(buildUpdateRowPayload(base, patch, pk));
    }
    if (rows.length === 0) {
      setError("没有可提交的修改");
      return;
    }
    patchActiveEditableTab((t) => ({
      ...t,
      tableEditPreviewOpen: true,
      tableEditPreviewLoading: true,
      tableEditPreviewStatements: undefined,
    }));
    try {
      const r = await api.previewUpdateRowsSQL(
        new UpdateRowsRequest({
          connectionId: activeConnectionId,
          database: activeTab.contextDb,
          schema: sqlDialect === "postgres" ? "public" : "",
          table: activeTab.contextTable,
          keyColumns: pk,
          rows,
        }),
      );
      patchActiveEditableTab((t) => ({
        ...t,
        tableEditPreviewLoading: false,
        tableEditPreviewStatements: r.statements ?? [],
      }));
      setError("");
    } catch (e) {
      patchActiveEditableTab((t) => ({
        ...t,
        tableEditPreviewLoading: false,
        tableEditPreviewOpen: false,
        tableEditPreviewStatements: undefined,
      }));
      setError(String(e));
    }
  }, [activeTab, activeConnectionId, patchActiveEditableTab, sqlDialect]);

  const handleTableClosePreview = useCallback(() => {
    patchActiveEditableTab((t) => ({
      ...t,
      tableEditPreviewOpen: false,
      tableEditPreviewLoading: false,
      tableEditPreviewStatements: undefined,
    }));
  }, [patchActiveEditableTab]);

  const handleTableApplyPreview = useCallback(async () => {
    if (!activeTab || !activeConnectionId || !activeTab.contextTable) return;
    const pk = activeTab.tablePrimaryKey ?? [];
    const dirty = activeTab.tableEditDirtyRows ?? {};
    const orig = activeTab.tableEditOriginalRows ?? [];
    const rows: Array<Record<string, unknown>> = [];
    for (const k of Object.keys(dirty)) {
      const i = Number(k);
      if (Number.isNaN(i)) continue;
      const patch = dirty[i];
      if (!patch || Object.keys(patch).length === 0) continue;
      const base = orig[i];
      if (!base) continue;
      rows.push(buildUpdateRowPayload(base, patch, pk));
    }
    if (pk.length === 0 || rows.length === 0) return;
    const mergedRows = mergeTableRowsForDisplay(orig, dirty).map((row) => ({ ...row }));
    patchActiveEditableTab((t) => ({ ...t, tableEditApplyLoading: true }));
    try {
      await api.updateRows(
        new UpdateRowsRequest({
          connectionId: activeConnectionId,
          database: activeTab.contextDb,
          schema: sqlDialect === "postgres" ? "public" : "",
          table: activeTab.contextTable,
          keyColumns: pk,
          rows,
        }),
      );
      patchActiveEditableTab((t) => ({
        ...t,
        tableEditApplyLoading: false,
        tableEditPreviewOpen: false,
        tableEditPreviewStatements: undefined,
        tableEditDirtyRows: {},
        tableEditOriginalRows: mergedRows,
      }));
      setError("");
      if (activeTab.type === "table") {
        void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
          offset: activeTab.tableOffset ?? 0,
          orderBy: activeTab.tableSortColumn ?? "",
          orderDesc: activeTab.tableSortDesc ?? false,
        });
      }
    } catch (e) {
      patchActiveEditableTab((t) => ({ ...t, tableEditApplyLoading: false }));
      setError(String(e));
    }
  }, [activeTab, activeConnectionId, patchActiveEditableTab, runTablePageQuery, sqlDialect]);

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

  // ── 对象树表行右键操作 ────────────────────────────────────────────────────

  const tableOpKey = (dbName: string, tableName: string) => `${dbName}::${tableName}`;

  const isTableOpRunning = (dbName: string, tableName: string) =>
    tableOpsRunning.has(tableOpKey(dbName, tableName));

  const startTableOp = (dbName: string, tableName: string) =>
    setTableOpsRunning((prev) => new Set([...prev, tableOpKey(dbName, tableName)]));

  const endTableOp = (dbName: string, tableName: string) =>
    setTableOpsRunning((prev) => {
      const next = new Set(prev);
      next.delete(tableOpKey(dbName, tableName));
      return next;
    });

  const computeCopyName = (tableName: string, existingTables: string[]) => {
    const base = `${tableName}_copy`;
    if (!existingTables.includes(base)) return base;
    let n = 2;
    while (existingTables.includes(`${base}${n}`)) n++;
    return `${base}${n}`;
  };

  const openTableCtxMenu = (e: React.MouseEvent, dbName: string, tableName: string) => {
    e.preventDefault();
    e.stopPropagation();
    const margin = 8;
    const menuW = 160;
    const menuH = 130;
    const nx = Math.min(e.clientX, window.innerWidth - menuW - margin);
    const ny = Math.min(e.clientY, window.innerHeight - menuH - margin);
    setTableCtxMenu({ x: Math.max(margin, nx), y: Math.max(margin, ny), dbName, tableName });
  };

  useEffect(() => {
    if (!tableCtxMenu) return;
    const close = () => setTableCtxMenu(null);
    const t = window.setTimeout(() => {
      document.addEventListener("click", close);
      document.addEventListener("contextmenu", close);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [tableCtxMenu]);

  const handleViewTableSchema = async (dbName: string, tableName: string) => {
    if (!activeConnectionId) return;
    setTableSchemaModal({ dbName, tableName, schema: null, loading: true });
    try {
      const schema = await getOrFetchTableSchema(activeConnectionId, dbName, tableName, sqlDialect);
      setTableSchemaModal((prev) => (prev ? { ...prev, schema, loading: false } : null));
    } catch (e) {
      setTableSchemaModal((prev) => (prev ? { ...prev, loading: false } : null));
      showAppMessage({ variant: "error", title: "获取表结构失败", message: String(e) });
    }
  };

  const execTableSql = async (dbName: string, tableName: string, sql: string, timeoutMs = 60000) => {
    if (!activeConnectionId) return;
    startTableOp(dbName, tableName);
    try {
      await api.executeSQL({
        connectionId: activeConnectionId,
        database: dbName,
        sql,
        mode: "single",
        rowLimit: -1,
        pageOffset: 0,
        pageLimit: 100,
        timeoutMs,
        requestId: createRequestId(),
      });
    } finally {
      endTableOp(dbName, tableName);
    }
  };

  const handleDropTable = async () => {
    const m = tableConfirmModal;
    if (!m) return;
    setTableConfirmModal(null);
    const { dbName, tableName } = m;
    const tableRef = quoteSqlIdentifier(tableName, sqlDialect);
    try {
      await execTableSql(dbName, tableName, `DROP TABLE ${tableRef};`);
      void loadTablesForDB(dbName);
      showAppMessage({ variant: "success", title: "删除成功", message: `表 ${tableName} 已删除` });
    } catch (e) {
      showAppMessage({ variant: "error", title: "删除失败", message: String(e) });
    }
  };

  const handleTruncateTable = async () => {
    const m = tableConfirmModal;
    if (!m) return;
    setTableConfirmModal(null);
    const { dbName, tableName } = m;
    const tableRef = quoteSqlIdentifier(tableName, sqlDialect);
    try {
      await execTableSql(dbName, tableName, `TRUNCATE TABLE ${tableRef};`);
      showAppMessage({ variant: "success", title: "清空成功", message: `表 ${tableName} 已清空` });
    } catch (e) {
      showAppMessage({ variant: "error", title: "清空失败", message: String(e) });
    }
  };

  const handleCopyTable = async () => {
    if (!tableCopyModal || !activeConnectionId) return;
    const { dbName, tableName, newName } = tableCopyModal;
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    setTableCopyModal((prev) => (prev ? { ...prev, running: true, error: "" } : null));
    const srcRef = quoteSqlIdentifier(tableName, sqlDialect);
    const dstRef = quoteSqlIdentifier(trimmedName, sqlDialect);
    const copySql =
      sqlDialect === "postgres"
        ? `CREATE TABLE ${dstRef} AS SELECT * FROM ${srcRef};`
        : `CREATE TABLE ${dstRef} SELECT * FROM ${srcRef};`;
    startTableOp(dbName, tableName);
    try {
      await api.executeSQL({
        connectionId: activeConnectionId,
        database: dbName,
        sql: copySql,
        mode: "single",
        rowLimit: -1,
        pageOffset: 0,
        pageLimit: 100,
        timeoutMs: 120000,
        requestId: createRequestId(),
      });
      setTableCopyModal(null);
      void loadTablesForDB(dbName);
      showAppMessage({ variant: "success", title: "复制成功", message: `表 ${tableName} 已复制为 ${trimmedName}` });
    } catch (e) {
      setTableCopyModal((prev) => (prev ? { ...prev, running: false, error: String(e) } : null));
    } finally {
      endTableOp(dbName, tableName);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────

  const loadSqlResultPage = async (tabId: string, requestId: string, page: number, limit: number) => {
    if (!activeConnectionId) return;
    const connectionId = activeConnectionId;
    const dbName = selectedDatabase;
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(100, limit || CLIENT_GRID_PAGE_SIZE);
    const offset = (safePage - 1) * safeLimit;
    updateTabById(connectionId, dbName, tabId, (tab) => ({
      ...tab,
      sqlResultLoading: true,
    }));
    try {
      const pageResult = await api.querySQLResultPage({ requestId, offset, limit: safeLimit });
      updateTabById(connectionId, dbName, tabId, (tab) => {
        if (tab.sqlResultRequestId !== requestId) return tab;
        const updatableSqlResult = Boolean(tab.contextTable && (tab.tablePrimaryKey?.length ?? 0) > 0);
        return {
          ...tab,
          result: {
            ...(tab.result ?? {
              rowsAffected: 0,
              lastInsertId: 0,
              message: "",
              truncated: false,
              durationMs: pageResult.durationMs,
            }),
            columns: pageResult.columns,
            columnTypes: pageResult.columnTypes,
            rows: pageResult.rows,
            total: pageResult.total,
            offset: pageResult.offset,
            limit: pageResult.limit,
          },
          sqlGridPage: Math.floor(pageResult.offset / (pageResult.limit || safeLimit)) + 1,
          sqlResultTotal: pageResult.total,
          sqlResultOffset: pageResult.offset,
          sqlResultPageLimit: pageResult.limit,
          sqlResultLoading: false,
          tableEditOriginalRows: updatableSqlResult
            ? (pageResult.rows ?? []).map((row) => ({ ...(row as Record<string, unknown>) }))
            : undefined,
          tableEditDirtyRows: updatableSqlResult ? {} : undefined,
          error: "",
        };
      });
    } catch (e) {
      updateTabById(connectionId, dbName, tabId, (tab) =>
        tab.sqlResultRequestId === requestId ? { ...tab, sqlResultLoading: false, error: String(e) } : tab,
      );
    }
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
    const connectionId = activeConnectionId;
    const dbName = selectedDatabase;
    const tabId = activeTab.id;
    const requestId = createRequestId();
    beginSqlTabRequest(connectionId, dbName, tabId, requestId, trimmed);
    try {
      const [pageLimit, timeoutMs] = await Promise.all([resolveQueryLimit(), resolveQueryTimeout()]);
      const r = await api.executeSQL({
        connectionId,
        database: dbName,
        sql: trimmed,
        mode,
        rowLimit: -1,
        pageOffset: 0,
        pageLimit,
        timeoutMs,
        requestId,
      });
      let updatableTableName = "";
      let updatablePkCols: string[] | undefined;
      let updatableOriginalRows: Array<Record<string, unknown>> | undefined;
      if (mode === "single" && Array.isArray(r.rows)) {
        const tableRefs = extractReferencedCurrentDatabaseTables(trimmed, currentDatabaseTablesRef.current);
        if (tableRefs.length === 1) {
          const tableName = tableRefs[0];
          try {
            const schema = await getOrFetchTableSchema(connectionId, dbName, tableName, sqlDialect);
            const pkCols = (schema.primaryKey || []).filter(Boolean);
            const resultColumns =
              r.columns && r.columns.length > 0
                ? r.columns
                : Object.keys((r.rows[0] as Record<string, unknown> | undefined) ?? {});
            if (hasAllPrimaryKeysInColumns(pkCols, resultColumns)) {
              updatableTableName = tableName;
              updatablePkCols = pkCols;
              updatableOriginalRows = (r.rows as Array<Record<string, unknown>>).map((row) => ({ ...row }));
            }
          } catch {
            updatableTableName = "";
            updatablePkCols = undefined;
            updatableOriginalRows = undefined;
          }
        }
      }
      pushSqlHistory(trimmed);
      setHistoryRev((n) => n + 1);
      finishSqlTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
        ...tab,
        result: r,
        error: "",
        lastExecutedSql: trimmed,
        sqlGridPage: 1,
        sqlResultRequestId: r.rows ? requestId : "",
        sqlResultTotal: r.total,
        sqlResultOffset: r.offset,
        sqlResultPageLimit: r.limit || pageLimit,
        contextTable: updatableTableName,
        tablePrimaryKey: updatablePkCols,
        tableEditOriginalRows: updatableOriginalRows,
        tableEditDirtyRows: updatableTableName ? {} : undefined,
        tableEditPreviewOpen: false,
        tableEditPreviewLoading: false,
        tableEditPreviewStatements: undefined,
      }));
    } catch (e) {
      finishSqlTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
        ...tab,
        error: String(e),
        result: null,
        lastExecutedSql: trimmed,
        sqlResultRequestId: "",
        sqlResultTotal: undefined,
        sqlResultOffset: undefined,
        sqlResultPageLimit: undefined,
        contextTable: "",
        tablePrimaryKey: undefined,
        tableEditOriginalRows: undefined,
        tableEditDirtyRows: undefined,
      }));
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

  /** 停止当前正在执行的 SQL。 */
  const cancelCurrentQuery = async () => {
    if (!activeConnectionId || !activeTab?.runningRequestId) return;
    const connectionId = activeConnectionId;
    const dbName = selectedDatabase;
    const tabId = activeTab.id;
    const requestId = activeTab.runningRequestId;
    try {
      await api.cancelRunningQuery({ requestId });
    } catch (_) {
      // 忽略取消时的错误
    } finally {
      clearSqlTabRequest(connectionId, dbName, tabId, requestId);
    }
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

  useEffect(() => {
    const onGlobalShortcut = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const primary = e.ctrlKey || e.metaKey;
      if (!primary || e.altKey) return;

      if (e.shiftKey && key === "f") {
        e.preventDefault();
        e.stopPropagation();
        tableFilterInputRef.current?.focus();
        tableFilterInputRef.current?.select();
        return;
      }

      if (e.shiftKey) return;

      if (key === "q") {
        e.preventDefault();
        e.stopPropagation();
        addTab();
        return;
      }

      if (key === "w") {
        e.preventDefault();
        e.stopPropagation();
        if (activeTab) removeTab(activeTab.id);
      }
    };

    window.addEventListener("keydown", onGlobalShortcut, true);
    return () => window.removeEventListener("keydown", onGlobalShortcut, true);
  }, [activeTab, addTab, removeTab]);

  const historyEntries = useMemo(() => readSqlHistory(), [historyRev]);
  const filteredMigrationSourceTables = useMemo(() => {
    const keyword = migrationTableFilter.trim().toLowerCase();
    if (!keyword) return sourceTables;
    return sourceTables.filter((tableName) => tableName.toLowerCase().includes(keyword));
  }, [migrationTableFilter, sourceTables]);
  const migrationCompletedCount = migrationJob ? migrationJob.success + migrationJob.failed : 0;
  const migrationProgressPercent =
    migrationJob && migrationJob.total > 0 ? Math.round((migrationCompletedCount / migrationJob.total) * 100) : 0;

  const useHistorySql = (sql: string) => {
    setTabSQL(sql);
    setHistoryOpen(false);
  };

  const openMigrationPanel = () => {
    setSourceGroupId("");
    setSourceConnectionId("");
    setSourceDatabase("");
    setSourceDatabases([]);
    setSourceTables([]);
    setSelectedSourceTables([]);
    setTargetGroupId("");
    setTargetConnectionId("");
    setTargetDatabase("");
    setTargetDatabases([]);
    setTargetTables([]);
    setMigrationTableFilter("");
    setMigrationMsg("");
    setMigrationJob(null);
    setMigrationOpen(true);
  };

  const runMigration = async () => {
    if (!sourceConnectionId || !targetConnectionId || !sourceDatabase || !targetDatabase) {
      setMigrationMsg("请完整选择源连接、目标连接、源数据库和目标数据库");
      return;
    }
    if (sourceConnectionId === targetConnectionId && sourceDatabase === targetDatabase) {
      setMigrationMsg("源数据库和目标数据库不能相同，请选择不同的连接或数据库");
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

  const runMigrationBatch = async () => {
    if (!sourceConnectionId || !targetConnectionId || !sourceDatabase || !targetDatabase) {
      setMigrationMsg("请完整选择源连接、目标连接、源数据库和目标数据库");
      return;
    }
    if (sourceConnectionId === targetConnectionId && sourceDatabase === targetDatabase) {
      setMigrationMsg("源数据库和目标数据库不能相同，请选择不同的连接或数据库");
      return;
    }
    if (selectedSourceTables.length === 0) {
      setMigrationMsg("请至少选择一个要迁移的源表");
      return;
    }
    const srcConn = sourceGroupConnections.find((c) => c.id === sourceConnectionId);
    const tgtConn = targetGroupConnections.find((c) => c.id === targetConnectionId);
    migrationJobMetaRef.current = {
      sourceConnectionName: srcConn?.name ?? sourceConnectionId,
      sourceDatabase,
      targetConnectionName: tgtConn?.name ?? targetConnectionId,
      targetDatabase,
    };
    setMigrationBusy(true);
    setMigrationMsg("");
    setMigrationJob(null);
    try {
      const job = (await api.startDataMigration({
        sourceConnectionId,
        sourceDatabase,
        sourceSchema: "",
        sourceTables: selectedSourceTables,
        targetConnectionId,
        targetDatabase,
        targetSchema: "",
        truncateTarget,
        workerCount: migrationWorkerCount,
        batchSize: migrationBatchSize,
      })) as DataMigrationJobSnapshot;
      setMigrationJob(job);
      setMigrationOpen(false);
      setMigrationProgressOpen(true);
      setMigrationMsg(`迁移任务已启动，${job.workerCount} 个协程处理中`);
    } catch (e) {
      setMigrationMsg(String(e));
      setMigrationBusy(false);
    }
  };

  const cancelMigration = async () => {
    if (!migrationJob?.jobId) return;
    try {
      await api.cancelDataMigrationJob(migrationJob.jobId);
      const job = (await api.getDataMigrationJob(migrationJob.jobId)) as DataMigrationJobSnapshot;
      setMigrationJob(job);
      setMigrationMsg("迁移任务已取消");
    } catch (e) {
      setMigrationMsg(String(e));
    } finally {
      setMigrationBusy(false);
    }
  };

  const toggleSelectAllSourceTables = () => {
    setSelectedSourceTables((prev) => (prev.length === sourceTables.length ? [] : [...sourceTables]));
  };

  useEffect(() => {
    if (!migrationBusy || !migrationJob?.jobId) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const job = (await api.getDataMigrationJob(migrationJob.jobId)) as DataMigrationJobSnapshot;
        if (stopped) return;
        setMigrationJob(job);
        if (job.status !== "running") {
          window.clearInterval(timer);
          setMigrationBusy(false);
          const done = job.success + job.failed;
          setMigrationMsg(
            job.failed > 0
              ? `迁移完成：${done}/${job.total}，成功 ${job.success}，失败 ${job.failed}`
              : `迁移完成：成功 ${job.success}/${job.total}`,
          );
          const meta = migrationJobMetaRef.current;
          if (meta) {
            const entry: MigrationHistoryEntry = {
              ...job,
              sourceConnectionName: meta.sourceConnectionName,
              sourceDatabase: meta.sourceDatabase,
              targetConnectionName: meta.targetConnectionName,
              targetDatabase: meta.targetDatabase,
            };
            setMigrationHistory((prev) => [entry, ...prev]);
          }
        }
      } catch (e) {
        if (stopped) return;
        window.clearInterval(timer);
        setMigrationBusy(false);
        setMigrationMsg(String(e));
      }
    }, 800);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [migrationBusy, migrationJob?.jobId]);

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
    const connectionId = activeConnectionId;
    const dbName = selectedDatabase;
    const tabId = activeTab.id;
    const requestId = createRequestId();
    beginSqlTabRequest(connectionId, dbName, tabId, requestId, trimmed);
    try {
      const explainSql = `EXPLAIN ${trimmed}`;
      const timeoutMs = await resolveQueryTimeout();
      const r = await api.explainSQL({ connectionId, database: dbName, sql: trimmed, requestId, timeoutMs });
      finishSqlTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
        ...tab,
        result: r,
        error: "",
        lastExecutedSql: explainSql,
      }));
    } catch (e) {
      finishSqlTabRequest(connectionId, dbName, tabId, requestId, (tab) => ({
        ...tab,
        error: String(e),
        result: null,
      }));
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openAiAssistRef.current());
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

          if (ctx.connectionId && ctx.database) {
            const cursorOffset = model.getOffsetAt(position);
            const textBeforeCursor = model.getValue().slice(0, cursorOffset);
            const currentFragment = textBeforeCursor.slice(textBeforeCursor.lastIndexOf(";") + 1);
            const referencedTables = extractReferencedCurrentDatabaseTables(
              currentFragment,
              currentDatabaseTablesRef.current,
            );

            if (referencedTables.length > 0) {
              const tableColumns: Array<{ tableName: string; columns: TableSchema["columns"] }> = [];
              for (const tableName of referencedTables) {
                const schemaName = ctx.dialect === "postgres" ? "public" : "";
                const cacheKey = `${ctx.connectionId}|${ctx.database}|${schemaName}|${tableName}`;
                let schema = tableSchemaCacheRef.current.get(cacheKey);
                if (!schema) {
                  try {
                    schema = (await api.getTableSchema({
                      connectionId: ctx.connectionId,
                      database: ctx.database,
                      schema: schemaName,
                      table: tableName,
                    })) as TableSchema;
                    tableSchemaCacheRef.current.set(cacheKey, schema);
                  } catch {
                    schema = undefined;
                  }
                }
                if (schema?.columns?.length) {
                  tableColumns.push({ tableName, columns: schema.columns });
                }
              }

              if (tableColumns.length > 0) {
                return {
                  suggestions: mergeContextTableColumnCompletionItems(monaco, range, tableColumns, keywords),
                };
              }
            }
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
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <div ref={menuRef} className="relative shrink-0">
              <button
                className="tf-btn-icon"
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
                      openMigrationPanel();
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
              className="tf-btn-toolbar shrink-0 gap-1 text-[11px] font-medium shadow-sm"
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
                      <span className="w-3.5 shrink-0 select-none text-[13px] leading-none text-slate-400">
                        {expanded ? "▾" : "▸"}
                      </span>
                      <Database className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-base font-medium text-slate-800">
                        {db.name}
                      </span>
                    </button>
                    {expanded && (
                      <div className="ml-4 border-l border-slate-200/80 pl-3.5 pt-0.5">
                        {db.visibleTables.length === 0 && (
                          <div className="py-px pl-0.5 text-[13px] text-slate-400">
                            {filterQ && db.loaded && db.tables.length > 0 ? "无匹配" : "暂无表"}
                          </div>
                        )}
                        {db.visibleTables.map((tableName) => {
                          const opRunning = isTableOpRunning(db.name, tableName);
                          return (
                            <button
                              key={`${db.name}.${tableName}`}
                              type="button"
                              title={opRunning ? `${tableName} · 正在执行…` : `${tableName} · 双击打开 / 右键操作`}
                              className={`mb-px flex w-full min-w-0 items-center gap-1 rounded-sm py-px pl-0.5 pr-1 text-left font-mono text-[12px] font-normal text-slate-700 hover:bg-slate-50 ${opRunning ? "opacity-60" : ""}`}
                              onDoubleClick={() => !opRunning && appendSelectSQL(db.name, tableName)}
                              onContextMenu={(e) => !opRunning && openTableCtxMenu(e, db.name, tableName)}
                            >
                              {opRunning ? (
                                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-blue-400" strokeWidth={2} aria-hidden />
                              ) : (
                                <Table2 className="h-2.5 w-2.5 shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
                              )}
                              <span className="min-w-0 flex-1 truncate">{tableName}</span>
                              {opRunning && <span className="shrink-0 text-[10px] text-blue-400">执行中</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="shrink-0 border-t border-slate-200 px-1.5 py-1">
            <input
              ref={tableFilterInputRef}
              className="h-5 w-full rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[9px] leading-tight text-slate-800 outline-none ring-blue-500/30 focus:border-blue-300 focus:ring-2 placeholder:text-slate-400"
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
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5">
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
                className="tf-control tf-control-sm max-w-[140px] text-slate-700"
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
              <span className="truncate text-[15px] text-slate-500" title={selectedDatabase || undefined}>
                {selectedDatabase ? `当前库 · ${selectedDatabase}` : "未选库"}
              </span>
              <button
                type="button"
                className="tf-btn-icon tf-btn-icon-bordered"
                onClick={() => void reloadDbTree()}
                disabled={!activeConnectionId}
                title="刷新对象树"
              >
                <RefreshCw className="h-4 w-4" strokeWidth={2} />
              </button>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="hidden text-[11px] text-slate-400 lg:inline">Ctrl+K AI · Ctrl+R 执行当前语句</span>
                <button type="button" className="tf-btn-toolbar" onClick={addTab}>
                  新标签
                </button>
                <button
                  type="button"
                  className="tf-btn-toolbar gap-1"
                  onClick={() => setHistoryOpen(true)}
                  title="历史执行 SQL"
                >
                  <History className="h-3.5 w-3.5" strokeWidth={2} />
                  历史
                </button>
                <button
                  type="button"
                  className="tf-btn-icon tf-btn-icon-bordered"
                  title="设置"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            </header>

            <div className="tf-studio-tab-strip flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-slate-200 bg-slate-100/90 px-0.5">
              {visibleTabs.map((t) => {
                const isActive = t.id === activeTab?.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={t.title}
                    className={`group/tab inline-flex h-8 min-w-0 max-w-[min(220px,32vw)] items-center gap-0.5 rounded-sm border px-1 text-left text-[13px] leading-none ${
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
                {/* 编辑器上方工具栏 */}
                <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 py-1">
                  <button
                    type="button"
                    className="tf-btn-icon tf-btn-toolbar-play"
                    onClick={() => void runUnifiedSQL()}
                    disabled={!activeConnectionId || (activeTab?.sqlResultLoading ?? false)}
                    title="执行选中或全文；多条语句时仅显示执行摘要"
                  >
                    <Play className="h-4 w-4" fill="currentColor" strokeWidth={0} />
                  </button>
                  <button
                    type="button"
                    className="tf-btn-icon"
                    onClick={() => void cancelCurrentQuery()}
                    disabled={!(activeTab?.sqlResultLoading ?? false)}
                    title="停止当前 SQL 执行"
                    style={{ color: (activeTab?.sqlResultLoading ?? false) ? "rgb(220 38 38)" : undefined }}
                  >
                    <Square className="h-4 w-4" fill="currentColor" strokeWidth={0} />
                  </button>
                  <button
                    type="button"
                    className="tf-btn-toolbar"
                    onClick={() => void explain()}
                    disabled={!activeConnectionId || (activeTab?.sqlResultLoading ?? false)}
                    title="EXPLAIN 选中或全文"
                  >
                    计划
                  </button>
                </div>
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
                    executeDisabled={!activeConnectionId || (activeTab?.sqlResultLoading ?? false)}
                    onExecuteStatement={(sql) => void executeSqlForActiveTab(sql, "single")}
                    runningSQL={activeTab?.runningSQL}
                    onStopStatement={() => void cancelCurrentQuery()}
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
                  {activeTabError && <p className="text-xs text-red-600">{activeTabError}</p>}
                  {(activeTab?.sqlResultLoading ?? false) && !activeTabResult ? (
                    <div className="flex min-h-[200px] flex-1 flex-col items-center justify-center gap-2 rounded-tf border border-dashed border-slate-200 bg-white/60">
                      <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                      <span className="text-[11px] text-slate-500">正在执行 SQL…</span>
                    </div>
                  ) : null}
                  {activeTabResult && (
                    <>
                      {activeTabResult.execLog && activeTabResult.execLog.length > 0 ? (
                        <div className="relative min-h-0 flex-1">
                          {(activeTab?.sqlResultLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">正在执行 SQL…</span>
                            </div>
                          )}
                          <p className="shrink-0 text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                          <pre className="max-h-[min(320px,50vh)] min-h-0 flex-1 overflow-auto rounded-tf border border-slate-200 bg-white p-2 text-[11px] text-slate-700">
                            {activeTabResult.execLog.join("\n")}
                          </pre>
                        </div>
                      ) : activeTabResult.rows && activeTabResult.rows.length > 0 ? (
                        <div className="result-content relative min-h-0 min-w-0 flex-1 overflow-hidden">
                          {(activeTab?.sqlResultLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">正在执行 SQL…</span>
                            </div>
                          )}
                          {(() => {
                            const rows = (activeTabResult.rows as Array<Record<string, unknown>>) ?? [];
                            const page = Math.max(1, activeTab?.sqlGridPage ?? 1);
                            const pageLimit = Math.max(1, activeTab?.sqlResultPageLimit ?? activeTabResult.limit ?? CLIENT_GRID_PAGE_SIZE);
                            const totalRows = activeTab?.sqlResultTotal ?? activeTabResult.total ?? rows.length;
                            const totalPages = Math.max(1, Math.ceil(totalRows / pageLimit));
                            const safePage = Math.min(page, totalPages);
                            const start = activeTab?.sqlResultOffset ?? activeTabResult.offset ?? (safePage - 1) * pageLimit;
                            const pageRows = rows;
                            const busy = activeTab?.sqlResultLoading ?? false;
                            const cacheRequestId = activeTab?.sqlResultRequestId ?? "";
                            const sqlPkCols = activeTab?.tablePrimaryKey ?? [];
                            const hasSqlPk = sqlPkCols.length > 0;
                            const sqlDirtyMap = activeTab?.tableEditDirtyRows ?? {};
                            const hasSqlDirty = Object.keys(sqlDirtyMap).some((k) => {
                              const patch = sqlDirtyMap[Number(k)];
                              return patch && Object.keys(patch).length > 0;
                            });
                            const canUpdateSqlResult = Boolean(activeTab?.contextTable && hasSqlPk);
                            return (
                              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                <div className="flex shrink-0 items-start justify-between gap-2 border-b border-slate-200/90 bg-slate-50/80 px-3 py-1.5">
                                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                    <div className="flex shrink-0 items-center gap-1">
                                      <button
                                        type="button"
                                        className="tf-btn-icon-lg tf-btn-icon-bordered text-emerald-600"
                                        disabled={!canUpdateSqlResult || !hasSqlDirty || busy || activeTab?.tableEditPreviewLoading}
                                        title={
                                          !canUpdateSqlResult
                                            ? "仅支持单表查询且结果包含完整主键时更新"
                                            : !hasSqlDirty
                                              ? "没有未提交的修改"
                                              : "预览并提交更新"
                                        }
                                        aria-label="执行"
                                        onClick={() => void handleTableOpenPreview()}
                                      >
                                        <Check className="h-4 w-4" strokeWidth={2.5} />
                                      </button>
                                      <button
                                        type="button"
                                        className="tf-btn-icon-lg tf-btn-icon-bordered text-slate-500"
                                        disabled={!hasSqlDirty || busy}
                                        title={hasSqlDirty ? "撤销未提交的修改" : "没有未提交的修改"}
                                        aria-label="取消"
                                        onClick={() => handleTableCancelEdit()}
                                      >
                                        <XCircle className="h-4 w-4" strokeWidth={2.5} />
                                      </button>
                                    </div>
                                    <div className="min-w-0 pt-0.5 font-mono text-[13px] text-slate-600">
                                      <span className="text-slate-400">结果</span>{" "}
                                      <span className="text-[11px] tabular-nums text-slate-500">
                                        {totalRows > pageLimit ? `${safePage} / ${totalPages} · ` : ""}
                                        {rows.length}/{totalRows}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                    {totalRows > pageLimit ? (
                                      <>
                                        <button
                                          type="button"
                                          aria-label="上一页"
                                          aria-disabled={safePage <= 1 || busy}
                                          title={busy ? "加载中…" : safePage <= 1 ? "已是第一页" : "上一页"}
                                          onClick={() => {
                                            if (busy || !activeTab || !cacheRequestId) return;
                                            void loadSqlResultPage(activeTab.id, cacheRequestId, Math.max(1, safePage - 1), pageLimit);
                                          }}
                                          className="tf-btn-icon-lg tf-btn-icon-bordered"
                                          disabled={safePage <= 1 || busy}
                                        >
                                          <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
                                        </button>
                                        <button
                                          type="button"
                                          aria-label="下一页"
                                          aria-disabled={safePage >= totalPages || busy}
                                          title={busy ? "加载中…" : safePage >= totalPages ? "已是最后一页" : "下一页"}
                                          onClick={() => {
                                            if (busy || !activeTab || !cacheRequestId) return;
                                            void loadSqlResultPage(activeTab.id, cacheRequestId, Math.min(totalPages, safePage + 1), pageLimit);
                                          }}
                                          className="tf-btn-icon-lg tf-btn-icon-bordered"
                                          disabled={safePage >= totalPages || busy}
                                        >
                                          <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
                                        </button>
                                      </>
                                    ) : null}
                                    <button
                                      type="button"
                                      aria-label="刷新"
                                      title="刷新"
                                      disabled={!activeConnectionId || busy}
                                      className="tf-btn-icon-lg tf-btn-icon-bordered"
                                      onClick={() => {
                                        if (!activeConnectionId || !activeTab) return;
                                        void executeSqlForActiveTab(activeTab.sql, "single");
                                      }}
                                    >
                                      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} strokeWidth={2} />
                                    </button>
                                  </div>
                                </div>
                                <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                                  <VirtualResultGrid
                                    columns={activeTabResult.columns ?? Object.keys(activeTabResult.rows[0] ?? {})}
                                    columnTypes={activeTabResult.columnTypes}
                                    rows={pageRows}
                                    displayTimezone={displayTimezone}
                                    onCopyError={(msg) => setError(msg)}
                                    serverMode
                                    rowNumberStart={start + 1}
                                    editable={canUpdateSqlResult}
                                    primaryKeyColumns={sqlPkCols}
                                    onCellValueChange={handleTableCellEdit}
                                    dirtyFields={activeTab?.tableEditDirtyRows}
                                    tableContext={
                                      activeConnectionId && activeTab?.contextTable
                                        ? {
                                            connectionId: activeConnectionId,
                                            database: activeTab.contextDb || selectedDatabase,
                                            schema: sqlDialect === "postgres" ? "public" : "",
                                            table: activeTab.contextTable,
                                          }
                                        : undefined
                                    }
                                  />
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div className="relative min-h-0 flex-1">
                          {(activeTab?.sqlResultLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">正在执行 SQL…</span>
                            </div>
                          )}
                          <p className="text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </>
            )}

            {activeTab?.type === "table" && (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {(() => {
                  const pkCols = activeTab.tablePrimaryKey ?? [];
                  const hasPk = pkCols.length > 0;
                  const dirtyMap = activeTab.tableEditDirtyRows ?? {};
                  const hasDirty = Object.keys(dirtyMap).some((k) => {
                    const p = dirtyMap[Number(k)];
                    return p && Object.keys(p).length > 0;
                  });
                  const tBusy = activeTab.tableQueryLoading ?? false;
                  const off = activeTab.tableOffset ?? 0;
                  const lim = activeTab.tablePageLimit ?? 5000;
                  const total = activeTab.tableTotal ?? 0;
                  const showPager =
                    activeTab.tableTotal != null &&
                    activeTab.tablePageLimit != null &&
                    activeTab.tableTotal > activeTab.tablePageLimit;
                  const prevDisabled = off <= 0 || tBusy;
                  const nextDisabled = tBusy || off + lim >= total;
                  return (
                    <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-slate-200/90 bg-slate-50/80 px-3 py-1.5">
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            className="tf-btn-icon-lg tf-btn-icon-bordered text-emerald-600"
                            disabled={!hasPk || !hasDirty || tBusy || activeTab.tableEditPreviewLoading}
                            title={
                              !hasPk
                                ? "无主键信息，无法更新"
                                : !hasDirty
                                  ? "没有未提交的修改"
                                  : "预览并提交更新"
                            }
                            aria-label="执行"
                            onClick={() => void handleTableOpenPreview()}
                          >
                            <Check className="h-4 w-4" strokeWidth={2.5} />
                          </button>
                          <button
                            type="button"
                            className="tf-btn-icon-lg tf-btn-icon-bordered text-slate-500"
                            disabled={!hasDirty || tBusy}
                            title={hasDirty ? "撤销未提交的修改" : "没有未提交的修改"}
                            aria-label="取消"
                            onClick={() => handleTableCancelEdit()}
                          >
                            <XCircle className="h-4 w-4" strokeWidth={2.5} />
                          </button>
                        </div>
                        <div className="min-w-0 pt-0.5 font-mono text-[13px] text-slate-600">
                          <span className="text-slate-400">表</span>{" "}
                          <span className="font-medium text-slate-800" title={activeTab.contextTable}>
                            {activeTab.contextTable}
                          </span>
                          {activeTab.contextDb ? (
                            <span className="text-slate-400"> · {activeTab.contextDb}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        {showPager ? (
                          <>
                            <button
                              type="button"
                              aria-label="上一页"
                              aria-disabled={prevDisabled}
                              title={tBusy ? "加载中…" : off <= 0 ? "已是第一页" : "上一页"}
                              onClick={() => {
                                if (prevDisabled || !activeTab.contextTable) return;
                                void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
                                  offset: Math.max(0, off - lim),
                                  orderBy: activeTab.tableSortColumn ?? "",
                                  orderDesc: activeTab.tableSortDesc ?? false,
                                });
                              }}
                              className="tf-btn-icon-lg tf-btn-icon-bordered"
                              disabled={prevDisabled}
                            >
                              <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                            <span className="text-[11px] tabular-nums text-slate-500">
                              {Math.floor(off / (lim || 1)) + 1} / {Math.max(1, Math.ceil(total / (lim || 1)))} · {lim}/
                              {total}
                            </span>
                            <button
                              type="button"
                              aria-label="下一页"
                              aria-disabled={nextDisabled}
                              title={tBusy ? "加载中…" : off + lim >= total ? "已是最后一页" : "下一页"}
                              onClick={() => {
                                if (nextDisabled || !activeTab.contextTable) return;
                                void runTablePageQuery(activeTab.id, activeTab.contextDb, activeTab.contextTable, {
                                  offset: off + lim,
                                  orderBy: activeTab.tableSortColumn ?? "",
                                  orderDesc: activeTab.tableSortDesc ?? false,
                                });
                              }}
                              className="tf-btn-icon-lg tf-btn-icon-bordered"
                              disabled={nextDisabled}
                            >
                              <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          aria-label="刷新当前页"
                          title="刷新"
                          disabled={!activeTab.contextTable || tBusy}
                          className="tf-btn-icon-lg tf-btn-icon-bordered"
                          onClick={() => refreshActiveTableTab()}
                        >
                          <RefreshCw className={`h-4 w-4 ${tBusy ? "animate-spin" : ""}`} strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  );
                })()}
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
                  {activeTabError && <p className="text-xs text-red-600">{activeTabError}</p>}
                  {(activeTab.tableQueryLoading ?? false) && !activeTabResult ? (
                    <div className="flex min-h-[200px] flex-1 flex-col items-center justify-center gap-2 rounded-tf border border-dashed border-slate-200 bg-white/60">
                      <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                      <span className="text-[11px] text-slate-500">加载表数据…</span>
                    </div>
                  ) : null}
                  {activeTabResult && (
                    <>
                      {activeTabResult.execLog && activeTabResult.execLog.length > 0 ? (
                        <div className="relative min-h-0 flex-1">
                          {(activeTab.tableQueryLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">加载表数据…</span>
                            </div>
                          )}
                          <p className="shrink-0 text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                          <pre className="max-h-32 overflow-auto rounded-tf border border-slate-200 bg-white p-2 text-[11px] text-slate-700">
                            {activeTabResult.execLog.join("\n")}
                          </pre>
                        </div>
                      ) : activeTabResult.columns && activeTabResult.columns.length > 0 ? (
                        <div className="result-content relative min-h-0 min-w-0 flex-1 overflow-hidden">
                          {(activeTab.tableQueryLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">加载表数据…</span>
                            </div>
                          )}
                          <VirtualResultGrid
                            columns={activeTabResult.columns}
                            columnTypes={activeTabResult.columnTypes}
                            rows={mergeTableRowsForDisplay(
                              (activeTab.tableEditOriginalRows ??
                                (activeTabResult.rows ?? [])) as Array<Record<string, unknown>>,
                              activeTab.tableEditDirtyRows,
                            )}
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
                            editable={(activeTab.tablePrimaryKey?.length ?? 0) > 0}
                            primaryKeyColumns={activeTab.tablePrimaryKey ?? []}
                            onCellValueChange={handleTableCellEdit}
                            dirtyFields={activeTab.tableEditDirtyRows}
                            tableContext={
                              activeConnectionId && activeTab.contextTable
                                ? {
                                    connectionId: activeConnectionId,
                                    database: activeTab.contextDb,
                                    schema: sqlDialect === "postgres" ? "public" : "",
                                    table: activeTab.contextTable,
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : (
                        <div className="relative min-h-0 flex-1">
                          {(activeTab.tableQueryLoading ?? false) && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-tf bg-white/80 backdrop-blur-[1px]">
                              <Loader2 className="h-7 w-7 animate-spin text-slate-400" strokeWidth={2} />
                              <span className="text-[11px] text-slate-500">加载表数据…</span>
                            </div>
                          )}
                          <p className="text-xs text-slate-600">
                            {activeTabResult.message}（{activeTabResult.durationMs}ms）
                          </p>
                        </div>
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

        {activeTab?.tableEditPreviewOpen
          ? createPortal(
              <div
                className="modal-mask"
                style={{ zIndex: 10002 }}
                role="presentation"
                onClick={() => {
                  if (activeTab.tableEditPreviewLoading || activeTab.tableEditApplyLoading) return;
                  handleTableClosePreview();
                }}
              >
                <div className="modal-panel large max-w-[min(96vw,720px)]" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-head">
                    <h3 className="text-sm font-medium text-slate-800">确认更新</h3>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className="btn ghost text-xs"
                        disabled={!activeTab.tableEditPreviewStatements?.length}
                        onClick={() => {
                          const text = (activeTab.tableEditPreviewStatements ?? []).join("\n\n");
                          void navigator.clipboard
                            .writeText(text)
                            .then(() =>
                              showAppMessage({ variant: "success", title: "复制成功", message: "SQL 已复制到剪贴板" }),
                            )
                            .catch(() => setError("复制失败"));
                        }}
                      >
                        复制全部
                      </button>
                    </div>
                  </div>
                  {activeTab.tableEditPreviewLoading ? (
                    <div className="flex min-h-[200px] items-center justify-center gap-2 py-8">
                      <Loader2 className="h-8 w-8 animate-spin text-slate-400" strokeWidth={2} />
                      <span className="text-sm text-slate-500">正在生成 SQL…</span>
                    </div>
                  ) : (
                    <textarea
                      readOnly
                      className="tf-scrollbar h-[min(50vh,420px)] w-full resize-y rounded border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-800"
                      value={(activeTab.tableEditPreviewStatements ?? []).join("\n\n")}
                      aria-label="待执行的 UPDATE 语句"
                    />
                  )}
                  <div className="mt-4 flex justify-end gap-2 border-t border-slate-200/80 pt-3">
                    <button
                      type="button"
                      className="btn ghost text-xs"
                      disabled={Boolean(activeTab.tableEditPreviewLoading || activeTab.tableEditApplyLoading)}
                      onClick={() => handleTableClosePreview()}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn text-xs"
                      disabled={
                        Boolean(activeTab.tableEditPreviewLoading || activeTab.tableEditApplyLoading) ||
                        !(activeTab.tableEditPreviewStatements && activeTab.tableEditPreviewStatements.length > 0)
                      }
                      onClick={() => void handleTableApplyPreview()}
                    >
                      {activeTab.tableEditApplyLoading ? "执行中…" : "确定"}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}

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

        {false && migrationOpen && (
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

        {migrationOpen && (
          <div className="modal-mask">
            <div className="modal-panel migration-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head migration-head">
                <div>
                  <h3>数据迁移</h3>
                  <p className="migration-subtitle">按表并发迁移数据，每个协程一次处理一张表。</p>
                </div>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setMigrationOpen(false);
                    if (migrationJob) setMigrationProgressOpen(true);
                  }}
                >
                  关闭
                </button>
              </div>

              <div className="migration-config">
                <label>
                  源分组
                  <select value={sourceGroupId} onChange={(e) => setSourceGroupId(e.target.value)} disabled={migrationBusy}>
                    <option value="">选择分组</option>
                    {allGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>
                  源连接
                  <select value={sourceConnectionId} onChange={(e) => setSourceConnectionId(e.target.value)} disabled={migrationBusy}>
                    <option value="">选择连接</option>
                    {sourceGroupConnections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label>
                  源数据库
                  <select value={sourceDatabase} onChange={(e) => setSourceDatabase(e.target.value)} disabled={!sourceConnectionId || migrationBusy}>
                    <option value="">选择数据库</option>
                    {sourceDatabases.map((db) => <option key={db} value={db}>{db}</option>)}
                  </select>
                </label>
                <label>
                  目标分组
                  <select value={targetGroupId} onChange={(e) => setTargetGroupId(e.target.value)} disabled={migrationBusy}>
                    <option value="">选择分组</option>
                    {allGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>
                  目标连接
                  <select value={targetConnectionId} onChange={(e) => setTargetConnectionId(e.target.value)} disabled={migrationBusy}>
                    <option value="">选择连接</option>
                    {targetGroupConnections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label>
                  目标数据库
                  <select value={targetDatabase} onChange={(e) => setTargetDatabase(e.target.value)} disabled={!targetConnectionId || migrationBusy}>
                    <option value="">选择数据库</option>
                    {targetDatabases.map((db) => <option key={db} value={db}>{db}</option>)}
                  </select>
                </label>
                <label>
                  协程数量
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={migrationWorkerCount}
                    onChange={(e) => setMigrationWorkerCount(Math.min(8, Math.max(1, Number(e.target.value) || 2)))}
                    disabled={migrationBusy}
                  />
                </label>
                <label>
                  批量行数
                  <select
                    value={migrationBatchSize}
                    onChange={(e) => setMigrationBatchSize(Number(e.target.value))}
                    disabled={migrationBusy}
                  >
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                  </select>
                </label>
                <label className="migration-check">
                  <input type="checkbox" checked={truncateTarget} onChange={(e) => setTruncateTarget(e.target.checked)} disabled={migrationBusy} />
                  迁移前清空目标表
                </label>
              </div>

              <div className="migration-picker-layout">
                <section className="migration-section">
                  <div className="migration-section-head">
                    <div>
                      <h4>源表</h4>
                      <span>{selectedSourceTables.length}/{sourceTables.length} 已选择</span>
                    </div>
                    <button className="btn ghost" type="button" onClick={toggleSelectAllSourceTables} disabled={sourceTables.length === 0 || migrationBusy}>
                      {selectedSourceTables.length === sourceTables.length && sourceTables.length > 0 ? "取消全选" : "全选"}
                    </button>
                  </div>
                  <input
                    className="migration-search"
                    value={migrationTableFilter}
                    onChange={(e) => setMigrationTableFilter(e.target.value)}
                    placeholder="搜索源表"
                    disabled={migrationBusy}
                  />
                  <div className="migration-table-list">
                    {filteredMigrationSourceTables.length === 0 ? (
                      <p className="sub">暂无可选源表</p>
                    ) : (
                      filteredMigrationSourceTables.map((tableName) => (
                        <label key={tableName} className="migration-table-option">
                          <input
                            type="checkbox"
                            checked={selectedSourceTables.includes(tableName)}
                            onChange={() => toggleSourceTable(tableName)}
                            disabled={migrationBusy}
                          />
                          <span>{tableName}</span>
                        </label>
                      ))
                    )}
                  </div>
                </section>

                <section className="migration-section">
                  <div className="migration-section-head">
                    <div>
                      <h4>目标表对照</h4>
                      <span>{targetTables.length} 张表</span>
                    </div>
                  </div>
                  <div className="migration-table-list target">
                    {targetTables.length === 0 ? (
                      <p className="sub">选择目标数据库后显示表列表</p>
                    ) : (
                      targetTables.map((tableName) => (
                        <div key={tableName} className="migration-table-option view">
                          <span>{tableName}</span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>

              <div className="migration-actions">
                <button className="btn" onClick={runMigrationBatch} disabled={migrationBusy || selectedSourceTables.length === 0}>
                  {migrationBusy ? "迁移中..." : "开始迁移"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setMigrationHistoryOpen(true)}
                >
                  查看迁移历史
                </button>
                <span className="sub">默认同名迁移到目标库，当前选择 {selectedSourceTables.length} 张表。</span>
              </div>
              {migrationMsg && <p className="migration-message">{migrationMsg}</p>}
            </div>
          </div>
        )}

        {migrationProgressOpen && migrationJob && (
          <div className="modal-mask">
            <div className="modal-panel migration-panel migration-progress-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head migration-head">
                <div>
                  <h3>迁移进度</h3>
                  <p className="migration-subtitle">任务已提交，当前窗口持续刷新每张表的迁移状态。</p>
                </div>
                <div className="migration-head-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => {
                      setMigrationProgressOpen(false);
                      setMigrationOpen(true);
                    }}
                    disabled={migrationBusy}
                  >
                    返回配置
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setMigrationProgressOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>

              <div className="migration-progress migration-progress-standalone">
                <div className="migration-progress-top">
                  <strong>{migrationProgressPercent}%</strong>
                  <span>
                    已完成 {migrationCompletedCount}/{migrationJob.total}，成功 {migrationJob.success}，失败 {migrationJob.failed}，运行中 {migrationJob.running}
                  </span>
                </div>
                {(migrationJob.startedAt || migrationJob.endedAt) && (
                  <div className="migration-time-info">
                    {migrationJob.startedAt && <span>开始：{formatMigrationTime(migrationJob.startedAt)}</span>}
                    {migrationJob.endedAt && <span>结束：{formatMigrationTime(migrationJob.endedAt)}</span>}
                  </div>
                )}
                <div className="migration-progress-bar">
                  <span style={{ width: `${migrationProgressPercent}%` }} />
                </div>
                <div className="migration-status-table migration-status-table-wide">
                  <div className="migration-status-row head migration-status-row-wide">
                    <span>表名</span>
                    <span>状态</span>
                    <span>行数</span>
                    <span>开始时间</span>
                    <span>结束时间</span>
                    <span>信息</span>
                  </div>
                  {migrationJob.tables.map((table) => (
                    <div key={table.table} className={`migration-status-row migration-status-row-wide ${table.status}`}>
                      <span title={table.table}>{table.table}</span>
                      <span>{migrationStatusLabel(table.status)}</span>
                      <span>{table.migratedRows || "-"}</span>
                      <span>{table.startedAt ? formatMigrationTime(table.startedAt) : "-"}</span>
                      <span>{table.endedAt ? formatMigrationTime(table.endedAt) : "-"}</span>
                      <span title={table.error || table.message}>{table.error || table.message || "-"}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="migration-actions">
                <button className="btn ghost" onClick={cancelMigration} disabled={!migrationBusy || !migrationJob?.jobId}>
                  取消任务
                </button>
                {migrationMsg && <p className="migration-message">{migrationMsg}</p>}
              </div>
            </div>
          </div>
        )}

        {migrationHistoryOpen && (
          <div className="modal-mask">
            <div className="modal-panel migration-panel migration-history-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head migration-head">
                <div>
                  <h3>迁移历史</h3>
                  <p className="migration-subtitle">当前会话内已完成的迁移任务记录。</p>
                </div>
                <button className="btn ghost" type="button" onClick={() => { setMigrationHistoryOpen(false); setMigrationHistoryDetail(null); }}>
                  关闭
                </button>
              </div>

              {migrationHistoryDetail ? (
                <div className="migration-history-detail">
                  <div className="migration-history-detail-head">
                    <button className="btn ghost" type="button" onClick={() => setMigrationHistoryDetail(null)}>← 返回列表</button>
                    <div className="migration-history-meta">
                      <span>{migrationHistoryDetail.sourceConnectionName} / {migrationHistoryDetail.sourceDatabase}</span>
                      <span className="migration-history-arrow">→</span>
                      <span>{migrationHistoryDetail.targetConnectionName} / {migrationHistoryDetail.targetDatabase}</span>
                    </div>
                  </div>
                  <div className="migration-progress">
                    <div className="migration-progress-top">
                      <strong className={`migration-badge migration-badge-${migrationHistoryDetail.status}`}>
                        {migrationStatusLabel(migrationHistoryDetail.status)}
                      </strong>
                      <span>
                        共 {migrationHistoryDetail.total} 张表，成功 {migrationHistoryDetail.success}，失败 {migrationHistoryDetail.failed}
                      </span>
                    </div>
                    <div className="migration-time-info">
                      {migrationHistoryDetail.startedAt && <span>开始：{formatMigrationTime(migrationHistoryDetail.startedAt)}</span>}
                      {migrationHistoryDetail.endedAt && <span>结束：{formatMigrationTime(migrationHistoryDetail.endedAt)}</span>}
                    </div>
                    <div className="migration-status-table migration-status-table-wide">
                      <div className="migration-status-row head migration-status-row-wide">
                        <span>表名</span>
                        <span>状态</span>
                        <span>行数</span>
                        <span>开始时间</span>
                        <span>结束时间</span>
                        <span>信息</span>
                      </div>
                      {migrationHistoryDetail.tables.map((table) => (
                        <div key={table.table} className={`migration-status-row migration-status-row-wide ${table.status}`}>
                          <span title={table.table}>{table.table}</span>
                          <span>{migrationStatusLabel(table.status)}</span>
                          <span>{table.migratedRows || "-"}</span>
                          <span>{table.startedAt ? formatMigrationTime(table.startedAt) : "-"}</span>
                          <span>{table.endedAt ? formatMigrationTime(table.endedAt) : "-"}</span>
                          <span title={table.error || table.message}>{table.error || table.message || "-"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : migrationHistory.length === 0 ? (
                <div className="migration-history-empty">
                  <p className="sub">暂无迁移历史记录，完成迁移后将在此展示。</p>
                </div>
              ) : (
                <div className="migration-history-list">
                  {migrationHistory.map((entry, idx) => (
                    <div key={`${entry.jobId}-${idx}`} className="migration-history-item">
                      <div className="migration-history-item-main">
                        <div className="migration-history-route">
                          <span className="migration-history-conn">{entry.sourceConnectionName}</span>
                          <span className="sub">/</span>
                          <span>{entry.sourceDatabase}</span>
                          <span className="migration-history-arrow">→</span>
                          <span className="migration-history-conn">{entry.targetConnectionName}</span>
                          <span className="sub">/</span>
                          <span>{entry.targetDatabase}</span>
                        </div>
                        <div className="migration-history-stats">
                          <span className={`migration-badge migration-badge-${entry.status}`}>
                            {migrationStatusLabel(entry.status)}
                          </span>
                          <span className="sub">{entry.total} 张表</span>
                          <span className="migration-history-count success">{entry.success} 成功</span>
                          {entry.failed > 0 && <span className="migration-history-count failed">{entry.failed} 失败</span>}
                        </div>
                      </div>
                      <div className="migration-history-item-footer">
                        <div className="migration-history-times">
                          {entry.startedAt && <span>开始 {formatMigrationTime(entry.startedAt)}</span>}
                          {entry.endedAt && <span>结束 {formatMigrationTime(entry.endedAt)}</span>}
                        </div>
                        <button className="btn ghost" type="button" onClick={() => setMigrationHistoryDetail(entry)}>
                          查看详情
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {/* 对象树表行右键菜单 */}
      {tableCtxMenu &&
        createPortal(
          (() => {
            const { x, y, dbName, tableName } = tableCtxMenu;
            const close = () => setTableCtxMenu(null);
            return (
              <div
                className="fixed z-[9999] min-w-[160px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-[12px] shadow-lg shadow-slate-900/15"
                style={{ left: x, top: y }}
                role="menu"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    close();
                    void handleViewTableSchema(dbName, tableName);
                  }}
                >
                  <SquareCode className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
                  查看表结构
                </button>
                <div className="my-1 h-px bg-slate-100" role="separator" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    close();
                    const existing = dbTree.find((d) => d.name === dbName)?.tables ?? [];
                    const newName = computeCopyName(tableName, existing);
                    setTableCopyModal({ dbName, tableName, newName, running: false, error: "" });
                  }}
                >
                  <Table2 className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} />
                  复制表
                </button>
                <div className="my-1 h-px bg-slate-100" role="separator" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-amber-600 hover:bg-amber-50"
                  onClick={() => {
                    close();
                    setTableConfirmModal({ type: "truncate", dbName, tableName });
                  }}
                >
                  <XCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                  清空表
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                  onClick={() => {
                    close();
                    setTableConfirmModal({ type: "drop", dbName, tableName });
                  }}
                >
                  <X className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                  删除表
                </button>
              </div>
            );
          })(),
          document.body,
        )}

      {/* 查看表结构弹窗 */}
      {tableSchemaModal &&
        createPortal(
          <div
            className="modal-mask"
            style={{ zIndex: 10010 }}
            role="presentation"
            onClick={() => !tableSchemaModal.loading && setTableSchemaModal(null)}
          >
            <div
              className="modal-panel max-w-[min(96vw,680px)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <span className="font-mono font-semibold text-slate-800">{tableSchemaModal.tableName}</span>
                <span className="ml-1.5 text-slate-400">· 表结构</span>
                <button
                  type="button"
                  className="tf-btn-icon ml-auto"
                  onClick={() => setTableSchemaModal(null)}
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <div className="modal-body min-h-[120px]">
                {tableSchemaModal.loading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                    <span className="text-[13px]">加载中…</span>
                  </div>
                ) : tableSchemaModal.schema ? (
                  <div className="overflow-auto">
                    {tableSchemaModal.schema.engine || tableSchemaModal.schema.charset ? (
                      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                        {tableSchemaModal.schema.engine && <span>引擎: {tableSchemaModal.schema.engine}</span>}
                        {tableSchemaModal.schema.charset && <span>字符集: {tableSchemaModal.schema.charset}</span>}
                        {tableSchemaModal.schema.collation && <span>排序规则: {tableSchemaModal.schema.collation}</span>}
                        {tableSchemaModal.schema.comment && <span>注释: {tableSchemaModal.schema.comment}</span>}
                      </div>
                    ) : null}
                    <table className="w-full border-collapse font-mono text-[12px]">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                          <th className="py-1 pr-3 font-medium">列名</th>
                          <th className="py-1 pr-3 font-medium">类型</th>
                          <th className="py-1 pr-3 font-medium">可空</th>
                          <th className="py-1 pr-3 font-medium">默认值</th>
                          <th className="py-1 pr-3 font-medium">键</th>
                          <th className="py-1 font-medium">注释</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableSchemaModal.schema.columns.map((col) => (
                          <tr key={col.name} className="border-b border-slate-100 text-slate-700 hover:bg-slate-50/60">
                            <td className="py-0.5 pr-3">
                              <span className={col.primaryKey ? "font-semibold text-blue-700" : ""}>{col.name}</span>
                            </td>
                            <td className="py-0.5 pr-3 text-slate-500">{col.type}</td>
                            <td className="py-0.5 pr-3 text-slate-400">{col.nullable ? "YES" : "NO"}</td>
                            <td className="py-0.5 pr-3 text-slate-400">{col.defaultValue || <span className="text-slate-300">—</span>}</td>
                            <td className="py-0.5 pr-3">
                              {col.primaryKey && <span className="rounded bg-blue-50 px-1 py-px text-[10px] text-blue-600">PK</span>}
                              {col.unique && !col.primaryKey && <span className="rounded bg-purple-50 px-1 py-px text-[10px] text-purple-600">UNI</span>}
                              {col.autoIncrement && <span className="ml-0.5 rounded bg-green-50 px-1 py-px text-[10px] text-green-600">AI</span>}
                            </td>
                            <td className="py-0.5 text-slate-400">{col.comment || <span className="text-slate-300">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="py-6 text-center text-[13px] text-slate-400">暂无结构数据</div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 危险操作确认弹窗 */}
      {tableConfirmModal &&
        createPortal(
          <div
            className="modal-mask"
            style={{ zIndex: 10010 }}
            role="presentation"
            onClick={() => setTableConfirmModal(null)}
          >
            <div
              className="modal-panel max-w-[min(96vw,400px)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <span className="font-semibold text-slate-800">
                  {tableConfirmModal.type === "drop" ? "删除表" : "清空表"}
                </span>
                <button
                  type="button"
                  className="tf-btn-icon ml-auto"
                  onClick={() => setTableConfirmModal(null)}
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <div className="modal-body text-[13px] text-slate-700">
                {tableConfirmModal.type === "drop" ? (
                  <>
                    确定要 <strong className="text-red-600">删除表</strong>{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono">{tableConfirmModal.tableName}</code> 吗？
                    <div className="mt-1.5 text-[12px] text-slate-400">此操作不可撤销，表结构和数据将永久丢失。</div>
                  </>
                ) : (
                  <>
                    确定要 <strong className="text-amber-600">清空表</strong>{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono">{tableConfirmModal.tableName}</code> 吗？
                    <div className="mt-1.5 text-[12px] text-slate-400">此操作将删除表内所有数据，但保留表结构。</div>
                  </>
                )}
              </div>
              <div className="modal-footer mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="tf-btn-toolbar"
                  onClick={() => setTableConfirmModal(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={tableConfirmModal.type === "drop" ? "tf-btn-primary bg-red-600 hover:bg-red-700" : "tf-btn-primary bg-amber-500 hover:bg-amber-600"}
                  onClick={() => {
                    if (tableConfirmModal.type === "drop") void handleDropTable();
                    else void handleTruncateTable();
                  }}
                >
                  {tableConfirmModal.type === "drop" ? "确认删除" : "确认清空"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 复制表弹窗 */}
      {tableCopyModal &&
        createPortal(
          <div
            className="modal-mask"
            style={{ zIndex: 10010 }}
            role="presentation"
            onClick={() => !tableCopyModal.running && setTableCopyModal(null)}
          >
            <div
              className="modal-panel max-w-[min(96vw,420px)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <span className="font-semibold text-slate-800">复制表</span>
                <button
                  type="button"
                  className="tf-btn-icon ml-auto"
                  onClick={() => !tableCopyModal.running && setTableCopyModal(null)}
                  aria-label="关闭"
                  disabled={tableCopyModal.running}
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <div className="modal-body space-y-3 text-[13px]">
                <div>
                  <div className="mb-0.5 text-slate-500">源表</div>
                  <div className="font-mono text-slate-700">{tableCopyModal.tableName}</div>
                </div>
                <div>
                  <label className="mb-1 block text-slate-500" htmlFor="copy-table-name">
                    新表名
                  </label>
                  <input
                    id="copy-table-name"
                    className="tf-control w-full font-mono"
                    value={tableCopyModal.newName}
                    disabled={tableCopyModal.running}
                    onChange={(e) =>
                      setTableCopyModal((prev) => (prev ? { ...prev, newName: e.target.value, error: "" } : null))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !tableCopyModal.running) void handleCopyTable();
                    }}
                    autoFocus
                  />
                </div>
                {tableCopyModal.error && (
                  <div className="rounded bg-red-50 px-2 py-1.5 text-[12px] text-red-600">{tableCopyModal.error}</div>
                )}
              </div>
              <div className="modal-footer mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="tf-btn-toolbar"
                  onClick={() => setTableCopyModal(null)}
                  disabled={tableCopyModal.running}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="tf-btn-primary flex items-center gap-1.5"
                  onClick={() => void handleCopyTable()}
                  disabled={tableCopyModal.running || !tableCopyModal.newName.trim()}
                >
                  {tableCopyModal.running && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
                  {tableCopyModal.running ? "执行中…" : "确认复制"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

type HeaderBounds = { x: number; y: number; width: number; height: number };

function migrationStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "running":
      return "迁移中";
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    default:
      return status || "-";
  }
}

function formatMigrationTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

function getDefaultColumnWidthByDbType(dbType: string | undefined): number {
  const fallbackWidth = 180;
  if (!dbType) return fallbackWidth;

  const t = dbType.toLowerCase().trim();
  if (!t) return fallbackWidth;

  // 数值列通常较短，默认更紧凑。
  if (/\b(tinyint|smallint|mediumint|int|integer|bigint|serial|year)\b/.test(t)) return 96;
  if (/\b(decimal|numeric|float|double|real|money)\b/.test(t)) return 112;

  // 仅需完整展示标准时间字符串（如 2026-04-15 10:30:59）。
  if (t.includes("timestamp") || t.includes("datetime")) return 128;
  if (/\b(date)\b/.test(t)) return 128;
  if (/\b(time|timetz)\b/.test(t)) return 128;

  if (/\b(bool|boolean|bit)\b/.test(t)) return 88;
  return fallbackWidth;
}

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
  editable = false,
  primaryKeyColumns = [],
  onCellValueChange,
  /** 行索引 → 已修改列名→值（仅用于背景高亮，与表编辑 dirty 一致） */
  dirtyFields,
  tableContext,
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
  editable?: boolean;
  primaryKeyColumns?: string[];
  onCellValueChange?: (rowIndex: number, columnName: string, value: unknown) => void;
  dirtyFields?: Record<number, Record<string, unknown>>;
  tableContext?: GridTableContext;
}) {
  const PAGE_SIZE = 10000;
  const [page, setPage] = useState(1);
  const [gridSize, setGridSize] = useState({ width: 900, height: 360 });
  const [gridSelection, setGridSelection] = useState<GridSelection>(() => createEmptyGridSelection());
  const [ctxMenu, setCtxMenu] = useState<GridContextMenuState | null>(null);
  const [sortMenu, setSortMenu] = useState<{ colIndex: number; bounds: HeaderBounds } | null>(null);
  const [cellDetail, setCellDetail] = useState<CellDetailState | null>(null);
  /** 列拖拽调整后的宽度；列集合变化时重置为默认 */
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const gridHostRef = useRef<HTMLDivElement | null>(null);
  const dataEditorRef = useRef<DataEditorRef | null>(null);
  const lastContextClientPosRef = useRef<{ x: number; y: number } | null>(null);
  /** glide-data-grid 在任意两次 mouseup 间隔 <500ms 都会设 isDoubleClick，不校验是否同一格；此处自行判定「同格双击」 */
  const lastCellPointerRef = useRef<{ col: number; row: number; at: number } | null>(null);

  const pkSet = useMemo(() => new Set(primaryKeyColumns ?? []), [primaryKeyColumns.join("|")]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, rows.length);
  const pageRows = serverMode ? rows : rows.slice(pageStart, pageEnd);
  const rowCount = pageRows.length;

  useEffect(() => {
    setPage(1);
  }, [rows, columns.join("|"), serverMode]);

  useEffect(() => {
    setGridSelection(createEmptyGridSelection());
  }, [columns.join("|"), rowCount, serverMode, safePage]);

  const columnsSig = columns.join("|");
  const typeSig = (columnTypes ?? []).join("|");
  const defaultColumnWidths = useMemo(
    () => columns.map((_, i) => getDefaultColumnWidthByDbType(columnTypes?.[i])),
    [columnsSig, typeSig],
  );
  const fallbackColWidth = 180;
  useEffect(() => {
    setColumnWidths(defaultColumnWidths);
  }, [columnsSig, typeSig, defaultColumnWidths]);

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
    return defaultColumnWidths;
  }, [columnsSig, columnWidths, columns.length, defaultColumnWidths]);

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
        rowIndex: r,
        colIndex: c,
        dbType: dbType ?? "",
        originalText: text,
        draftText: text,
        mode: "raw",
        error: "",
      });
    },
    [columns, columnTypes, pageRows, displayTimezone, markerStart],
  );

  const resolveSelectedIndexes = useCallback(
    (fallbackCell: Item) => {
      const rowSet = new Set<number>();
      const colSet = new Set<number>();
      const addRect = (rect: { x: number; y: number; width: number; height: number } | undefined) => {
        if (!rect) return;
        const startCol = Math.max(0, rect.x);
        const endCol = Math.min(columns.length, rect.x + rect.width);
        const startRow = Math.max(0, rect.y);
        const endRow = Math.min(rowCount, rect.y + rect.height);
        for (let c = startCol; c < endCol; c += 1) colSet.add(c);
        for (let r = startRow; r < endRow; r += 1) rowSet.add(r);
      };

      addRect(gridSelection.current?.range as { x: number; y: number; width: number; height: number } | undefined);
      for (const rect of gridSelection.current?.rangeStack ?? []) {
        addRect(rect as { x: number; y: number; width: number; height: number });
      }
      for (const rowIndex of gridSelection.rows.toArray()) {
        if (rowIndex >= 0 && rowIndex < rowCount) rowSet.add(rowIndex);
      }
      for (const colIndex of gridSelection.columns.toArray()) {
        if (colIndex >= 0 && colIndex < columns.length) colSet.add(colIndex);
      }

      if (rowSet.size === 0 && fallbackCell[1] >= 0 && fallbackCell[1] < rowCount) rowSet.add(fallbackCell[1]);
      if (colSet.size === 0 && fallbackCell[0] >= 0 && fallbackCell[0] < columns.length) colSet.add(fallbackCell[0]);

      return {
        rowIndexes: [...rowSet].sort((a, b) => a - b),
        colIndexes: [...colSet].sort((a, b) => a - b),
      };
    },
    [columns.length, gridSelection, rowCount],
  );

  const buildContextMenuContext = useCallback(
    (cell: Item): GridContextMenuContext => {
      const [colIndex, rowIndex] = cell;
      const { rowIndexes: selectedRowIndexes, colIndexes: selectedColumnIndexes } = resolveSelectedIndexes(cell);
      const rowData = rowIndex >= 0 ? pageRows[rowIndex] : undefined;
      const columnName = colIndex >= 0 && colIndex < columns.length ? columns[colIndex] : undefined;
      const isPrimaryKeyColumn = Boolean(columnName && pkSet.has(columnName));
      const selectedEditableColumnNames = selectedColumnIndexes
        .map((index) => columns[index])
        .filter((name): name is string => Boolean(name && !pkSet.has(name)));
      const canEditSelection = Boolean(
        editable && onCellValueChange && selectedRowIndexes.length > 0 && selectedEditableColumnNames.length > 0,
      );
      const isLongTextCell = Boolean(
        columnName && rowData && isExpandableLongTextColumnType(columnTypes?.[colIndex]),
      );
      const canCopyRowsAsInsert = Boolean(tableContext && selectedRowIndexes.length > 0);
      const canCopySelectionAsUpdate = Boolean(
        tableContext &&
          selectedRowIndexes.length > 0 &&
          selectedEditableColumnNames.length > 0 &&
          primaryKeyColumns.length > 0 &&
          (!columnName || !isPrimaryKeyColumn || selectedEditableColumnNames.length > 0),
      );
      return {
        cell,
        colIndex,
        rowIndex,
        columnName,
        rowData,
        selectedRowIndexes,
        selectedColumnIndexes,
        selectedEditableColumnNames,
        isLongTextCell,
        isPrimaryKeyColumn,
        canEditSelection,
        canCopyRowsAsInsert,
        canCopySelectionAsUpdate,
      };
    },
    [
      columns,
      columnTypes,
      editable,
      onCellValueChange,
      pageRows,
      pkSet,
      primaryKeyColumns.length,
      resolveSelectedIndexes,
      tableContext,
    ],
  );

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((name, i) => {
        const base: GridColumn = { title: name, id: name, width: resolvedColumnWidths[i] ?? fallbackColWidth };
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
        const next = prev.length === len ? [...prev] : [...defaultColumnWidths];
        next[colIndex] = newSize;
        return next;
      });
    },
    [columns, defaultColumnWidths],
  );

  const getCellContent = useMemo(() => {
    return ([col, row]: Item): GridCell => {
      const colName = columns[col];
      const raw = colName ? pageRows[row]?.[colName] : undefined;
      const isPk = Boolean(colName && pkSet.has(colName));
      const canEdit = Boolean(editable && onCellValueChange && colName && !isPk);
      const isDirtyCell = Boolean(
        colName && dirtyFields && dirtyFields[row] && Object.prototype.hasOwnProperty.call(dirtyFields[row], colName),
      );
      const dirtyTheme = isDirtyCell
        ? { bgCell: GRID_DIRTY_CELL_BG, bgCellMedium: GRID_DIRTY_CELL_BG_MEDIUM }
        : undefined;

      if (colName && (raw === null || raw === undefined)) {
        return {
          kind: GridCellKind.Text,
          allowOverlay: canEdit,
          readonly: !canEdit,
          displayData: "null",
          data: "null",
          themeOverride: {
            textDark: GRID_NULL_TEXT,
            textMedium: GRID_NULL_TEXT,
            textLight: GRID_NULL_TEXT,
            ...dirtyTheme,
          },
        };
      }
      const value = colName ? formatCellForTimezone(raw, colName, displayTimezone) : "";
      return {
        kind: GridCellKind.Text,
        allowOverlay: canEdit,
        readonly: !canEdit,
        displayData: value,
        data: value,
        themeOverride: dirtyTheme,
      };
    };
  }, [columns, pageRows, displayTimezone, editable, onCellValueChange, pkSet, dirtyFields]);

  const copySelection = async () => {
    try {
      await dataEditorRef.current?.emit("copy");
      showAppMessage({ variant: "success", title: "复制成功", message: "选中内容已复制到剪贴板" });
    } catch (e) {
      onCopyError(`复制失败: ${String(e)}`);
    }
  };

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showAppMessage({ variant: "success", title: "复制成功", message: "内容已复制到剪贴板" });
      } catch (e) {
        onCopyError(`复制失败: ${String(e)}`);
      }
    },
    [onCopyError],
  );

  const updateContextSelectionValue = useCallback(
    (value: unknown | ((rowIndex: number, columnName: string) => unknown)) => {
      const ctx = ctxMenu?.context;
      if (!ctx || !ctx.canEditSelection || !onCellValueChange) return;
      for (const rowIndex of ctx.selectedRowIndexes) {
        for (const columnName of ctx.selectedEditableColumnNames) {
          const nextValue = typeof value === "function" ? value(rowIndex, columnName) : value;
          onCellValueChange(rowIndex, columnName, nextValue);
        }
      }
    },
    [ctxMenu, onCellValueChange],
  );

  const copyContextRowsAsInsert = useCallback(async () => {
    const ctx = ctxMenu?.context;
    if (!tableContext || !ctx || ctx.selectedRowIndexes.length === 0) return;
    try {
      const result = await api.previewInsertRowsSQL(
        new PreviewInsertRowsRequest({
          connectionId: tableContext.connectionId,
          database: tableContext.database,
          schema: tableContext.schema,
          table: tableContext.table,
          columns,
          rows: ctx.selectedRowIndexes.map((rowIndex) =>
            Object.fromEntries(columns.map((name) => [name, pageRows[rowIndex]?.[name]])),
          ),
        }),
      );
      const sql = (result.statements ?? []).join("\n\n");
      if (!sql) throw new Error("未生成 INSERT 语句");
      await copyText(sql);
    } catch (e) {
      onCopyError(`复制 INSERT 语句失败: ${String(e)}`);
    }
  }, [columns, copyText, ctxMenu, onCopyError, pageRows, tableContext]);

  const copyContextSelectionAsUpdate = useCallback(async () => {
    const ctx = ctxMenu?.context;
    if (
      !ctx ||
      !tableContext ||
      primaryKeyColumns.length === 0 ||
      ctx.selectedRowIndexes.length === 0 ||
      ctx.selectedEditableColumnNames.length === 0
    ) {
      return;
    }
    try {
      const result = await api.previewUpdateRowsSQL(
        new UpdateRowsRequest({
          connectionId: tableContext.connectionId,
          database: tableContext.database,
          schema: tableContext.schema,
          table: tableContext.table,
          keyColumns: primaryKeyColumns,
          rows: ctx.selectedRowIndexes.map((rowIndex) => {
            const rowData = pageRows[rowIndex];
            const patch = Object.fromEntries(
              ctx.selectedEditableColumnNames.map((columnName) => [columnName, rowData?.[columnName]]),
            );
            return buildUpdateRowPayload(rowData ?? {}, patch, primaryKeyColumns);
          }),
        }),
      );
      const sql = (result.statements ?? []).join("\n\n");
      if (!sql) throw new Error("未生成 UPDATE 语句");
      await copyText(sql);
    } catch (e) {
      onCopyError(`复制 UPDATE 语句失败: ${String(e)}`);
    }
  }, [copyText, ctxMenu, onCopyError, pageRows, primaryKeyColumns, tableContext]);

  const applyCellDetailTransform = useCallback((mode: CellDetailMode) => {
    setCellDetail((current) => {
      if (!current) return current;
      const result = transformCellDetailText(mode, current.draftText, current.originalText);
      return {
        ...current,
        mode,
        draftText: result.error ? current.draftText : result.text,
        error: result.error ?? "",
      };
    });
  }, []);

  const resetCellDetailDraft = useCallback(() => {
    setCellDetail((current) =>
      current
        ? {
            ...current,
            draftText: current.originalText,
            mode: "raw",
            error: "",
          }
        : current,
    );
  }, []);

  const applyCellDetailToGrid = useCallback(() => {
    if (!cellDetail || !editable || !onCellValueChange || pkSet.has(cellDetail.column)) return;
    const rawOld = pageRows[cellDetail.rowIndex]?.[cellDetail.column];
    const next = coerceEditedCellValue(rawOld, cellDetail.draftText);
    onCellValueChange(cellDetail.rowIndex, cellDetail.column, next);
    setCellDetail(null);
    showAppMessage({
      variant: "success",
      title: "已回填",
      message: "单元格已标记为未提交修改，预览并确认后会更新数据库。",
    });
  }, [cellDetail, editable, onCellValueChange, pageRows, pkSet]);

  const contextMenuEntries = useMemo(() => {
    const ctx = ctxMenu?.context;
    if (!ctx) return [] as GridContextMenuEntry[];
    const entries: GridContextMenuEntry[] = [];
    if (ctx.isLongTextCell) {
      entries.push({
        kind: "action",
        label: "查看完整内容",
        onSelect: () => openCellDetail(ctx.cell),
      });
    }
    if (tableContext) {
      if (entries.length > 0) entries.push({ kind: "separator" });
      entries.push(
        {
          kind: "action",
          label: "设置为空字符串",
          disabled: !ctx.canEditSelection,
          onSelect: () => updateContextSelectionValue(""),
        },
        {
          kind: "action",
          label: "设置为 NULL",
          disabled: !ctx.canEditSelection,
          onSelect: () => updateContextSelectionValue(null),
        },
        {
          kind: "action",
          label: "生成 UUID",
          disabled: !ctx.canEditSelection,
          onSelect: () => updateContextSelectionValue(() => crypto.randomUUID()),
        },
        { kind: "separator" },
      );
    }
    entries.push(
      {
        kind: "action",
        label: "复制",
        onSelect: copySelection,
      },
      {
        kind: "submenu",
        label: "复制为",
        disabled: !ctx.canCopyRowsAsInsert && !ctx.canCopySelectionAsUpdate,
        children: [
          {
            kind: "action",
            label: "Insert 语句",
            disabled: !ctx.canCopyRowsAsInsert,
            onSelect: copyContextRowsAsInsert,
          },
          {
            kind: "action",
            label: "Update 语句",
            disabled: !ctx.canCopySelectionAsUpdate,
            onSelect: copyContextSelectionAsUpdate,
          },
        ],
      },
    );
    return normalizeContextMenuEntries(entries);
  }, [
    copyContextRowsAsInsert,
    copyContextSelectionAsUpdate,
    copySelection,
    ctxMenu,
    openCellDetail,
    tableContext,
    updateContextSelectionValue,
  ]);

  const runMenuAction = useCallback((action: () => void | Promise<void>) => {
    void Promise.resolve(action()).finally(() => setCtxMenu(null));
  }, []);

  const renderMenuEntries = useCallback(
    (entries: GridContextMenuEntry[], level = 0): JSX.Element[] =>
      entries.map((entry, index) => {
        const key = `${level}-${index}-${entry.kind}`;
        if (entry.kind === "separator") {
          return <div key={key} className="context-menu-divider" role="separator" />;
        }
        if (entry.kind === "submenu") {
          const children = normalizeContextMenuEntries(entry.children);
          const disabled = Boolean(
            entry.disabled ||
              children.length === 0 ||
              children.every((child) => child.kind !== "separator" && Boolean(child.disabled)),
          );
          return (
            <div key={key} className={`context-menu-group ${disabled ? "is-disabled" : ""}`}>
              <button
                type="button"
                className="context-menu-item context-menu-item-submenu"
                disabled={disabled}
                onClick={(e) => e.preventDefault()}
              >
                <span>{entry.label}</span>
                <ChevronRight className="context-menu-arrow" strokeWidth={2.25} />
              </button>
              {!disabled ? (
                <div className="context-submenu" role="menu">
                  {renderMenuEntries(children, level + 1)}
                </div>
              ) : null}
            </div>
          );
        }
        return (
          <button
            key={key}
            type="button"
            className="context-menu-item"
            disabled={entry.disabled}
            onClick={() => runMenuAction(entry.onSelect)}
          >
            {entry.label}
          </button>
        );
      }),
    [runMenuAction],
  );

  const cellDetailCanApply = Boolean(
    cellDetail && editable && onCellValueChange && !pkSet.has(cellDetail.column),
  );
  const cellDetailApplyHint =
    !cellDetail
      ? ""
      : pkSet.has(cellDetail.column)
        ? "主键列不能通过此处回填。"
        : !editable || !onCellValueChange
          ? "当前结果不可编辑，可继续查看、转换和复制。"
          : "回填后会先标记为未提交修改。";

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
          gridSelection={gridSelection}
          width={gridSize.width}
          height={gridSize.height}
          rowHeight={GRID_ROW_HEIGHT}
          headerHeight={GRID_HEADER_HEIGHT}
          rowMarkers={{ kind: "number", width: ROW_MARKER_WIDTH, startIndex: markerStart }}
          rowSelectionMode="multi"
          /** cell=仅单格；rect=仅一块矩形；multi-rect 支持多块/Shift 扩展多选（查询结果与可编辑表均需） */
          rangeSelect="multi-rect"
          smoothScrollX
          smoothScrollY
          overscrollX={16}
          /** single-click 与 Glide 内部 selection 同步存在竞态，reselect 读到的 cell 可能未更新，导致无法弹出编辑层；改用 second-click（两次点同一格）并与 editOnType + focus 配合实现「点选后输入」 */
          cellActivationBehavior={editable ? "second-click" : "double-click"}
          onColumnResize={onColumnResize}
          onGridSelectionChange={setGridSelection}
          onSelectionCleared={() => setGridSelection(createEmptyGridSelection())}
          onHeaderMenuClick={
            serverMode && onSortOrder
              ? (colIndex, bounds: HeaderBounds) => {
                  setSortMenu({ colIndex, bounds });
                }
              : undefined
          }
          onCellEdited={(cell, newVal: EditableGridCell) => {
            if (!editable || !onCellValueChange) return;
            if (newVal.kind !== GridCellKind.Text) return;
            const [c, r] = cell;
            if (r < 0 || c < 0 || c >= columns.length) return;
            const colName = columns[c];
            if (!colName || pkSet.has(colName)) return;
            const rawOld = pageRows[r]?.[colName];
            const next = coerceEditedCellValue(rawOld, newVal.data);
            onCellValueChange(r, colName, next);
          }}
          onCellClicked={(cell) => {
            const [c, r] = cell;
            if (r < 0 || c < 0 || c >= columns.length) return;
            if (editable) {
              lastCellPointerRef.current = null;
              void dataEditorRef.current?.focus();
              return;
            }
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
          onCellActivated={editable ? () => void dataEditorRef.current?.focus() : undefined}
          onCellContextMenu={(cell, event) => {
            event.preventDefault();
            const pos = lastContextClientPosRef.current;
            if (pos) {
              const next = clampGridContextMenuPosition(pos.x, pos.y);
              setCtxMenu({ ...next, context: buildContextMenuContext(cell) });
              return;
            }
            const host = gridHostRef.current;
            if (!host) return;
            const rect = host.getBoundingClientRect();
            const next = clampGridContextMenuPosition(rect.left + event.localEventX, rect.top + event.localEventY);
            setCtxMenu({ ...next, context: buildContextMenuContext(cell) });
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
          {renderMenuEntries(contextMenuEntries)}
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
              <div className="modal-panel large cell-detail-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head cell-detail-head">
                  <div className="min-w-0">
                    <h3 className="cell-detail-title">{cellDetail.column}</h3>
                    <div className="cell-detail-meta">
                      <span>行 {cellDetail.rowLabel}</span>
                      <span>类型 {cellDetail.dbType || "unknown"}</span>
                      <span>{cellDetail.draftText.length} 字符</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className="btn ghost text-xs"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(cellDetail.draftText)
                          .then(() =>
                            showAppMessage({ variant: "success", title: "复制成功", message: "单元格内容已复制到剪贴板" }),
                          )
                          .catch(() => onCopyError("复制失败"));
                      }}
                    >
                      复制
                    </button>
                    <button type="button" className="btn ghost text-xs" onClick={() => setCellDetail(null)}>
                      关闭
                    </button>
                  </div>
                </div>
                <div className="cell-detail-toolbar" role="toolbar" aria-label="内容格式">
                  {CELL_DETAIL_TRANSFORMS.map((item) => (
                    <button
                      key={item.mode}
                      type="button"
                      className={`cell-detail-format-btn ${cellDetail.mode === item.mode ? "active" : ""}`}
                      onClick={() => applyCellDetailTransform(item.mode)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {cellDetail.error ? <div className="cell-detail-error">{cellDetail.error}</div> : null}
                <textarea
                  className="tf-scrollbar cell-detail-textarea"
                  value={cellDetail.draftText}
                  aria-label="单元格完整内容"
                  spellCheck={false}
                  onChange={(e) =>
                    setCellDetail((current) =>
                      current
                        ? {
                            ...current,
                            draftText: e.target.value,
                            mode: "raw",
                            error: "",
                          }
                        : current,
                    )
                  }
                />
                <div className="cell-detail-footer">
                  <span className="cell-detail-hint">{cellDetailApplyHint}</span>
                  <div className="cell-detail-actions">
                    <button type="button" className="btn ghost text-xs" onClick={resetCellDetailDraft}>
                      重置
                    </button>
                    <button
                      type="button"
                      className="btn text-xs"
                      disabled={!cellDetailCanApply}
                      onClick={applyCellDetailToGrid}
                    >
                      回填到单元格
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default App;
