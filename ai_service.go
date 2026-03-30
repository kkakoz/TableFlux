package main

import (
	"fmt"
)

const aiConfigSecretKey = "ai:config"

type AIService struct {
	secrets *SecretService
}

func NewAIService(secrets *SecretService) *AIService {
	return &AIService{secrets: secrets}
}

func (s *AIService) ServiceName() string {
	return "AIService"
}

// SaveAIConfig 将 apiKey、apiUrl、modelName 保存到本地密钥存储（管道分隔）。
func (s *AIService) SaveAIConfig(apiKey, apiUrl, modelName string) error {
	configData := fmt.Sprintf("%s|%s|%s", apiKey, apiUrl, modelName)
	return s.secrets.SetConnectionSecret(aiConfigSecretKey, configData)
}
