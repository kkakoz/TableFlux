import {
  AIService,
  DatabaseService,
  SecretService,
  SettingsService,
  StudioWindowService,
  TaskService,
  WorkspaceService,
  AssistRequest,
  type AssistResponse,
  type ConnectionMeta,
  type ExecuteSQLRequest,
  GroupCreateRequest,
  GroupUpdateRequest,
  type QueryResultPage,
  SaveStudioSessionRequest,
  type StudioSessionSnapshot,
  TableQueryRequest,
  TableSchemaRequest,
  UpdateRowsRequest,
  type VaultStatus,
  type WorkspaceGroup,
} from "../bindings/changeme";
import type { TableSchemaRequest as TableSchemaRequestFields } from "./types";

export const api = {
  getVaultStatus: () => SecretService.GetVaultStatus() as Promise<VaultStatus>,
  setMasterPassword: (password: string) => SecretService.SetMasterPassword(password),
  unlockVault: (password: string) => SecretService.UnlockVault(password),
  lockVault: () => SecretService.LockVault(),
  changeMasterPassword: (oldPassword: string, newPassword: string) =>
    SecretService.ChangeMasterPassword(oldPassword, newPassword),

  listGroups: () => WorkspaceService.ListGroups() as Promise<WorkspaceGroup[]>,
  createGroup: (name: string, color: string) =>
    WorkspaceService.CreateGroup(new GroupCreateRequest({ name, color, icon: "database" })),
  deleteGroup: (groupId: string) => WorkspaceService.DeleteGroup(groupId),
  updateGroup: (groupId: string, payload: { name: string; color: string; icon: string }) =>
    WorkspaceService.UpdateGroup(groupId, new GroupUpdateRequest(payload)),
  markGroupOpened: (groupId: string) => WorkspaceService.MarkGroupOpened(groupId),

  listGroupConnections: (groupId: string) =>
    WorkspaceService.ListGroupConnections(groupId) as Promise<ConnectionMeta[]>,
  createConnection: (payload: Record<string, unknown>) =>
    WorkspaceService.CreateConnection(payload as any),
  updateConnection: (connectionId: string, payload: Record<string, unknown>) =>
    WorkspaceService.UpdateConnection(connectionId, payload as any),
  deleteConnection: (connectionId: string) => WorkspaceService.DeleteConnection(connectionId),
  testConnection: (connectionId: string) => WorkspaceService.TestConnection(connectionId),

  openGroupWindow: (groupId: string) => StudioWindowService.OpenGroupWindow(groupId),
  focusMainWindow: () => StudioWindowService.FocusMainWindow(),

  executeSQL: (req: ExecuteSQLRequest | Record<string, unknown>) => DatabaseService.ExecuteSQL(req as any),
  cancelRunningQuery: () => DatabaseService.CancelRunningQuery(),
  queryTablePage: (req: TableQueryRequest | Record<string, unknown>) =>
    DatabaseService.QueryTablePage(req instanceof TableQueryRequest ? req : new TableQueryRequest(req)) as Promise<QueryResultPage>,
  previewUpdateRowsSQL: (req: UpdateRowsRequest | Record<string, unknown>) => DatabaseService.PreviewUpdateRowsSQL(req as any),
  updateRows: (req: UpdateRowsRequest | Record<string, unknown>) => DatabaseService.UpdateRows(req as any),
  getSettings: () => SettingsService.GetSettings(),
  listDatabases: (connectionId: string) => DatabaseService.ListDatabases(connectionId),
  listTables: (connectionId: string, database: string, schema = "") =>
    DatabaseService.ListTables(connectionId, database, schema),
  getTableSchema: (req: TableSchemaRequestFields) =>
    DatabaseService.GetTableSchema(new TableSchemaRequest(req)),
  explainSQL: (req: any) => DatabaseService.ExplainSQL(req),
  migrateTableData: (req: Record<string, unknown>) => DatabaseService.MigrateTableData(req as any),

  listTasks: () => TaskService.ListTasks(),

  getStudioSession: (groupId: string) =>
    WorkspaceService.GetStudioSession(groupId) as Promise<StudioSessionSnapshot>,
  saveStudioSession: (payload: SaveStudioSessionRequest | Record<string, unknown>) =>
    WorkspaceService.SaveStudioSession(new SaveStudioSessionRequest(payload as any)),

  /** AI SQL 助手（两轮模型调用） */
  assistSQL: (payload: Record<string, unknown>) =>
    AIService.Assist(new AssistRequest(payload)) as Promise<AssistResponse | null>,
};
