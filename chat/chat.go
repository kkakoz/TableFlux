package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type LLMService struct {
	apiKey    string
	apiURL    string
	modelName string
	client    *http.Client
}

func NewLLMService(apiKey, apiURL, modelName string) *LLMService {
	return &LLMService{
		apiKey:    apiKey,
		apiURL:    strings.TrimRight(apiURL, "/"),
		modelName: modelName,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatCompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	Stream      bool          `json:"stream"`
}

type ChatCompletionResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int `json:"index"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    any    `json:"code"`
	} `json:"error,omitempty"`
}

// Chat 最简单调用：system + user
func (s *LLMService) Chat(ctx context.Context, systemPrompt, userPrompt string) (string, error) {
	return s.ChatWithMessages(ctx, []ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	})
}

// ChatWithMessages 支持多 message 调用
func (s *LLMService) ChatWithMessages(ctx context.Context, messages []ChatMessage) (string, error) {
	if s.apiKey == "" {
		return "", errors.New("apiKey is empty")
	}
	if s.apiURL == "" {
		return "", errors.New("apiURL is empty")
	}
	if s.modelName == "" {
		return "", errors.New("modelName is empty")
	}
	if len(messages) == 0 {
		return "", errors.New("messages is empty")
	}

	reqBody := ChatCompletionRequest{
		Model:       s.modelName,
		Messages:    messages,
		Temperature: 0.2,
		Stream:      false,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request body failed: %w", err)
	}

	url := s.apiURL
	if !strings.HasSuffix(url, "/chat/completions") {
		url = url + "/chat/completions"
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create http request failed: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+s.apiKey)

	httpResp, err := s.client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("request ai api failed: %w", err)
	}
	defer httpResp.Body.Close()

	respBytes, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return "", fmt.Errorf("read ai api response failed: %w", err)
	}

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return "", fmt.Errorf("ai api error, status=%d, body=%s", httpResp.StatusCode, string(respBytes))
	}

	var resp ChatCompletionResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return "", fmt.Errorf("unmarshal ai response failed: %w, body=%s", err, string(respBytes))
	}

	if resp.Error != nil {
		return "", fmt.Errorf("ai api returned error: %s", resp.Error.Message)
	}

	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("ai api returned empty choices, body=%s", string(respBytes))
	}

	content := strings.TrimSpace(resp.Choices[0].Message.Content)
	if content == "" {
		return "", fmt.Errorf("ai response content is empty")
	}

	return content, nil
}

// ChatJSON 调用模型并将返回内容解析到 target 中
// target 必须传指针，例如 &MyStruct{}
func (s *LLMService) ChatJSON(ctx context.Context, systemPrompt, userPrompt string, target any) error {
	raw, err := s.Chat(ctx, systemPrompt, userPrompt)
	if err != nil {
		return err
	}

	jsonText, err := extractJSON(raw)
	if err != nil {
		return fmt.Errorf("extract json failed: %w, raw=%s", err, raw)
	}

	if err := json.Unmarshal([]byte(jsonText), target); err != nil {
		return fmt.Errorf("unmarshal json failed: %w, json=%s, raw=%s", err, jsonText, raw)
	}

	return nil
}

// ChatJSONWithMessages 支持多 message + JSON 解析
func (s *LLMService) ChatJSONWithMessages(ctx context.Context, messages []ChatMessage, target any) error {
	raw, err := s.ChatWithMessages(ctx, messages)
	if err != nil {
		return err
	}

	jsonText, err := extractJSON(raw)
	if err != nil {
		return fmt.Errorf("extract json failed: %w, raw=%s", err, raw)
	}

	if err := json.Unmarshal([]byte(jsonText), target); err != nil {
		return fmt.Errorf("unmarshal json failed: %w, json=%s, raw=%s", err, jsonText, raw)
	}

	return nil
}

// extractJSON 从模型返回文本中提取 JSON 文本
func extractJSON(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("empty response")
	}

	// 情况1：直接就是 JSON
	if isLikelyJSON(s) {
		return s, nil
	}

	// 情况2：包在 ```json ... ``` 代码块里
	if block := extractCodeBlockJSON(s); block != "" {
		return block, nil
	}

	// 情况3：文本前后有说明，只截取第一个完整 JSON 对象/数组
	if frag := extractFirstJSONFragment(s); frag != "" {
		return frag, nil
	}

	return "", errors.New("no valid json found")
}

func isLikelyJSON(s string) bool {
	if s == "" {
		return false
	}
	if (strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}")) ||
		(strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]")) {
		return json.Valid([]byte(s))
	}
	return false
}

func extractCodeBlockJSON(s string) string {
	start := strings.Index(s, "```")
	if start == -1 {
		return ""
	}

	for start != -1 {
		rest := s[start+3:]
		endHeader := strings.Index(rest, "\n")
		if endHeader == -1 {
			return ""
		}

		lang := strings.TrimSpace(rest[:endHeader])
		contentStart := start + 3 + endHeader + 1
		end := strings.Index(s[contentStart:], "```")
		if end == -1 {
			return ""
		}

		content := strings.TrimSpace(s[contentStart : contentStart+end])

		if lang == "json" || lang == "" {
			if json.Valid([]byte(content)) {
				return content
			}
		}

		nextStart := strings.Index(s[contentStart+end+3:], "```")
		if nextStart == -1 {
			break
		}
		start = contentStart + end + 3 + nextStart
	}

	return ""
}

func extractFirstJSONFragment(s string) string {
	// 尝试提取 {...}
	if obj := extractBalancedFragment(s, '{', '}'); obj != "" && json.Valid([]byte(obj)) {
		return obj
	}

	// 尝试提取 [...]
	if arr := extractBalancedFragment(s, '[', ']'); arr != "" && json.Valid([]byte(arr)) {
		return arr
	}

	return ""
}

func extractBalancedFragment(s string, openCh, closeCh byte) string {
	start := -1
	depth := 0
	inString := false
	escape := false

	for i := 0; i < len(s); i++ {
		ch := s[i]

		if start == -1 {
			if ch == openCh {
				start = i
				depth = 1
			}
			continue
		}

		if inString {
			if escape {
				escape = false
				continue
			}
			if ch == '\\' {
				escape = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}

		if ch == '"' {
			inString = true
			continue
		}

		if ch == openCh {
			depth++
			continue
		}

		if ch == closeCh {
			depth--
			if depth == 0 {
				return strings.TrimSpace(s[start : i+1])
			}
		}
	}

	return ""
}
