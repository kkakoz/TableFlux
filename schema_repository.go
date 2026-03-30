package main

import (
	"context"
	"fmt"
	"strings"

	"changeme/chat"
)

// DatabaseSchemaRepository 使用 DatabaseService 读取当前连接、当前库下的真实表列表与列信息。
type DatabaseSchemaRepository struct {
	db *DatabaseService
}

func NewDatabaseSchemaRepository(db *DatabaseService) *DatabaseSchemaRepository {
	return &DatabaseSchemaRepository{db: db}
}

func (r *DatabaseSchemaRepository) ListTableSummaries(_ context.Context, connectionID, databaseName string) ([]chat.TableSummary, error) {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return nil, fmt.Errorf("未选择数据库连接，无法加载表列表")
	}
	dbName := strings.TrimSpace(databaseName)
	if dbName == "" {
		return nil, fmt.Errorf("未选择数据库")
	}
	tables, err := r.db.ListTables(connectionID, dbName, "")
	if err != nil {
		return nil, err
	}
	out := make([]chat.TableSummary, 0, len(tables))
	for _, t := range tables {
		out = append(out, chat.TableSummary{Name: t.Name})
	}
	return out, nil
}

func (r *DatabaseSchemaRepository) GetTablesSchema(_ context.Context, connectionID, databaseName string, tableNames []string) ([]chat.TableSchema, error) {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return nil, fmt.Errorf("未选择数据库连接")
	}
	dbName := strings.TrimSpace(databaseName)
	if dbName == "" {
		return nil, fmt.Errorf("未选择数据库")
	}
	out := make([]chat.TableSchema, 0, 0)
	for _, raw := range tableNames {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		realName, err := r.resolveTableName(connectionID, dbName, name)
		if err != nil {
			return nil, err
		}
		ts, err := r.db.GetTableSchema(TableSchemaRequest{
			ConnectionID: connectionID,
			Database:     dbName,
			Schema:       "",
			Table:        realName,
		})
		if err != nil {
			return nil, fmt.Errorf("读取表 %s 结构失败: %w", realName, err)
		}
		out = append(out, mapTableSchemaToChat(ts))
	}
	return out, nil
}

func (r *DatabaseSchemaRepository) resolveTableName(connectionID, database, want string) (string, error) {
	tables, err := r.db.ListTables(connectionID, database, "")
	if err != nil {
		return "", err
	}
	want = strings.TrimSpace(want)
	for _, t := range tables {
		if strings.EqualFold(t.Name, want) {
			return t.Name, nil
		}
	}
	return want, nil
}

func mapTableSchemaToChat(in TableSchema) chat.TableSchema {
	cols := make([]chat.TableColumn, 0, len(in.Columns))
	for _, c := range in.Columns {
		cols = append(cols, chat.TableColumn{
			Name:     c.Name,
			Type:     c.Type,
			Comment:  c.Comment,
			Nullable: c.Nullable,
		})
	}
	return chat.TableSchema{
		Name:    in.Name,
		Comment: in.Comment,
		Columns: cols,
	}
}
