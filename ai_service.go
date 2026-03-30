package main

import (
	"fmt"
	"strings"

	"changeme/chat"
)

type AIService struct {
	settings   *SettingsService
	schemaRepo chat.SchemaRepository
}

func NewAIService(settings *SettingsService, db *DatabaseService) *AIService {
	return &AIService{
		settings:   settings,
		schemaRepo: NewDatabaseSchemaRepository(db),
	}
}

func (s *AIService) ServiceName() string {
	return "AIService"
}

// SaveAIConfig 与设置页使用同一存储（settings.json），保持与 SettingsService.SaveAIConfig 行为一致。
func (s *AIService) SaveAIConfig(apiKey, apiUrl, modelName string) error {
	return s.settings.SaveAIConfig(apiKey, apiUrl, modelName)
}

func (s *AIService) loadAIConfig() (apiKey, apiURL, modelName string, err error) {
	key, url, model := s.settings.GetAIConfig()
	key = strings.TrimSpace(key)
	url = strings.TrimSpace(url)
	model = strings.TrimSpace(model)
	if key == "" || url == "" || model == "" {
		return "", "", "", fmt.Errorf("未配置 AI：请在设置中填写 API Key、Base URL 与模型")
	}
	return key, url, model, nil
}

// Assist 两轮对话：选表与意图 → 生成 SQL / 解释 / 改写。
func (s *AIService) Assist(req AssistRequest) (*AssistResponse, error) {
	apiKey, apiURL, modelName, err := s.loadAIConfig()
	if err != nil {
		return nil, err
	}
	llm := chat.NewLLMService(apiKey, apiURL, modelName)
	assist := chat.NewAssistService(llm, s.schemaRepo)
	cr := chat.AssistRequest{
		Dialect:      req.Dialect,
		InputText:    req.InputText,
		SelectedText: req.SelectedText,
		DatabaseName: req.DatabaseName,
		ConnectionID: req.ConnectionID,
	}
	r, err := assist.Assist(cr)
	if err != nil {
		return nil, err
	}
	return &AssistResponse{
		Intent:         r.Intent,
		Type:           r.Type,
		Content:        r.Content,
		Explanation:    r.Explanation,
		RelevantTables: r.RelevantTables,
		Reason:         r.Reason,
	}, nil
}
