import {
  AIService,
  DatabaseService,
  SecretService,
  StudioWindowService,
  TaskService,
  WorkspaceService,
  AssistRequest,
  type AssistResponse,
  type ConnectionMeta,
  type ExecuteSQLRequest,
  GroupCreateRequest,
  SaveStudioSessionRequest,
  type StudioSessionSnapshot,
  type VaultStatus,
  type WorkspaceGroup,
} from "../bindings/changeme";

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
  markGroupOpened: (groupId: string) => WorkspaceService.MarkGroupOpened(groupId),

  listGroupConnections: (groupId: string) =>
    WorkspaceService.ListGroupConnections(groupId) as Promise<ConnectionMeta[]>,
  createConnection: (payload: Record<string, unknown>) =>
    WorkspaceService.CreateConnection(payload as any),
  deleteConnection: (connectionId: string) => WorkspaceService.DeleteConnection(connectionId),
  testConnection: (connectionId: string) => WorkspaceService.TestConnection(connectionId),
  setConnectionFavorite: (connectionId: string, favorite: boolean) =>
    WorkspaceService.SetConnectionFavorite(connectionId, favorite),

  openGroupWindow: (groupId: string) => StudioWindowService.OpenGroupWindow(groupId),

  executeSQL: (req: ExecuteSQLRequest | Record<string, unknown>) => DatabaseService.ExecuteSQL(req as any),
  listDatabases: (connectionId: string) => DatabaseService.ListDatabases(connectionId),
  listTables: (connectionId: string, database: string, schema = "") =>
    DatabaseService.ListTables(connectionId, database, schema),
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
