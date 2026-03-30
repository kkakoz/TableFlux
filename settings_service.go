package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Settings struct {
	Theme           string `json:"theme"`           // light, dark, system
	Language        string `json:"language"`        // zh-CN, en-US
	AutoSave        bool   `json:"autoSave"`        // 自动保存
	AutoSaveDelay   int    `json:"autoSaveDelay"`   // 自动保存延迟（秒）
	QueryLimit      int    `json:"queryLimit"`      // 查询结果行数限制
	QueryTimeout    int    `json:"queryTimeout"`    // 查询超时（毫秒）
	ConfirmBefore   bool   `json:"confirmBefore"`   // 执行前确认
	FontSize        int    `json:"fontSize"`        // 编辑器字体大小
	FontFamily      string `json:"fontFamily"`      // 编辑器字体
	ShowLineNumbers bool   `json:"showLineNumbers"` // 显示行号
	WordWrap        bool   `json:"wordWrap"`        // 自动换行
	TabSize         int    `json:"tabSize"`         // 制表符宽度
	// AI 配置
	AIAPIKey    string `json:"aiApiKey"`    // AI API Key
	AIAPIUrl    string `json:"aiApiUrl"`    // AI API URL
	AIModelName string `json:"aiModelName"` // AI Model Name
}

type SettingsService struct {
	mu       sync.RWMutex
	filePath string
	settings Settings
}

func NewSettingsService(configDir string) (*SettingsService, error) {
	settingsPath := filepath.Join(configDir, "settings.json")
	svc := &SettingsService{
		filePath: settingsPath,
		settings: Settings{
			Theme:           "light",
			Language:        "zh-CN",
			AutoSave:        true,
			AutoSaveDelay:   30,
			QueryLimit:      5000,
			QueryTimeout:    30000,
			ConfirmBefore:   true,
			FontSize:        14,
			FontFamily:      "Consolas",
			ShowLineNumbers: true,
			WordWrap:        false,
			TabSize:         4,
		},
	}

	// Load settings if file exists
	if _, err := os.Stat(settingsPath); err == nil {
		if err := svc.load(); err != nil {
			// If load fails, continue with defaults
		}
	}

	return svc, nil
}

func (s *SettingsService) ServiceName() string {
	return "SettingsService"
}

func (s *SettingsService) GetSettings() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

func (s *SettingsService) UpdateSettings(newSettings Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.settings = newSettings
	return s.save()
}

func (s *SettingsService) ResetSettings() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.settings = Settings{
		Theme:           "light",
		Language:        "zh-CN",
		AutoSave:        true,
		AutoSaveDelay:   30,
		QueryLimit:      5000,
		QueryTimeout:    30000,
		ConfirmBefore:   true,
		FontSize:        14,
		FontFamily:      "Consolas",
		ShowLineNumbers: true,
		WordWrap:        false,
		TabSize:         4,
	}

	return s.save()
}

func (s *SettingsService) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		return err
	}

	return json.Unmarshal(data, &s.settings)
}

func (s *SettingsService) save() error {
	data, err := json.MarshalIndent(s.settings, "", "  ")
	if err != nil {
		return err
	}

	// Write to temp file first
	tempPath := s.filePath + ".tmp"
	if err := os.WriteFile(tempPath, data, 0600); err != nil {
		return err
	}

	// Atomic rename
	return os.Rename(tempPath, s.filePath)
}

func (s *SettingsService) GetSettingPath() string {
	return s.filePath
}

// SaveAIConfig 保存 AI 配置
func (s *SettingsService) SaveAIConfig(apiKey, apiUrl, modelName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.settings.AIAPIKey = apiKey
	s.settings.AIAPIUrl = apiUrl
	s.settings.AIModelName = modelName

	return s.save()
}

// GetAIConfig 获取 AI 配置
func (s *SettingsService) GetAIConfig() (apiKey, apiUrl, modelName string) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.settings.AIAPIKey, s.settings.AIAPIUrl, s.settings.AIModelName
}
