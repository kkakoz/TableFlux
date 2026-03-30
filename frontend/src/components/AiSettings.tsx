import { useState, useEffect } from 'react';
import { SettingsService } from '../../bindings/changeme';

export function AiSettings() {
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [model, setModel] = useState('gpt-4');
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const [key, url, modelName] = await SettingsService.GetAIConfig();
      setApiKey(key);
      setApiUrl(url);
      setModel(modelName || 'gpt-4');
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  const handleSave = async () => {
    if (!apiKey || !apiUrl || !model) {
      setMessage('请填写所有配置字段');
      return;
    }

    try {
      await SettingsService.SaveAIConfig(apiKey, apiUrl, model);
      setMessage('保存成功！');
      setTimeout(() => setMessage(''), 2000);
    } catch (error) {
      setMessage('保存失败：' + error);
    }
  };

  return (
    <div className="ai-settings">
      <h2>AI 设置</h2>

      <div className="form-group">
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </label>
      </div>

      <div className="form-group">
        <label>
          API URL
          <input
            type="text"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>
      </div>

      <div className="form-group">
        <label>
          模型名称
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4"
          />
        </label>
      </div>

      <div className="form-actions">
        <button onClick={handleSave}>保存</button>
      </div>

      {message && <div className="message">{message}</div>}
    </div>
  );
}
