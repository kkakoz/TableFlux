package main

import (
	"context"
	"database/sql"
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
	defaultRLS int
}

func NewDatabaseService(store *DataStore, secrets *SecretService) *DatabaseService {
	return &DatabaseService{
		store:      store,
		secrets:    secrets,
		pools:      map[string]*sql.DB{},
		running:    map[string]context.CancelFunc{},
		defaultRLS: 5000,
	}
}

func (s *DatabaseService) ServiceName() string {
	return "DatabaseService"
}

func (s *DatabaseService) ExecuteSQL(req ExecuteSQLRequest) (SQLExecutionResult, error) {
	if req.ConnectionID == "" {
		return SQLExecutionResult{}, errors.New("connectionId is required")
	}
	if strings.TrimSpace(req.SQL) == "" {
		return SQLExecutionResult{}, errors.New("sql is required")
	}
	if req.RowLimit <= 0 {
		req.RowLimit = s.defaultRLS
	}
	if req.TimeoutMs <= 0 {
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

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.TimeoutMs)*time.Millisecond)
	queryToken := uuid.NewString()
	s.registerRunning(queryToken, cancel)
	defer s.unregisterRunning(queryToken)

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
		resultRows := make([]map[string]any, 0)
		truncated := false
		for rows.Next() {
			if len(resultRows) >= req.RowLimit {
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
		message := fmt.Sprintf("Query finished (%d rows)", len(resultRows))
		if truncated {
			message = fmt.Sprintf("Query finished (%d rows, truncated by row limit)", len(resultRows))
		}
		return SQLExecutionResult{
			Columns:    displayCols,
			Rows:       resultRows,
			Message:    message,
			Truncated:  truncated,
			DurationMs: time.Since(started).Milliseconds(),
		}, nil
	}

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

func (s *DatabaseService) CancelRunningQuery() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cancel := range s.running {
		cancel()
	}
	s.running = map[string]context.CancelFunc{}
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
		TimeoutMs:    30000,
		Mode:         "single",
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
		Columns:    displayCols,
		Rows:       resultRows,
		Total:      total,
		Offset:     req.Offset,
		Limit:      req.Limit,
		DurationMs: time.Since(started).Milliseconds(),
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
		for k, v := range row {
			if contains(req.KeyColumns, k) {
				continue
			}
			setCols = append(setCols, fmt.Sprintf("%s=%s", quoteIdentifier(conn.Driver, k), placeholder(conn.Driver, argPos)))
			args = append(args, v)
			argPos++
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

func (s *DatabaseService) MigrateTableData(req DataMigrationRequest) (DataMigrationResult, error) {
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

	rows, err := srcDB.Query(fmt.Sprintf("SELECT * FROM %s", srcTableRef))
	if err != nil {
		return DataMigrationResult{}, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return DataMigrationResult{}, err
	}
	if len(columns) == 0 {
		return DataMigrationResult{MigratedRows: 0, Message: "No columns to migrate"}, nil
	}

	tx, err := dstDB.Begin()
	if err != nil {
		return DataMigrationResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if req.TruncateTarget {
		if _, err := tx.Exec(fmt.Sprintf("TRUNCATE TABLE %s", dstTableRef)); err != nil {
			return DataMigrationResult{}, err
		}
	}

	colSQL := quoteColumns(targetConn.Driver, columns)
	holders := make([]string, 0, len(columns))
	for i := range columns {
		holders = append(holders, placeholder(targetConn.Driver, i+1))
	}
	insertSQL := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES (%s)",
		dstTableRef,
		strings.Join(colSQL, ","),
		strings.Join(holders, ","),
	)
	stmt, err := tx.Prepare(insertSQL)
	if err != nil {
		return DataMigrationResult{}, err
	}
	defer stmt.Close()

	migrated := int64(0)
	for rows.Next() {
		values := make([]any, len(columns))
		refs := make([]any, len(columns))
		for i := range values {
			refs[i] = &values[i]
		}
		if err := rows.Scan(refs...); err != nil {
			return DataMigrationResult{}, err
		}
		if _, err := stmt.Exec(values...); err != nil {
			return DataMigrationResult{}, err
		}
		migrated++
	}
	if err := rows.Err(); err != nil {
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
