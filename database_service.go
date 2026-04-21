package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
)

var selectLikePattern = regexp.MustCompile(`(?is)^\s*(select|show|with|describe|desc|explain)\b`)

type DatabaseService struct {
	store      *DataStore
	secrets    *SecretService
	mu         sync.Mutex
	pools      map[string]*sql.DB
	running    map[string]context.CancelFunc
	sqlResults map[string]cachedSQLResult
	sqlOrder   []string
	defaultRLS int

	migrationMu     sync.Mutex
	migrationJobs   map[string]*dataMigrationJob
	migrationRunner func(context.Context, DataMigrationRequest) (DataMigrationResult, error)
}

type cachedSQLResult struct {
	columns     []string
	columnTypes []string
	rows        []map[string]any
	total       int
	truncated   bool
	durationMs  int64
	createdAt   time.Time
}

type dataMigrationJob struct {
	id          string
	req         DataMigrationBatchRequest
	status      string
	workerCount int
	tables      []DataMigrationTableStatus
	cancel      context.CancelFunc
	startedAt   time.Time
	endedAt     time.Time
	message     string
}

func NewDatabaseService(store *DataStore, secrets *SecretService) *DatabaseService {
	return &DatabaseService{
		store:         store,
		secrets:       secrets,
		pools:         map[string]*sql.DB{},
		running:       map[string]context.CancelFunc{},
		sqlResults:    map[string]cachedSQLResult{},
		defaultRLS:    5000,
		migrationJobs: map[string]*dataMigrationJob{},
	}
}

func (s *DatabaseService) ServiceName() string {
	return "DatabaseService"
}

const maxCachedSQLResults = 20

func normalizePageBounds(offset, limit, defaultLimit, total int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit <= 0 {
		limit = 5000
	}
	if offset > total {
		offset = total
	}
	return offset, limit
}

func sliceResultRows(rows []map[string]any, offset, limit int) []map[string]any {
	if offset >= len(rows) {
		return []map[string]any{}
	}
	end := offset + limit
	if end > len(rows) {
		end = len(rows)
	}
	return rows[offset:end]
}

func (s *DatabaseService) storeSQLResult(requestID string, columns, columnTypes []string, rows []map[string]any, truncated bool, durationMs int64) {
	if strings.TrimSpace(requestID) == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sqlResults[requestID] = cachedSQLResult{
		columns:     columns,
		columnTypes: columnTypes,
		rows:        rows,
		total:       len(rows),
		truncated:   truncated,
		durationMs:  durationMs,
		createdAt:   time.Now(),
	}
	filtered := s.sqlOrder[:0]
	for _, id := range s.sqlOrder {
		if id != requestID {
			filtered = append(filtered, id)
		}
	}
	s.sqlOrder = append(filtered, requestID)
	for len(s.sqlOrder) > maxCachedSQLResults {
		oldest := s.sqlOrder[0]
		s.sqlOrder = s.sqlOrder[1:]
		delete(s.sqlResults, oldest)
	}
}

func (s *DatabaseService) clearSQLResult(requestID string) {
	if strings.TrimSpace(requestID) == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sqlResults, requestID)
	filtered := s.sqlOrder[:0]
	for _, id := range s.sqlOrder {
		if id != requestID {
			filtered = append(filtered, id)
		}
	}
	s.sqlOrder = filtered
}

func (s *DatabaseService) QuerySQLResultPage(req SQLResultPageRequest) (QueryResultPage, error) {
	if strings.TrimSpace(req.RequestID) == "" {
		return QueryResultPage{}, errors.New("requestId is required")
	}
	s.mu.Lock()
	cached, ok := s.sqlResults[req.RequestID]
	s.mu.Unlock()
	if !ok {
		return QueryResultPage{}, errors.New("query result is no longer available")
	}
	offset, limit := normalizePageBounds(req.Offset, req.Limit, s.defaultRLS, cached.total)
	return QueryResultPage{
		Columns:     cached.columns,
		ColumnTypes: cached.columnTypes,
		Rows:        sliceResultRows(cached.rows, offset, limit),
		Total:       cached.total,
		Offset:      offset,
		Limit:       limit,
		DurationMs:  cached.durationMs,
	}, nil
}

func (s *DatabaseService) ExecuteSQL(req ExecuteSQLRequest) (SQLExecutionResult, error) {
	if req.ConnectionID == "" {
		return SQLExecutionResult{}, errors.New("connectionId is required")
	}
	if strings.TrimSpace(req.RequestID) == "" {
		return SQLExecutionResult{}, errors.New("requestId is required")
	}
	if strings.TrimSpace(req.SQL) == "" {
		return SQLExecutionResult{}, errors.New("sql is required")
	}
	if req.RowLimit == 0 {
		req.RowLimit = s.defaultRLS
	}
	// RowLimit < 0 表示不限制行数
	// TimeoutMs == 0 表示不限制超时；TimeoutMs < 0 使用默认 30s
	if req.TimeoutMs < 0 {
		req.TimeoutMs = 30000
	}
	if req.Mode == "" {
		req.Mode = "single"
	}

	if req.Mode == "batch" {
		parts := splitStatements(req.SQL)
		logs := make([]string, 0, len(parts))
		var final SQLExecutionResult
		for i, statement := range parts {
			trimmed := strings.TrimSpace(statement)
			if trimmed == "" {
				continue
			}
			singleReq := req
			singleReq.SQL = trimmed
			singleReq.Mode = "single"
			fmt.Println(singleReq.SQL)
			result, err := s.ExecuteSQL(singleReq)
			if err != nil {
				logs = append(logs, fmt.Sprintf("[%d] failed: %v", i+1, err))
				return SQLExecutionResult{ExecLog: logs}, err
			}
			logs = append(logs, fmt.Sprintf("[%d] ok: %s", i+1, result.Message))
			final = result
		}
		final.ExecLog = logs
		return final, nil
	}

	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return SQLExecutionResult{}, err
	}

	var ctx context.Context
	var cancel context.CancelFunc
	if req.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), time.Duration(req.TimeoutMs)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	s.registerRunning(req.RequestID, cancel)
	defer s.unregisterRunning(req.RequestID)

	started := time.Now()
	if selectLikePattern.MatchString(req.SQL) {
		rows, err := db.QueryContext(ctx, req.SQL)
		if err != nil {
			return SQLExecutionResult{}, err
		}
		defer rows.Close()
		cols, err := rows.Columns()
		if err != nil {
			return SQLExecutionResult{}, err
		}
		displayCols := disambiguateQueryColumns(cols)
		colTypes, _ := columnDatabaseTypeNames(rows)
		if len(colTypes) != len(displayCols) {
			colTypes = nil
		}
		resultRows := make([]map[string]any, 0)
		truncated := false
		for rows.Next() {
			if req.RowLimit > 0 && len(resultRows) >= req.RowLimit {
				truncated = true
				break
			}
			values := make([]any, len(cols))
			refs := make([]any, len(cols))
			for i := range values {
				refs[i] = &values[i]
			}
			if err := rows.Scan(refs...); err != nil {
				return SQLExecutionResult{}, err
			}
			row := make(map[string]any, len(cols))
			for i := range cols {
				row[displayCols[i]] = normalizeValue(values[i])
			}
			resultRows = append(resultRows, row)
		}
		if err := rows.Err(); err != nil {
			return SQLExecutionResult{}, err
		}
		durationMs := time.Since(started).Milliseconds()
		total := len(resultRows)
		pageOffset, pageLimit := normalizePageBounds(req.PageOffset, req.PageLimit, s.defaultRLS, total)
		s.storeSQLResult(req.RequestID, displayCols, colTypes, resultRows, truncated, durationMs)
		message := fmt.Sprintf("Query finished (%d rows)", total)
		if truncated {
			message = fmt.Sprintf("Query finished (%d rows, truncated by row limit)", total)
		}
		return SQLExecutionResult{
			Columns:     displayCols,
			ColumnTypes: colTypes,
			Rows:        sliceResultRows(resultRows, pageOffset, pageLimit),
			Message:     message,
			Truncated:   truncated,
			DurationMs:  durationMs,
			Total:       total,
			Offset:      pageOffset,
			Limit:       pageLimit,
		}, nil
	}

	s.clearSQLResult(req.RequestID)
	if conn.ReadOnlyFlag {
		upper := strings.ToUpper(strings.TrimSpace(req.SQL))
		if strings.HasPrefix(upper, "INSERT") || strings.HasPrefix(upper, "UPDATE") || strings.HasPrefix(upper, "DELETE") || strings.HasPrefix(upper, "CREATE") || strings.HasPrefix(upper, "DROP") || strings.HasPrefix(upper, "ALTER") || strings.HasPrefix(upper, "TRUNCATE") {
			return SQLExecutionResult{}, errors.New("connection is read-only")
		}
	}

	execResult, err := db.ExecContext(ctx, req.SQL)
	if err != nil {
		return SQLExecutionResult{}, err
	}
	ra, _ := execResult.RowsAffected()
	li, _ := execResult.LastInsertId()
	return SQLExecutionResult{
		RowsAffected: ra,
		LastInsertID: li,
		Message:      fmt.Sprintf("Command finished (%d rows affected)", ra),
		DurationMs:   time.Since(started).Milliseconds(),
	}, nil
}

func (s *DatabaseService) CancelRunningQuery(req CancelRunningQueryRequest) {
	if strings.TrimSpace(req.RequestID) == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel, ok := s.running[req.RequestID]
	if !ok {
		return
	}
	cancel()
	delete(s.running, req.RequestID)
}

func (s *DatabaseService) ListDatabases(connectionID string) ([]SchemaObject, error) {
	_, db, err := s.getPool(connectionID, "")
	if err != nil {
		return nil, err
	}
	conn, _ := s.store.GetConnection(connectionID)
	q := "SHOW DATABASES"
	if conn.Driver == "postgres" {
		q = "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname"
	}
	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SchemaObject{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, SchemaObject{Name: name})
	}
	return out, rows.Err()
}

func (s *DatabaseService) ListSchemas(connectionID, database string) ([]SchemaObject, error) {
	conn, db, err := s.getPool(connectionID, database)
	if err != nil {
		return nil, err
	}
	if conn.Driver == "mysql" {
		return []SchemaObject{{Name: fallback(database, conn.DefaultDB)}}, nil
	}
	rows, err := db.Query("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SchemaObject{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, SchemaObject{Name: name})
	}
	return out, rows.Err()
}

func (s *DatabaseService) ListTables(connectionID, database, schema string) ([]SchemaObject, error) {
	conn, db, err := s.getPool(connectionID, database)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if conn.Driver == "mysql" {
		dbName := fallback(database, conn.DefaultDB)
		query := fmt.Sprintf("SHOW TABLES FROM %s", quoteIdentifier(conn.Driver, dbName))
		rows, err = db.Query(query)
	} else {
		if schema == "" {
			schema = "public"
		}
		rows, err = db.Query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name", schema)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SchemaObject{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, SchemaObject{Name: name})
	}
	return out, rows.Err()
}

func (s *DatabaseService) ListViews(connectionID, database, schema string) ([]SchemaObject, error) {
	conn, db, err := s.getPool(connectionID, database)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if conn.Driver == "mysql" {
		rows, err = db.Query("SELECT table_name FROM information_schema.views WHERE table_schema = DATABASE() ORDER BY table_name")
	} else {
		if schema == "" {
			schema = "public"
		}
		rows, err = db.Query("SELECT table_name FROM information_schema.views WHERE table_schema=$1 ORDER BY table_name", schema)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SchemaObject{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, SchemaObject{Name: name})
	}
	return out, rows.Err()
}

func (s *DatabaseService) ListIndexes(connectionID, database, schema, table string) ([]SchemaObject, error) {
	conn, db, err := s.getPool(connectionID, database)
	if err != nil {
		return nil, err
	}
	if table == "" {
		return nil, errors.New("table is required")
	}
	var rows *sql.Rows
	if conn.Driver == "mysql" {
		query := fmt.Sprintf("SHOW INDEX FROM %s", quoteIdentifier(conn.Driver, table))
		rows, err = db.Query(query)
	} else {
		if schema == "" {
			schema = "public"
		}
		rows, err = db.Query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname", schema, table)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	idx := map[string]struct{}{}
	for rows.Next() {
		var name string
		if conn.Driver == "mysql" {
			var tableName, nonUnique, keyName, seqInIndex, columnName any
			if err := rows.Scan(&tableName, &nonUnique, &keyName, &seqInIndex, &columnName, new(any), new(any), new(any), new(any), new(any), new(any), new(any), new(any), new(any), new(any)); err == nil {
				name = fmt.Sprint(keyName)
			}
		} else {
			if err := rows.Scan(&name); err != nil {
				return nil, err
			}
		}
		if name != "" {
			idx[name] = struct{}{}
		}
	}
	out := make([]SchemaObject, 0, len(idx))
	for k := range idx {
		out = append(out, SchemaObject{Name: k})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *DatabaseService) ExplainSQL(req ExplainSQLRequest) (SQLExecutionResult, error) {
	req2 := ExecuteSQLRequest{
		ConnectionID: req.ConnectionID,
		Database:     req.Database,
		SQL:          "EXPLAIN " + strings.TrimSpace(req.SQL),
		RowLimit:     500,
		TimeoutMs:    req.TimeoutMs,
		Mode:         "single",
		RequestID:    req.RequestID,
	}
	return s.ExecuteSQL(req2)
}

const maxTablePageLimit = 50000

func tableQueryColumnNames(db *sql.DB, tableRef string) ([]string, error) {
	r, err := db.Query(fmt.Sprintf("SELECT * FROM %s LIMIT 0", tableRef))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.Columns()
}

func orderByExprForTableQuery(driver, rawCol string) string {
	if t, c, ok := splitQualifiedColumnName(rawCol); ok {
		return quoteIdentifier(driver, t) + "." + quoteIdentifier(driver, c)
	}
	return quoteIdentifier(driver, strings.Trim(rawCol, "`\""))
}

func buildTableQueryOrderClause(driver string, rawCols, displayCols []string, orderBy string, orderDesc bool) string {
	orderBy = strings.TrimSpace(orderBy)
	if orderBy == "" {
		return ""
	}
	idx := -1
	for i, d := range displayCols {
		if d == orderBy {
			idx = i
			break
		}
	}
	if idx < 0 || idx >= len(rawCols) {
		return ""
	}
	dir := "ASC"
	if orderDesc {
		dir = "DESC"
	}
	return " ORDER BY " + orderByExprForTableQuery(driver, rawCols[idx]) + " " + dir
}

func (s *DatabaseService) QueryTablePage(req TableQueryRequest) (QueryResultPage, error) {
	started := time.Now()
	if req.Limit <= 0 {
		req.Limit = 100
	}
	if req.Limit > maxTablePageLimit {
		req.Limit = maxTablePageLimit
	}
	if req.Offset < 0 {
		req.Offset = 0
	}
	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return QueryResultPage{}, err
	}
	tableRef := tableRef(conn.Driver, req.Schema, req.Table)
	rawCols, err := tableQueryColumnNames(db, tableRef)
	if err != nil {
		return QueryResultPage{}, err
	}
	displayCols := disambiguateQueryColumns(rawCols)
	orderClause := buildTableQueryOrderClause(conn.Driver, rawCols, displayCols, req.OrderBy, req.OrderDesc)
	query := fmt.Sprintf("SELECT * FROM %s%s LIMIT %d OFFSET %d", tableRef, orderClause, req.Limit, req.Offset)
	rows, err := db.Query(query)
	if err != nil {
		return QueryResultPage{}, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return QueryResultPage{}, err
	}
	displayCols = disambiguateQueryColumns(cols)
	colTypes, _ := columnDatabaseTypeNames(rows)
	if len(colTypes) != len(displayCols) {
		colTypes = nil
	}
	resultRows := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(cols))
		refs := make([]any, len(cols))
		for i := range values {
			refs[i] = &values[i]
		}
		if err := rows.Scan(refs...); err != nil {
			return QueryResultPage{}, err
		}
		item := map[string]any{}
		for i := range cols {
			item[displayCols[i]] = normalizeValue(values[i])
		}
		resultRows = append(resultRows, item)
	}
	countRows, err := db.Query(fmt.Sprintf("SELECT COUNT(*) FROM %s", tableRef))
	if err != nil {
		return QueryResultPage{}, err
	}
	defer countRows.Close()
	total := 0
	if countRows.Next() {
		if err := countRows.Scan(&total); err != nil {
			return QueryResultPage{}, err
		}
	}
	return QueryResultPage{
		Columns:     displayCols,
		ColumnTypes: colTypes,
		Rows:        resultRows,
		Total:       total,
		Offset:      req.Offset,
		Limit:       req.Limit,
		DurationMs:  time.Since(started).Milliseconds(),
	}, nil
}

func (s *DatabaseService) InsertRows(req InsertRowsRequest) (SQLExecutionResult, error) {
	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return SQLExecutionResult{}, err
	}
	if conn.ReadOnlyFlag {
		return SQLExecutionResult{}, errors.New("connection is read-only")
	}
	if len(req.Rows) == 0 {
		return SQLExecutionResult{}, errors.New("rows are required")
	}
	columns := sortedKeys(req.Rows[0])
	if len(columns) == 0 {
		return SQLExecutionResult{}, errors.New("row columns are required")
	}
	placeholderRows := make([]string, 0, len(req.Rows))
	args := []any{}
	argPos := 1
	for _, row := range req.Rows {
		holders := make([]string, 0, len(columns))
		for _, c := range columns {
			holders = append(holders, placeholder(conn.Driver, argPos))
			argPos++
			args = append(args, row[c])
		}
		placeholderRows = append(placeholderRows, "("+strings.Join(holders, ",")+")")
	}
	table := tableRef(conn.Driver, req.Schema, req.Table)
	colList := quoteColumns(conn.Driver, columns)
	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s", table, strings.Join(colList, ","), strings.Join(placeholderRows, ","))
	r, err := db.Exec(query, args...)
	if err != nil {
		return SQLExecutionResult{}, err
	}
	ra, _ := r.RowsAffected()
	return SQLExecutionResult{RowsAffected: ra, Message: fmt.Sprintf("Inserted %d rows", ra)}, nil
}

// PreviewInsertRowsSQL 生成与 InsertRows 语义接近的 INSERT 语句（展示用字符串字面量已按方言转义）。
func (s *DatabaseService) PreviewInsertRowsSQL(req PreviewInsertRowsRequest) (InsertRowsSQLPreviewResponse, error) {
	conn, _, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return InsertRowsSQLPreviewResponse{}, err
	}
	if len(req.Rows) == 0 {
		return InsertRowsSQLPreviewResponse{}, errors.New("rows are required")
	}
	columns := req.Columns
	if len(columns) == 0 {
		columns = sortedKeys(req.Rows[0])
	}
	if len(columns) == 0 {
		return InsertRowsSQLPreviewResponse{}, errors.New("row columns are required")
	}
	stmts := make([]string, 0, len(req.Rows))
	for _, row := range req.Rows {
		stmts = append(stmts, buildInsertStatementPreview(conn.Driver, req.Schema, req.Table, columns, row)+";")
	}
	return InsertRowsSQLPreviewResponse{Statements: stmts}, nil
}

func (s *DatabaseService) UpdateRows(req UpdateRowsRequest) (SQLExecutionResult, error) {
	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return SQLExecutionResult{}, err
	}
	if conn.ReadOnlyFlag {
		return SQLExecutionResult{}, errors.New("connection is read-only")
	}
	if len(req.Rows) == 0 || len(req.KeyColumns) == 0 {
		return SQLExecutionResult{}, errors.New("rows and keyColumns are required")
	}
	total := int64(0)
	for _, row := range req.Rows {
		setCols := []string{}
		where := []string{}
		args := []any{}
		argPos := 1
		for _, k := range sortedNonKeyColumns(row, req.KeyColumns) {
			setCols = append(setCols, fmt.Sprintf("%s=%s", quoteIdentifier(conn.Driver, k), placeholder(conn.Driver, argPos)))
			args = append(args, row[k])
			argPos++
		}
		if len(setCols) == 0 {
			return SQLExecutionResult{}, errors.New("no columns to update (only key columns present)")
		}
		for _, key := range req.KeyColumns {
			where = append(where, fmt.Sprintf("%s=%s", quoteIdentifier(conn.Driver, key), placeholder(conn.Driver, argPos)))
			args = append(args, row[key])
			argPos++
		}
		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", tableRef(conn.Driver, req.Schema, req.Table), strings.Join(setCols, ","), strings.Join(where, " AND "))
		r, err := db.Exec(query, args...)
		if err != nil {
			return SQLExecutionResult{}, err
		}
		ra, _ := r.RowsAffected()
		total += ra
	}
	return SQLExecutionResult{RowsAffected: total, Message: fmt.Sprintf("Updated %d rows", total)}, nil
}

// PreviewUpdateRowsSQL 生成与 UpdateRows 语义一致的 UPDATE 语句（展示用字符串字面量已按方言转义）。
func (s *DatabaseService) PreviewUpdateRowsSQL(req UpdateRowsRequest) (UpdateRowsSQLPreviewResponse, error) {
	conn, _, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return UpdateRowsSQLPreviewResponse{}, err
	}
	if len(req.Rows) == 0 || len(req.KeyColumns) == 0 {
		return UpdateRowsSQLPreviewResponse{}, errors.New("rows and keyColumns are required")
	}
	stmts := make([]string, 0, len(req.Rows))
	for _, row := range req.Rows {
		keys := sortedNonKeyColumns(row, req.KeyColumns)
		if len(keys) == 0 {
			return UpdateRowsSQLPreviewResponse{}, errors.New("no columns to update (only key columns present)")
		}
		stmts = append(stmts, buildUpdateStatementPreview(conn.Driver, req.Schema, req.Table, req.KeyColumns, row, keys)+";")
	}
	return UpdateRowsSQLPreviewResponse{Statements: stmts}, nil
}

func (s *DatabaseService) DeleteRows(req DeleteRowsRequest) (SQLExecutionResult, error) {
	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return SQLExecutionResult{}, err
	}
	if conn.ReadOnlyFlag {
		return SQLExecutionResult{}, errors.New("connection is read-only")
	}
	if len(req.Rows) == 0 || len(req.KeyColumns) == 0 {
		return SQLExecutionResult{}, errors.New("rows and keyColumns are required")
	}
	total := int64(0)
	for _, row := range req.Rows {
		where := []string{}
		args := []any{}
		argPos := 1
		for _, key := range req.KeyColumns {
			where = append(where, fmt.Sprintf("%s=%s", quoteIdentifier(conn.Driver, key), placeholder(conn.Driver, argPos)))
			args = append(args, row[key])
			argPos++
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", tableRef(conn.Driver, req.Schema, req.Table), strings.Join(where, " AND "))
		r, err := db.Exec(query, args...)
		if err != nil {
			return SQLExecutionResult{}, err
		}
		ra, _ := r.RowsAffected()
		total += ra
	}
	return SQLExecutionResult{RowsAffected: total, Message: fmt.Sprintf("Deleted %d rows", total)}, nil
}

func (s *DatabaseService) GetTableSchema(req TableSchemaRequest) (TableSchema, error) {
	if req.Table == "" {
		return TableSchema{}, errors.New("table is required")
	}
	conn, db, err := s.getPool(req.ConnectionID, req.Database)
	if err != nil {
		return TableSchema{}, err
	}

	schema := TableSchema{
		Name:     req.Table,
		Database: req.Database,
		Schema:   req.Schema,
	}

	var rows *sql.Rows
	var schemaName string
	if conn.Driver == "mysql" {
		dbName := fallback(req.Database, conn.DefaultDB)
		schemaName = dbName
		query := `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
				COLUMN_KEY, EXTRA, COLUMN_COMMENT
				FROM information_schema.COLUMNS
				WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
				ORDER BY ORDINAL_POSITION`
		rows, err = db.Query(query, dbName, req.Table)
	} else {
		schemaName = fallback(req.Schema, "public")
		query := `SELECT column_name, data_type, is_nullable, column_default, '', '', ''
				FROM information_schema.columns
				WHERE table_schema = $1 AND table_name = $2
				ORDER BY ordinal_position`
		rows, err = db.Query(query, schemaName, req.Table)
	}
	if err != nil {
		return TableSchema{}, err
	}
	defer rows.Close()

	for rows.Next() {
		var col TableColumnSchema
		var nullableStr, extra, comment string
		var defaultVal sql.NullString
		if conn.Driver == "mysql" {
			if err := rows.Scan(&col.Name, &col.Type, &nullableStr, &defaultVal,
				new(string), &extra, &comment); err != nil {
				return TableSchema{}, err
			}
		} else {
			if err := rows.Scan(&col.Name, &col.Type, &nullableStr, &defaultVal,
				new(string), &extra, &comment); err != nil {
				return TableSchema{}, err
			}
		}
		if defaultVal.Valid {
			col.DefaultValue = defaultVal.String
		}
		col.Nullable = (nullableStr == "YES")
		col.AutoIncrement = (extra == "auto_increment")
		col.Comment = comment
		schema.Columns = append(schema.Columns, col)
	}

	// Get primary key information
	if conn.Driver == "mysql" {
		dbName := fallback(req.Database, conn.DefaultDB)
		query := `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
				WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
				ORDER BY ORDINAL_POSITION`
		keyRows, err := db.Query(query, dbName, req.Table)
		if err == nil {
			defer keyRows.Close()
			for keyRows.Next() {
				var key string
				if err := keyRows.Scan(&key); err == nil {
					schema.PrimaryKey = append(schema.PrimaryKey, key)
				}
			}
		}
	} else {
		schemaName = fallback(req.Schema, "public")
		query := `SELECT a.attname FROM pg_index i
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
				WHERE i.indrelid = (SELECT oid FROM pg_class WHERE relname = $1)
				AND i.indisprimary`
		keyRows, err := db.Query(query, req.Table)
		if err == nil {
			defer keyRows.Close()
			for keyRows.Next() {
				var key string
				if err := keyRows.Scan(&key); err == nil {
					schema.PrimaryKey = append(schema.PrimaryKey, key)
				}
			}
		}
	}

	// Mark primary key columns
	for i := range schema.Columns {
		for _, pk := range schema.PrimaryKey {
			if schema.Columns[i].Name == pk {
				schema.Columns[i].PrimaryKey = true
				break
			}
		}
	}

	return schema, nil
}

func (s *DatabaseService) StartDataMigration(req DataMigrationBatchRequest) (DataMigrationJobSnapshot, error) {
	if req.SourceConnectionID == "" || req.TargetConnectionID == "" {
		return DataMigrationJobSnapshot{}, errors.New("sourceConnectionId and targetConnectionId are required")
	}
	if req.SourceDatabase == "" || req.TargetDatabase == "" {
		return DataMigrationJobSnapshot{}, errors.New("sourceDatabase and targetDatabase are required")
	}

	tables := uniqueNonEmpty(req.SourceTables)
	if len(tables) == 0 {
		return DataMigrationJobSnapshot{}, errors.New("sourceTables is required")
	}
	req.SourceTables = tables
	req.WorkerCount = clampMigrationWorkerCount(req.WorkerCount)
	req.BatchSize = normalizeMigrationBatchSize(req.BatchSize)
	if req.WorkerCount > len(tables) {
		req.WorkerCount = len(tables)
	}

	if targetConn, _, err := s.getPool(req.TargetConnectionID, req.TargetDatabase); err != nil {
		return DataMigrationJobSnapshot{}, err
	} else if targetConn.ReadOnlyFlag {
		return DataMigrationJobSnapshot{}, errors.New("target connection is read-only")
	}
	if _, _, err := s.getPool(req.SourceConnectionID, req.SourceDatabase); err != nil {
		return DataMigrationJobSnapshot{}, err
	}

	now := time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	job := &dataMigrationJob{
		id:          uuid.NewString(),
		req:         req,
		status:      "running",
		workerCount: req.WorkerCount,
		cancel:      cancel,
		startedAt:   now,
		tables:      make([]DataMigrationTableStatus, 0, len(tables)),
	}
	for _, table := range tables {
		job.tables = append(job.tables, DataMigrationTableStatus{
			Table:       table,
			TargetTable: table,
			Status:      "pending",
		})
	}

	s.migrationMu.Lock()
	s.migrationJobs[job.id] = job
	s.migrationMu.Unlock()

	go s.runDataMigrationJob(ctx, job.id)

	return s.snapshotMigrationJob(job), nil
}

func (s *DatabaseService) GetDataMigrationJob(jobID string) (DataMigrationJobSnapshot, error) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil {
		return DataMigrationJobSnapshot{}, errors.New("migration job not found")
	}
	return s.snapshotMigrationJobLocked(job), nil
}

func (s *DatabaseService) CancelDataMigrationJob(jobID string) error {
	s.migrationMu.Lock()
	job := s.migrationJobs[jobID]
	if job == nil {
		s.migrationMu.Unlock()
		return errors.New("migration job not found")
	}
	if job.status == "running" {
		job.status = "canceled"
		job.message = "Migration canceled"
		job.endedAt = time.Now()
		for i := range job.tables {
			if job.tables[i].Status == "pending" || job.tables[i].Status == "running" {
				job.tables[i].Status = "canceled"
				job.tables[i].EndedAt = job.endedAt
			}
		}
	}
	cancel := job.cancel
	s.migrationMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

func (s *DatabaseService) runDataMigrationJob(ctx context.Context, jobID string) {
	s.migrationMu.Lock()
	job := s.migrationJobs[jobID]
	if job == nil {
		s.migrationMu.Unlock()
		return
	}
	req := job.req
	workerCount := job.workerCount
	s.migrationMu.Unlock()

	jobs := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for table := range jobs {
				if ctx.Err() != nil {
					s.markMigrationTableCanceled(jobID, table)
					continue
				}
				s.markMigrationTableRunning(jobID, table)
				tableReq := DataMigrationRequest{
					SourceConnectionID: req.SourceConnectionID,
					SourceDatabase:     req.SourceDatabase,
					SourceSchema:       req.SourceSchema,
					SourceTable:        table,
					TargetConnectionID: req.TargetConnectionID,
					TargetDatabase:     req.TargetDatabase,
					TargetSchema:       req.TargetSchema,
					TargetTable:        table,
					TruncateTarget:     req.TruncateTarget,
					BatchSize:          req.BatchSize,
				}
				result, err := s.runSingleMigration(ctx, tableReq)
				if err != nil {
					s.markMigrationTableFailed(jobID, table, err)
					continue
				}
				s.markMigrationTableSuccess(jobID, table, result)
			}
		}()
	}

	for _, table := range req.SourceTables {
		if ctx.Err() != nil {
			s.markMigrationTableCanceled(jobID, table)
			continue
		}
		jobs <- table
	}
	close(jobs)
	wg.Wait()
	s.finishMigrationJob(jobID)
}

func (s *DatabaseService) runSingleMigration(ctx context.Context, req DataMigrationRequest) (DataMigrationResult, error) {
	if s.migrationRunner != nil {
		return s.migrationRunner(ctx, req)
	}
	return s.migrateTableData(ctx, req)
}

func (s *DatabaseService) MigrateTableData(req DataMigrationRequest) (DataMigrationResult, error) {
	return s.migrateTableData(context.Background(), req)
}

func (s *DatabaseService) migrateTableData(ctx context.Context, req DataMigrationRequest) (DataMigrationResult, error) {
	if req.SourceConnectionID == "" || req.TargetConnectionID == "" {
		return DataMigrationResult{}, errors.New("sourceConnectionId and targetConnectionId are required")
	}
	if req.SourceTable == "" || req.TargetTable == "" {
		return DataMigrationResult{}, errors.New("sourceTable and targetTable are required")
	}
	_, srcDB, err := s.getPool(req.SourceConnectionID, req.SourceDatabase)
	if err != nil {
		return DataMigrationResult{}, err
	}
	targetConn, dstDB, err := s.getPool(req.TargetConnectionID, req.TargetDatabase)
	if err != nil {
		return DataMigrationResult{}, err
	}
	if targetConn.ReadOnlyFlag {
		return DataMigrationResult{}, errors.New("target connection is read-only")
	}

	srcConn, ok := s.store.GetConnection(req.SourceConnectionID)
	if !ok {
		return DataMigrationResult{}, errors.New("source connection not found")
	}
	srcTableRef := tableRef(srcConn.Driver, req.SourceSchema, req.SourceTable)
	dstTableRef := tableRef(targetConn.Driver, req.TargetSchema, req.TargetTable)

	sourceSchema, err := s.GetTableSchema(TableSchemaRequest{
		ConnectionID: req.SourceConnectionID,
		Database:     req.SourceDatabase,
		Schema:       req.SourceSchema,
		Table:        req.SourceTable,
	})
	if err != nil {
		return DataMigrationResult{}, err
	}
	if len(sourceSchema.Columns) == 0 {
		return DataMigrationResult{MigratedRows: 0, Message: "No columns to migrate"}, nil
	}
	columns := tableSchemaColumnNames(sourceSchema.Columns)
	if len(columns) == 0 {
		return DataMigrationResult{MigratedRows: 0, Message: "No columns to migrate"}, nil
	}
	if err := ensureMigrationTargetTable(ctx, dstDB, targetConn, req, sourceSchema); err != nil {
		return DataMigrationResult{}, err
	}

	rows, err := srcDB.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %s", strings.Join(quoteColumns(srcConn.Driver, columns), ","), srcTableRef))
	if err != nil {
		return DataMigrationResult{}, err
	}
	defer rows.Close()

	tx, err := dstDB.BeginTx(ctx, nil)
	if err != nil {
		return DataMigrationResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if req.TruncateTarget {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("TRUNCATE TABLE %s", dstTableRef)); err != nil {
			return DataMigrationResult{}, err
		}
	}

	migrated := int64(0)
	batchSize := migrationBatchSize(targetConn.Driver, len(columns), req.BatchSize)
	batch := make([][]any, 0, batchSize)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := execMigrationInsertBatch(ctx, tx, targetConn.Driver, dstTableRef, columns, batch); err != nil {
			return err
		}
		migrated += int64(len(batch))
		batch = batch[:0]
		return nil
	}
	for rows.Next() {
		values := make([]any, len(columns))
		refs := make([]any, len(columns))
		for i := range values {
			refs[i] = &values[i]
		}
		if err := rows.Scan(refs...); err != nil {
			return DataMigrationResult{}, err
		}
		batch = append(batch, values)
		if len(batch) >= batchSize {
			if err := flush(); err != nil {
				return DataMigrationResult{}, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return DataMigrationResult{}, err
	}
	if err := flush(); err != nil {
		return DataMigrationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DataMigrationResult{}, err
	}

	return DataMigrationResult{
		MigratedRows: migrated,
		Message:      fmt.Sprintf("Migration completed, %d rows copied", migrated),
	}, nil
}

func ensureMigrationTargetTable(ctx context.Context, db *sql.DB, targetConn ConnectionMeta, req DataMigrationRequest, sourceSchema TableSchema) error {
	exists, err := migrationTargetTableExists(ctx, db, targetConn, req.TargetDatabase, req.TargetSchema, req.TargetTable)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	ddl := buildMigrationCreateTableSQL(targetConn.Driver, req.TargetSchema, req.TargetTable, sourceSchema)
	_, err = db.ExecContext(ctx, ddl)
	return err
}

func migrationTargetTableExists(ctx context.Context, db *sql.DB, conn ConnectionMeta, database, schema, table string) (bool, error) {
	if conn.Driver == "mysql" {
		dbName := fallback(database, conn.DefaultDB)
		var count int
		err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`, dbName, table).Scan(&count)
		return count > 0, err
	}
	schemaName := fallback(schema, "public")
	var count int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, schemaName, table).Scan(&count)
	return count > 0, err
}

func buildMigrationCreateTableSQL(driver, schema, table string, sourceSchema TableSchema) string {
	defs := make([]string, 0, len(sourceSchema.Columns)+1)
	for _, col := range sourceSchema.Columns {
		parts := []string{quoteIdentifier(driver, col.Name), migrationColumnType(driver, col)}
		if col.AutoIncrement && driver == "mysql" {
			parts = append(parts, "AUTO_INCREMENT")
		}
		if !col.Nullable || col.PrimaryKey {
			parts = append(parts, "NOT NULL")
		}
		defs = append(defs, strings.Join(parts, " "))
	}
	if len(sourceSchema.PrimaryKey) > 0 {
		defs = append(defs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(quoteColumns(driver, sourceSchema.PrimaryKey), ",")))
	}
	return fmt.Sprintf("CREATE TABLE %s (%s)", tableRef(driver, schema, table), strings.Join(defs, ","))
}

func tableSchemaColumnNames(columns []TableColumnSchema) []string {
	names := make([]string, 0, len(columns))
	for _, col := range columns {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}

func migrationColumnType(driver string, col TableColumnSchema) string {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	if raw == "" {
		return "TEXT"
	}
	if driver == "mysql" {
		return migrationColumnTypeForMySQL(raw, col.AutoIncrement)
	}
	return migrationColumnTypeForPostgres(raw, col.AutoIncrement)
}

func migrationColumnTypeForMySQL(raw string, autoIncrement bool) string {
	if autoIncrement {
		if strings.Contains(raw, "big") {
			return "BIGINT"
		}
		return "INT"
	}
	switch {
	case strings.Contains(raw, "bigserial"), strings.Contains(raw, "bigint"):
		return "BIGINT"
	case strings.Contains(raw, "smallserial"), strings.Contains(raw, "smallint"):
		return "SMALLINT"
	case strings.Contains(raw, "serial"), strings.Contains(raw, "integer"), raw == "int":
		return "INT"
	case strings.Contains(raw, "boolean"), raw == "bool":
		return "BOOLEAN"
	case strings.Contains(raw, "double precision"):
		return "DOUBLE"
	case strings.Contains(raw, "real"):
		return "FLOAT"
	case strings.Contains(raw, "numeric"), strings.Contains(raw, "decimal"):
		return "DECIMAL"
	case strings.Contains(raw, "timestamp"):
		return "TIMESTAMP"
	case raw == "date":
		return "DATE"
	case strings.Contains(raw, "time"):
		return "TIME"
	case strings.Contains(raw, "json"):
		return "JSON"
	case strings.Contains(raw, "bytea"), strings.Contains(raw, "blob"), strings.Contains(raw, "binary"):
		return "LONGBLOB"
	case strings.Contains(raw, "char"), strings.Contains(raw, "varchar"), strings.Contains(raw, "character varying"):
		if strings.Contains(raw, "(") {
			return strings.ToUpper(strings.ReplaceAll(raw, "character varying", "varchar"))
		}
		return "VARCHAR(255)"
	case strings.Contains(raw, "text"):
		return "LONGTEXT"
	default:
		return strings.ToUpper(raw)
	}
}

func migrationColumnTypeForPostgres(raw string, autoIncrement bool) string {
	if autoIncrement {
		if strings.Contains(raw, "big") {
			return "BIGSERIAL"
		}
		return "SERIAL"
	}
	switch {
	case strings.Contains(raw, "bigint"):
		return "BIGINT"
	case strings.Contains(raw, "smallint"):
		return "SMALLINT"
	case strings.Contains(raw, "tinyint"), strings.Contains(raw, "mediumint"), strings.Contains(raw, "int"):
		return "INTEGER"
	case strings.Contains(raw, "bool"), raw == "bit(1)":
		return "BOOLEAN"
	case strings.Contains(raw, "double"):
		return "DOUBLE PRECISION"
	case strings.Contains(raw, "float"):
		return "REAL"
	case strings.Contains(raw, "decimal"), strings.Contains(raw, "numeric"):
		return "NUMERIC"
	case strings.Contains(raw, "datetime"), strings.Contains(raw, "timestamp"):
		return "TIMESTAMP"
	case raw == "date":
		return "DATE"
	case strings.HasPrefix(raw, "time"):
		return "TIME"
	case strings.Contains(raw, "json"):
		return "JSONB"
	case strings.Contains(raw, "blob"), strings.Contains(raw, "binary"), strings.Contains(raw, "bytea"):
		return "BYTEA"
	case strings.Contains(raw, "varchar"):
		return strings.ToUpper(regexp.MustCompile(`(?i)varchar`).ReplaceAllString(raw, "VARCHAR"))
	case strings.Contains(raw, "char"):
		return "VARCHAR(255)"
	case strings.Contains(raw, "text"), strings.Contains(raw, "enum"), strings.Contains(raw, "set"):
		return "TEXT"
	default:
		return strings.ToUpper(raw)
	}
}

func migrationDefaultValueAllowed(driver, value string) bool {
	v := strings.TrimSpace(strings.ToLower(value))
	if v == "" || v == "null" {
		return false
	}
	if driver == "postgres" && strings.Contains(v, "::") {
		return false
	}
	return true
}

func normalizeMigrationBatchSize(size int) int {
	switch size {
	case 200, 500, 1000:
		return size
	default:
		return 500
	}
}

func migrationBatchSize(driver string, columnCount, requested int) int {
	if columnCount <= 0 {
		return 1
	}
	size := normalizeMigrationBatchSize(requested)
	if driver == "postgres" {
		limit := 60000 / columnCount
		if limit < size {
			size = limit
		}
	}
	if size < 1 {
		return 1
	}
	return size
}

func execMigrationInsertBatch(ctx context.Context, tx *sql.Tx, driver, dstTableRef string, columns []string, rows [][]any) error {
	if len(rows) == 0 {
		return nil
	}
	colSQL := quoteColumns(driver, columns)
	valueGroups := make([]string, 0, len(rows))
	args := make([]any, 0, len(rows)*len(columns))
	argPos := 1
	for _, row := range rows {
		holders := make([]string, 0, len(columns))
		for i := range columns {
			holders = append(holders, placeholder(driver, argPos))
			args = append(args, row[i])
			argPos++
		}
		valueGroups = append(valueGroups, "("+strings.Join(holders, ",")+")")
	}
	insertSQL := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES %s",
		dstTableRef,
		strings.Join(colSQL, ","),
		strings.Join(valueGroups, ","),
	)
	_, err := tx.ExecContext(ctx, insertSQL, args...)
	return err
}

func (s *DatabaseService) markMigrationTableRunning(jobID, table string) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil || job.status != "running" {
		return
	}
	if idx := migrationTableIndex(job, table); idx >= 0 && job.tables[idx].Status == "pending" {
		job.tables[idx].Status = "running"
		job.tables[idx].StartedAt = time.Now()
	}
}

func (s *DatabaseService) markMigrationTableSuccess(jobID, table string, result DataMigrationResult) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil || job.status == "canceled" {
		return
	}
	if idx := migrationTableIndex(job, table); idx >= 0 {
		job.tables[idx].Status = "success"
		job.tables[idx].MigratedRows = result.MigratedRows
		job.tables[idx].Message = result.Message
		job.tables[idx].Error = ""
		job.tables[idx].EndedAt = time.Now()
	}
}

func (s *DatabaseService) markMigrationTableFailed(jobID, table string, err error) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil {
		return
	}
	if idx := migrationTableIndex(job, table); idx >= 0 {
		if job.status == "canceled" {
			job.tables[idx].Status = "canceled"
			job.tables[idx].Error = "Migration canceled"
			job.tables[idx].EndedAt = time.Now()
			return
		}
		job.tables[idx].Status = "failed"
		job.tables[idx].Error = err.Error()
		job.tables[idx].EndedAt = time.Now()
	}
}

func (s *DatabaseService) markMigrationTableCanceled(jobID, table string) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil {
		return
	}
	if idx := migrationTableIndex(job, table); idx >= 0 && (job.tables[idx].Status == "pending" || job.tables[idx].Status == "running") {
		job.tables[idx].Status = "canceled"
		job.tables[idx].Error = "Migration canceled"
		job.tables[idx].EndedAt = time.Now()
	}
}

func (s *DatabaseService) finishMigrationJob(jobID string) {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	job := s.migrationJobs[jobID]
	if job == nil || job.status != "running" {
		return
	}
	snapshot := s.snapshotMigrationJobLocked(job)
	job.endedAt = time.Now()
	if snapshot.Failed > 0 {
		job.status = "failed"
		job.message = fmt.Sprintf("Migration completed with errors: %d succeeded, %d failed", snapshot.Success, snapshot.Failed)
		return
	}
	job.status = "success"
	job.message = fmt.Sprintf("Migration completed: %d tables succeeded", snapshot.Success)
}

func (s *DatabaseService) snapshotMigrationJob(job *dataMigrationJob) DataMigrationJobSnapshot {
	s.migrationMu.Lock()
	defer s.migrationMu.Unlock()
	return s.snapshotMigrationJobLocked(job)
}

func (s *DatabaseService) snapshotMigrationJobLocked(job *dataMigrationJob) DataMigrationJobSnapshot {
	tables := make([]DataMigrationTableStatus, len(job.tables))
	copy(tables, job.tables)
	snapshot := DataMigrationJobSnapshot{
		JobID:       job.id,
		Status:      job.status,
		WorkerCount: job.workerCount,
		BatchSize:   job.req.BatchSize,
		Total:       len(tables),
		Tables:      tables,
		StartedAt:   job.startedAt,
		EndedAt:     job.endedAt,
		Message:     job.message,
	}
	for _, table := range tables {
		switch table.Status {
		case "pending":
			snapshot.Pending++
		case "running":
			snapshot.Running++
		case "success":
			snapshot.Success++
		case "failed":
			snapshot.Failed++
		}
	}
	return snapshot
}

func migrationTableIndex(job *dataMigrationJob, table string) int {
	for i := range job.tables {
		if job.tables[i].Table == table {
			return i
		}
	}
	return -1
}

func clampMigrationWorkerCount(count int) int {
	if count < 1 {
		return 2
	}
	if count > 8 {
		return 8
	}
	return count
}

func (s *DatabaseService) getPool(connectionID, overrideDB string) (ConnectionMeta, *sql.DB, error) {
	conn, ok := s.store.GetConnection(connectionID)
	if !ok {
		return ConnectionMeta{}, nil, errors.New("connection not found")
	}
	password, err := s.secrets.GetConnectionSecret(connectionID)
	if err != nil {
		return ConnectionMeta{}, nil, err
	}
	dbName := fallback(overrideDB, conn.DefaultDB)
	poolKey := connectionID + "::" + dbName

	s.mu.Lock()
	if db := s.pools[poolKey]; db != nil {
		s.mu.Unlock()
		return conn, db, nil
	}
	s.mu.Unlock()

	dsn := buildDSN(conn, password, dbName)
	db, err := sql.Open(sqlDriverName(conn.Driver), dsn)
	if err != nil {
		return ConnectionMeta{}, nil, err
	}

	// Optimized connection pool configuration
	maxOpen := 50
	maxIdle := 10
	db.SetConnMaxLifetime(10 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetMaxIdleConns(maxIdle)
	db.SetMaxOpenConns(maxOpen)

	if err := db.Ping(); err != nil {
		return ConnectionMeta{}, nil, err
	}
	s.store.UpdateConnectionHealth(connectionID, true, "")

	s.mu.Lock()
	s.pools[poolKey] = db
	s.mu.Unlock()
	return conn, db, nil
}

func (s *DatabaseService) registerRunning(id string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running[id] = cancel
}

func (s *DatabaseService) unregisterRunning(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.running, id)
}

func buildDSN(conn ConnectionMeta, password, db string) string {
	if conn.Driver == "postgres" {
		sslMode := fallback(conn.SSLMode, "disable")
		if db == "" {
			db = "postgres"
		}
		return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s", conn.User, password, conn.Host, conn.Port, db, sslMode)
	}
	params := "parseTime=true&multiStatements=true&columnsWithAlias=true"
	if db == "" {
		db = "mysql"
	}
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?%s", conn.User, password, conn.Host, conn.Port, db, params)
}

func sqlDriverName(driver string) string {
	if driver == "postgres" {
		return "pgx"
	}
	return "mysql"
}

func columnDatabaseTypeNames(rows *sql.Rows) ([]string, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	out := make([]string, len(types))
	for i, ct := range types {
		out[i] = strings.ToLower(strings.TrimSpace(ct.DatabaseTypeName()))
	}
	return out, nil
}

func splitStatements(sqlText string) []string {
	parts := strings.Split(sqlText, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return out
}

func normalizeValue(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format(time.RFC3339Nano)
	default:
		return t
	}
}

// splitQualifiedColumnName 解析驱动返回的「表.列」形式列名（如 MySQL columnsWithAlias）。
func splitQualifiedColumnName(raw string) (table, col string, ok bool) {
	i := strings.LastIndex(raw, ".")
	if i <= 0 || i >= len(raw)-1 {
		return "", "", false
	}
	table = strings.Trim(raw[:i], "`\"")
	col = strings.Trim(raw[i+1:], "`\"")
	if table == "" || col == "" {
		return "", "", false
	}
	return table, col, true
}

// disambiguateQueryColumns 为重复列名生成唯一展示名（亦作为 JSON/表格 map 的键）：同名列显示为「列名 (表名)」；
// 若仅有裸列名重复（如部分驱动下的 JOIN），则使用「列名 (序号)」区分。
func disambiguateQueryColumns(raw []string) []string {
	n := len(raw)
	display := make([]string, n)
	if n == 0 {
		return display
	}
	shortNames := make([]string, n)
	qualified := make([]bool, n)
	tables := make([]string, n)
	for i, r := range raw {
		t, c, ok := splitQualifiedColumnName(r)
		if ok {
			qualified[i] = true
			tables[i] = t
			shortNames[i] = c
		} else {
			shortNames[i] = r
		}
	}
	counts := make(map[string]int, n)
	for _, s := range shortNames {
		counts[s]++
	}
	dupBare := make(map[string]int)
	for i := range raw {
		sn := shortNames[i]
		if counts[sn] <= 1 {
			if qualified[i] {
				display[i] = sn
			} else {
				display[i] = raw[i]
			}
			continue
		}
		if qualified[i] {
			display[i] = fmt.Sprintf("%s (%s)", sn, tables[i])
			continue
		}
		dupBare[sn]++
		k := dupBare[sn]
		display[i] = fmt.Sprintf("%s (%d)", sn, k)
	}
	return display
}

func quoteIdentifier(driver, name string) string {
	if driver == "postgres" {
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func tableRef(driver, schema, table string) string {
	if schema == "" {
		return quoteIdentifier(driver, table)
	}
	return quoteIdentifier(driver, schema) + "." + quoteIdentifier(driver, table)
}

func placeholder(driver string, idx int) string {
	if driver == "postgres" {
		return "$" + strconv.Itoa(idx)
	}
	return "?"
}

func quoteColumns(driver string, cols []string) []string {
	out := make([]string, len(cols))
	for i, c := range cols {
		out[i] = quoteIdentifier(driver, c)
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func contains(items []string, item string) bool {
	for _, v := range items {
		if v == item {
			return true
		}
	}
	return false
}

func uniqueNonEmpty(items []string) []string {
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

// sortedNonKeyColumns returns non-PK column names in stable order for SET / preview.
func sortedNonKeyColumns(row map[string]any, keyColumns []string) []string {
	var keys []string
	for k := range row {
		if contains(keyColumns, k) {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func buildUpdateStatementPreview(driver, schema, table string, keyColumns []string, row map[string]any, setKeys []string) string {
	tref := tableRef(driver, schema, table)
	setParts := make([]string, 0, len(setKeys))
	for _, k := range setKeys {
		setParts = append(setParts, fmt.Sprintf("%s=%s", quoteIdentifier(driver, k), formatSQLLiteralForPreview(driver, row[k])))
	}
	whereParts := make([]string, 0, len(keyColumns))
	for _, k := range keyColumns {
		whereParts = append(whereParts, fmt.Sprintf("%s=%s", quoteIdentifier(driver, k), formatSQLLiteralForPreview(driver, row[k])))
	}
	return fmt.Sprintf("UPDATE %s SET %s WHERE %s", tref, strings.Join(setParts, ", "), strings.Join(whereParts, " AND "))
}

func buildInsertStatementPreview(driver, schema, table string, columns []string, row map[string]any) string {
	tref := tableRef(driver, schema, table)
	colList := quoteColumns(driver, columns)
	values := make([]string, 0, len(columns))
	for _, col := range columns {
		values = append(values, formatSQLLiteralForPreview(driver, row[col]))
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", tref, strings.Join(colList, ", "), strings.Join(values, ", "))
}

func sqlStringLiteralForPreview(driver, s string) string {
	if driver == "postgres" {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	// MySQL: 默认模式下反斜杠与单引号均需处理，便于复制到客户端执行
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "''")
	return "'" + s + "'"
}

func sqlTimeLiteralStringForPreview(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02 15:04:05")
	}
	return strings.TrimRight(strings.TrimRight(t.Format("2006-01-02 15:04:05.999999"), "0"), ".")
}

func parseRFC3339TimeStringForPreview(s string) (time.Time, bool) {
	if !strings.Contains(s, "T") {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func formatSQLLiteralForPreview(driver string, v any) string {
	if v == nil {
		return "NULL"
	}
	switch t := v.(type) {
	case bool:
		if driver == "postgres" {
			if t {
				return "TRUE"
			}
			return "FALSE"
		}
		if t {
			return "1"
		}
		return "0"
	case int:
		return strconv.Itoa(t)
	case int32:
		return strconv.FormatInt(int64(t), 10)
	case int64:
		return strconv.FormatInt(t, 10)
	case uint:
		return strconv.FormatUint(uint64(t), 10)
	case uint32:
		return strconv.FormatUint(uint64(t), 10)
	case uint64:
		return strconv.FormatUint(t, 10)
	case float32:
		return strconv.FormatFloat(float64(t), 'g', -1, 32)
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	case []byte:
		if len(t) == 0 {
			if driver == "postgres" {
				return "''::bytea"
			}
			return "X''"
		}
		h := strings.ToUpper(hex.EncodeToString(t))
		if driver == "postgres" {
			return "'\\x" + h + "'::bytea"
		}
		return "X'" + h + "'"
	case string:
		if parsed, ok := parseRFC3339TimeStringForPreview(t); ok {
			return sqlStringLiteralForPreview(driver, sqlTimeLiteralStringForPreview(parsed))
		}
		return sqlStringLiteralForPreview(driver, t)
	case time.Time:
		return sqlStringLiteralForPreview(driver, sqlTimeLiteralStringForPreview(t))
	default:
		return sqlStringLiteralForPreview(driver, fmt.Sprint(t))
	}
}
