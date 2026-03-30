package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type AssistService struct {
	llm        *LLMService
	schemaRepo SchemaRepository
}

func NewAssistService(llm *LLMService, schemaRepo SchemaRepository) *AssistService {
	return &AssistService{
		llm:        llm,
		schemaRepo: schemaRepo,
	}
}

// ========= 对前端暴露的请求/响应结构 =========

type AssistRequest struct {
	Dialect      string `json:"dialect"`      // mysql / postgres / sqlite ...
	InputText    string `json:"inputText"`    // 用户自然语言输入
	SelectedText string `json:"selectedText"` // 编辑器中选中的SQL，可为空
	DatabaseName string `json:"databaseName"` // 当前数据库名，可选
}

type AssistResponse struct {
	Intent         string   `json:"intent"`
	Type           string   `json:"type"` // sql / explanation / rewrite / error
	Content        string   `json:"content"`
	Explanation    string   `json:"explanation,omitempty"`
	RelevantTables []string `json:"relevantTables,omitempty"`
	Reason         string   `json:"reason,omitempty"`
}

// ========= 第一轮 / 第二轮模型输出结构 =========

type TableSelectResult struct {
	Intent         string   `json:"intent"`
	RelevantTables []string `json:"relevantTables"`
	Reason         string   `json:"reason"`
}

type FinalResult struct {
	Type        string   `json:"type"` // sql / explanation / rewrite
	Content     string   `json:"content"`
	Explanation string   `json:"explanation,omitempty"`
	Tables      []string `json:"tables,omitempty"`
}

// ========= Schema 抽象 =========

type SchemaRepository interface {
	// 获取当前库下所有表的简要信息，供第一轮选表
	ListTableSummaries(ctx context.Context, databaseName string) ([]TableSummary, error)

	// 根据表名获取详细 schema，供第二轮生成 SQL
	GetTablesSchema(ctx context.Context, databaseName string, tableNames []string) ([]TableSchema, error)
}

type TableSummary struct {
	Name    string `json:"name"`
	Comment string `json:"comment,omitempty"`
}

type TableSchema struct {
	Name    string        `json:"name"`
	Comment string        `json:"comment,omitempty"`
	Columns []TableColumn `json:"columns"`
}

type TableColumn struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Comment  string `json:"comment,omitempty"`
	Nullable bool   `json:"nullable"`
}

// ========= 对外主方法 =========

func (s *AssistService) Assist(req AssistRequest) (*AssistResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if strings.TrimSpace(req.InputText) == "" && strings.TrimSpace(req.SelectedText) == "" {
		return nil, fmt.Errorf("inputText and selectedText cannot both be empty")
	}

	// 1. 取表摘要
	tableSummaries, err := s.schemaRepo.ListTableSummaries(ctx, req.DatabaseName)
	if err != nil {
		return nil, fmt.Errorf("list table summaries failed: %w", err)
	}

	// 2. 第一轮：选表 + 判断意图
	selectPrompt, err := buildTableSelectUserPrompt(req, tableSummaries)
	if err != nil {
		return nil, fmt.Errorf("build first round prompt failed: %w", err)
	}

	var selectResult TableSelectResult
	err = s.llm.ChatJSON(ctx, firstRoundSystemPrompt, selectPrompt, &selectResult)
	if err != nil {
		return nil, fmt.Errorf("first round ai failed: %w", err)
	}

	// 容错处理
	selectResult.Intent = normalizeIntent(selectResult.Intent)
	selectResult.RelevantTables = deduplicateNonEmpty(selectResult.RelevantTables)

	// 没选出表时，也允许继续走；但生成 SQL 的效果可能受影响
	var tableSchemas []TableSchema
	if len(selectResult.RelevantTables) > 0 {
		tableSchemas, err = s.schemaRepo.GetTablesSchema(ctx, req.DatabaseName, selectResult.RelevantTables)
		if err != nil {
			return nil, fmt.Errorf("get table schemas failed: %w", err)
		}
	}

	// 3. 第二轮：生成最终结果
	finalPrompt, err := buildFinalRoundUserPrompt(req, selectResult, tableSchemas)
	if err != nil {
		return nil, fmt.Errorf("build second round prompt failed: %w", err)
	}

	var finalResult FinalResult
	err = s.llm.ChatJSON(ctx, secondRoundSystemPrompt, finalPrompt, &finalResult)
	if err != nil {
		return nil, fmt.Errorf("second round ai failed: %w", err)
	}

	finalResult.Type = normalizeFinalType(finalResult.Type)

	resp := &AssistResponse{
		Intent:         selectResult.Intent,
		Type:           finalResult.Type,
		Content:        strings.TrimSpace(finalResult.Content),
		Explanation:    strings.TrimSpace(finalResult.Explanation),
		RelevantTables: selectResult.RelevantTables,
		Reason:         strings.TrimSpace(selectResult.Reason),
	}

	return resp, nil
}

// ========= Prompt =========

const firstRoundSystemPrompt = `
你是数据库客户端中的 AI 助手，负责理解用户需求，并从给定表中挑选最相关的表。

请严格输出 JSON，不要输出 markdown，不要输出代码块，不要输出额外说明。

输出格式：
{
  "intent": "generate_sql | explain_sql | rewrite_sql",
  "relevantTables": ["table1", "table2"],
  "reason": "简短说明原因"
}

规则：
1. intent 只能是:
   - generate_sql: 用户要根据自然语言生成 SQL
   - explain_sql: 用户要解释一段已存在 SQL
   - rewrite_sql: 用户要改写/优化一段已存在 SQL
2. relevantTables 最多返回 5 个
3. 如果是 explain_sql 且主要依赖 selectedText，可返回空表数组
4. 只返回合法 JSON
`

const secondRoundSystemPrompt = `
你是数据库客户端中的 AI SQL 助手。

请严格输出 JSON，不要输出 markdown，不要输出代码块，不要输出额外说明。

输出格式：
{
  "type": "sql | explanation | rewrite",
  "content": "主要结果内容",
  "explanation": "补充解释"
}

规则：
1. 如果 intent=generate_sql，则 type 返回 sql，content 返回可执行 SQL
2. 如果 intent=explain_sql，则 type 返回 explanation，content 返回对 SQL 的解释
3. 如果 intent=rewrite_sql，则 type 返回 rewrite，content 返回改写后的 SQL
4. explanation 字段可选，但尽量给出简洁说明
5. SQL 要和 dialect 匹配
6. 仅返回合法 JSON
`

// ========= Prompt 构建 =========

func buildTableSelectUserPrompt(req AssistRequest, tables []TableSummary) (string, error) {
	payload := map[string]any{
		"dialect":      req.Dialect,
		"databaseName": req.DatabaseName,
		"inputText":    req.InputText,
		"selectedText": req.SelectedText,
		"tables":       tables,
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func buildFinalRoundUserPrompt(req AssistRequest, selectResult TableSelectResult, schemas []TableSchema) (string, error) {
	payload := map[string]any{
		"dialect":        req.Dialect,
		"databaseName":   req.DatabaseName,
		"inputText":      req.InputText,
		"selectedText":   req.SelectedText,
		"intent":         selectResult.Intent,
		"relevantTables": selectResult.RelevantTables,
		"reason":         selectResult.Reason,
		"schemas":        schemas,
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ========= 工具函数 =========

func normalizeIntent(s string) string {
	switch strings.TrimSpace(strings.ToLower(s)) {
	case "generate_sql":
		return "generate_sql"
	case "explain_sql":
		return "explain_sql"
	case "rewrite_sql":
		return "rewrite_sql"
	default:
		return "generate_sql"
	}
}

func normalizeFinalType(s string) string {
	switch strings.TrimSpace(strings.ToLower(s)) {
	case "sql":
		return "sql"
	case "explanation":
		return "explanation"
	case "rewrite":
		return "rewrite"
	default:
		return "sql"
	}
}

func deduplicateNonEmpty(items []string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(items))

	for _, item := range items {
		v := strings.TrimSpace(item)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		result = append(result, v)
	}

	if len(result) > 5 {
		result = result[:5]
	}
	return result
}
