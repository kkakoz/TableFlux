export type WorkspaceGroup = {
  id: string;
  name: string;
  color: string;
  icon: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionMeta = {
  id: string;
  groupId: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  defaultDb: string;
  sslMode: string;
  sshTunnel: boolean;
  tags: string[];
  readOnlyFlag: boolean;
  favorite: boolean;
  lastHealthCheckAt?: string;
  lastHealthCheckOk: boolean;
  lastHealthCheckError?: string;
};

export type VaultStatus = {
  hasMasterPassword: boolean;
  unlocked: boolean;
};

export type ExecuteSQLResult = {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  rowsAffected: number;
  lastInsertId: number;
  message: string;
  truncated: boolean;
  durationMs: number;
  execLog?: string[];
};

export type StudioTabSnapshot = {
  id: string;
  title: string;
  sql: string;
  connectionId: string;
  contextDb: string;
  contextTable: string;
};

export type StudioSessionSnapshot = {
  groupId: string;
  activeConnectionId: string;
  tabs: StudioTabSnapshot[];
};

export type TableColumnSchema = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  comment: string;
};

export type TableSchema = {
  name: string;
  database: string;
  schema: string;
  engine: string;
  charset: string;
  collation: string;
  comment: string;
  columns: TableColumnSchema[];
  primaryKey: string[];
};

export type TableSchemaRequest = {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
};

export type AIConfig = {
  apiKey: string;
  apiUrl: string;
  modelName: string;
};

export type Settings = {
  theme: 'light' | 'dark' | 'system';
  language: 'zh-CN' | 'en-US';
  autoSave: boolean;
  autoSaveDelay: number;
  queryLimit: number;
  queryTimeout: number;
  confirmBefore: boolean;
  fontSize: number;
  fontFamily: string;
  showLineNumbers: boolean;
  wordWrap: boolean;
  tabSize: number;
};
