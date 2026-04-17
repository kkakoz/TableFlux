package main

import "time"

type WorkspaceGroup struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	Icon      string    `json:"icon"`
	Order     int       `json:"order"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ConnectionMeta struct {
	ID                   string     `json:"id"`
	GroupID              string     `json:"groupId"`
	Name                 string     `json:"name"`
	Driver               string     `json:"driver"`
	Host                 string     `json:"host"`
	Port                 int        `json:"port"`
	User                 string     `json:"user"`
	DefaultDB            string     `json:"defaultDb"`
	SSLMode              string     `json:"sslMode"`
	SSHTunnel            bool       `json:"sshTunnel"`
	Tags                 []string   `json:"tags"`
	ReadOnlyFlag         bool       `json:"readOnlyFlag"`
	Favorite             bool       `json:"favorite"`
	LastHealthCheckAt    *time.Time `json:"lastHealthCheckAt,omitempty"`
	LastHealthCheckOK    bool       `json:"lastHealthCheckOk"`
	LastHealthCheckError string     `json:"lastHealthCheckError,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type ConnectionUpsertRequest struct {
	GroupID      string   `json:"groupId"`
	Name         string   `json:"name"`
	Driver       string   `json:"driver"`
	Host         string   `json:"host"`
	Port         int      `json:"port"`
	User         string   `json:"user"`
	Password     string   `json:"password"`
	DefaultDB    string   `json:"defaultDb"`
	SSLMode      string   `json:"sslMode"`
	SSHTunnel    bool     `json:"sshTunnel"`
	Tags         []string `json:"tags"`
	ReadOnlyFlag bool     `json:"readOnlyFlag"`
	Favorite     bool     `json:"favorite"`
}

type GroupCreateRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Icon  string `json:"icon"`
}

type GroupUpdateRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Icon  string `json:"icon"`
}

type GroupReorderRequest struct {
	OrderedIDs []string `json:"orderedIds"`
}

type VaultStatus struct {
	HasMasterPassword bool `json:"hasMasterPassword"`
	Unlocked          bool `json:"unlocked"`
}

type ExecuteSQLRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	SQL          string `json:"sql"`
	RowLimit     int    `json:"rowLimit"`
	TimeoutMs    int    `json:"timeoutMs"`
	Mode         string `json:"mode"`
	RequestID    string `json:"requestId"`
}

type SQLExecutionResult struct {
	Columns      []string         `json:"columns,omitempty"`
	ColumnTypes  []string         `json:"columnTypes,omitempty"` // 与 columns 同序，驱动返回的 DatabaseTypeName（小写）
	Rows         []map[string]any `json:"rows,omitempty"`
	RowsAffected int64            `json:"rowsAffected"`
	LastInsertID int64            `json:"lastInsertId"`
	Message      string           `json:"message"`
	Truncated    bool             `json:"truncated"`
	DurationMs   int64            `json:"durationMs"`
	ExecLog      []string         `json:"execLog,omitempty"`
}

type QueryResultPage struct {
	Columns     []string         `json:"columns"`
	ColumnTypes []string         `json:"columnTypes,omitempty"`
	Rows        []map[string]any `json:"rows"`
	Total       int              `json:"total"`
	Offset      int              `json:"offset"`
	Limit       int              `json:"limit"`
	DurationMs  int64            `json:"durationMs"`
}

type TableQueryRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
	Table        string `json:"table"`
	Offset       int    `json:"offset"`
	Limit        int    `json:"limit"`
	OrderBy      string `json:"orderBy"`
	OrderDesc    bool   `json:"orderDesc"`
}

type ExplainSQLRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	SQL          string `json:"sql"`
	RequestID    string `json:"requestId"`
}

type CancelRunningQueryRequest struct {
	RequestID string `json:"requestId"`
}

type InsertRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Database     string           `json:"database"`
	Schema       string           `json:"schema"`
	Table        string           `json:"table"`
	Rows         []map[string]any `json:"rows"`
}

// PreviewInsertRowsRequest 用于生成可复制的 INSERT 预览语句。
type PreviewInsertRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Database     string           `json:"database"`
	Schema       string           `json:"schema"`
	Table        string           `json:"table"`
	Columns      []string         `json:"columns"`
	Rows         []map[string]any `json:"rows"`
}

type UpdateRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Database     string           `json:"database"`
	Schema       string           `json:"schema"`
	Table        string           `json:"table"`
	KeyColumns   []string         `json:"keyColumns"`
	Rows         []map[string]any `json:"rows"`
}

// UpdateRowsSQLPreviewResponse 与 UpdateRows 请求一致时生成的可展示 UPDATE 文本（按方言转义字面量）。
type UpdateRowsSQLPreviewResponse struct {
	Statements []string `json:"statements"`
}

// InsertRowsSQLPreviewResponse 与 PreviewInsertRowsRequest 一致时生成的可展示 INSERT 文本（按方言转义字面量）。
type InsertRowsSQLPreviewResponse struct {
	Statements []string `json:"statements"`
}

type DeleteRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Database     string           `json:"database"`
	Schema       string           `json:"schema"`
	Table        string           `json:"table"`
	KeyColumns   []string         `json:"keyColumns"`
	Rows         []map[string]any `json:"rows"`
}

type SchemaObject struct {
	Name string `json:"name"`
}

type BackgroundTask struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Status    string    `json:"status"`
	Message   string    `json:"message"`
	Logs      []string  `json:"logs"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
}

type DataMigrationRequest struct {
	SourceConnectionID string `json:"sourceConnectionId"`
	SourceDatabase     string `json:"sourceDatabase"`
	SourceSchema       string `json:"sourceSchema"`
	SourceTable        string `json:"sourceTable"`
	TargetConnectionID string `json:"targetConnectionId"`
	TargetDatabase     string `json:"targetDatabase"`
	TargetSchema       string `json:"targetSchema"`
	TargetTable        string `json:"targetTable"`
	TruncateTarget     bool   `json:"truncateTarget"`
}

type DataMigrationResult struct {
	MigratedRows int64  `json:"migratedRows"`
	Message      string `json:"message"`
}

type StudioTabSnapshot struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	SQL          string `json:"sql"`
	ConnectionID string `json:"connectionId"`
	ContextDB    string `json:"contextDb"`
	ContextTable string `json:"contextTable"`
}

type StudioSessionSnapshot struct {
	GroupID            string              `json:"groupId"`
	ActiveConnectionID string              `json:"activeConnectionId"`
	Tabs               []StudioTabSnapshot `json:"tabs"`
	UpdatedAt          time.Time           `json:"updatedAt"`
}

type SaveStudioSessionRequest struct {
	GroupID            string              `json:"groupId"`
	ActiveConnectionID string              `json:"activeConnectionId"`
	Tabs               []StudioTabSnapshot `json:"tabs"`
}

type appState struct {
	Groups         []WorkspaceGroup                 `json:"groups"`
	Connections    []ConnectionMeta                 `json:"connections"`
	RecentGroupIDs []string                         `json:"recentGroupIds"`
	Sessions       map[string]StudioSessionSnapshot `json:"sessions"`
	Tasks          []BackgroundTask                 `json:"tasks"`
}

type vaultState struct {
	Salt         string            `json:"salt"`
	PasswordHash string            `json:"passwordHash"`
	Secrets      map[string]string `json:"secrets"`
}

// Table schema related types
type TableColumnSchema struct {
	Name          string `json:"name"`
	Type          string `json:"type"`
	Nullable      bool   `json:"nullable"`
	DefaultValue  string `json:"defaultValue"`
	PrimaryKey    bool   `json:"primaryKey"`
	Unique        bool   `json:"unique"`
	AutoIncrement bool   `json:"autoIncrement"`
	Comment       string `json:"comment"`
}

type TableSchema struct {
	Name       string              `json:"name"`
	Database   string              `json:"database"`
	Schema     string              `json:"schema"`
	Engine     string              `json:"engine"`
	Charset    string              `json:"charset"`
	Collation  string              `json:"collation"`
	Comment    string              `json:"comment"`
	Columns    []TableColumnSchema `json:"columns"`
	PrimaryKey []string            `json:"primaryKey"`
}

type TableSchemaRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	Schema       string `json:"schema"`
	Table        string `json:"table"`
}

// AssistRequest / AssistResponse 与 chat.AssistService 对齐，供 Wails 暴露给前端。
type AssistRequest struct {
	Dialect      string `json:"dialect"`
	InputText    string `json:"inputText"`
	SelectedText string `json:"selectedText"`
	DatabaseName string `json:"databaseName"`
	ConnectionID string `json:"connectionId,omitempty"`
}

type AssistResponse struct {
	Intent         string   `json:"intent"`
	Type           string   `json:"type"`
	Content        string   `json:"content"`
	Explanation    string   `json:"explanation,omitempty"`
	RelevantTables []string `json:"relevantTables,omitempty"`
	Reason         string   `json:"reason,omitempty"`
}
