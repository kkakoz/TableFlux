import { useState, useEffect } from 'react';
import { SettingsService } from '../../bindings/changeme';
import { useTheme } from './ThemeProvider';
import type { Settings as SettingsType, AIConfig } from '../types';
import './settings.css';

export default function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const { setTheme } = useTheme();
  const [settings, setSettingsState] = useState<SettingsType>({
    theme: 'light',
    language: 'zh-CN',
    autoSave: true,
    autoSaveDelay: 30,
    queryLimit: 5000,
    queryTimeout: 30000,
    confirmBefore: true,
    fontSize: 14,
    fontFamily: 'Consolas',
    showLineNumbers: true,
    wordWrap: false,
    tabSize: 4,
  });
  const [activeTab, setActiveTab] = useState('general');
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    apiKey: '',
    apiUrl: '',
    modelName: '',
  });

  useEffect(() => {
    const saved = localStorage.getItem('settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      setSettingsState(parsed);
      if (parsed.theme) {
        setTheme(parsed.theme);
      }
    }
  }, [setTheme]);

  useEffect(() => {
    (async () => {
      try {
        const [key, url, modelName] = await SettingsService.GetAIConfig();
        setAiConfig({ apiKey: key, apiUrl: url, modelName });
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleSave = async () => {
    try {
      // Save regular settings
      localStorage.setItem('settings', JSON.stringify(settings));
      setTheme(settings.theme);

      await SettingsService.SaveAIConfig(aiConfig.apiKey, aiConfig.apiUrl, aiConfig.modelName);

      alert('设置已保存');
    } catch (error) {
      console.error('Failed to save settings:', error);
      alert('设置保存失败：' + error);
    }
  };

  const handleReset = () => {
    const defaults: SettingsType = {
      theme: 'light',
      language: 'zh-CN',
      autoSave: true,
      autoSaveDelay: 30,
      queryLimit: 5000,
      queryTimeout: 30000,
      confirmBefore: true,
      fontSize: 14,
      fontFamily: 'Consolas',
      showLineNumbers: true,
      wordWrap: false,
      tabSize: 4,
    };
    setSettingsState(defaults);
    localStorage.setItem('settings', JSON.stringify(defaults));
    setTheme(defaults.theme);

    setAiConfig({ apiKey: '', apiUrl: '', modelName: '' });
  };

  return (
    <div className="settings-container">
      <div className="settings-panel">
        <div className="settings-header">
          <h1>设置</h1>
          {onClose && <button className="close-btn" onClick={onClose}>✕</button>}
        </div>

        <div className="settings-tabs">
          <button
            className={`tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            通用
          </button>
          <button
            className={`tab ${activeTab === 'editor' ? 'active' : ''}`}
            onClick={() => setActiveTab('editor')}
          >
            编辑器
          </button>
          <button
            className={`tab ${activeTab === 'query' ? 'active' : ''}`}
            onClick={() => setActiveTab('query')}
          >
            查询
          </button>
          <button
            className={`tab ${activeTab === 'ai' ? 'active' : ''}`}
            onClick={() => setActiveTab('ai')}
          >
            AI
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'general' && (
            <div className="settings-section">
              <h2>通用设置</h2>
              <div className="form-group">
                <label>
                  主题
                  <select
                    value={settings.theme}
                    onChange={(e) => setSettingsState({ ...settings, theme: e.target.value as any })}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="system">跟随系统</option>
                  </select>
                </label>
              </div>
              <div className="form-group">
                <label>
                  语言
                  <select
                    value={settings.language}
                    onChange={(e) => setSettingsState({ ...settings, language: e.target.value as any })}
                  >
                    <option value="zh-CN">中文</option>
                    <option value="en-US">English</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="settings-section">
              <h2>编辑器设置</h2>
              <div className="form-group">
                <label>
                  字体
                  <input
                    type="text"
                    value={settings.fontFamily}
                    onChange={(e) => setSettingsState({ ...settings, fontFamily: e.target.value })}
                  />
                </label>
              </div>
              <div className="form-group">
                <label>
                  字号
                  <select
                    value={settings.fontSize}
                    onChange={(e) => setSettingsState({ ...settings, fontSize: parseInt(e.target.value) })}
                  >
                    <option value="12">12</option>
                    <option value="14">14</option>
                    <option value="16">16</option>
                    <option value="18">18</option>
                  </select>
                </label>
              </div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.showLineNumbers}
                    onChange={(e) => setSettingsState({ ...settings, showLineNumbers: e.target.checked })}
                  />
                  显示行号
                </label>
              </div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.wordWrap}
                    onChange={(e) => setSettingsState({ ...settings, wordWrap: e.target.checked })}
                  />
                  自动换行
                </label>
              </div>
              <div className="form-group">
                <label>
                  自动保存
                  <input
                    type="checkbox"
                    checked={settings.autoSave}
                    onChange={(e) => setSettingsState({ ...settings, autoSave: e.target.checked })}
                  />
                  {settings.autoSave && (
                    <select
                      value={settings.autoSaveDelay}
                      onChange={(e) => setSettingsState({ ...settings, autoSaveDelay: parseInt(e.target.value) })}
                    >
                      <option value="30">30 秒</option>
                      <option value="60">1 分钟</option>
                      <option value="300">5 分钟</option>
                    </select>
                  )}
                </label>
              </div>
            </div>
          )}

          {activeTab === 'query' && (
            <div className="settings-section">
              <h2>查询设置</h2>
              <div className="form-group">
                <label>
                  结果行数限制
                  <select
                    value={settings.queryLimit}
                    onChange={(e) => setSettingsState({ ...settings, queryLimit: parseInt(e.target.value) })}
                  >
                    <option value="1000">1,000</option>
                    <option value="5000">5,000</option>
                    <option value="10000">10,000</option>
                    <option value="50000">50,000</option>
                  </select>
                </label>
              </div>
              <div className="form-group">
                <label>
                  查询超时（毫秒）
                  <select
                    value={settings.queryTimeout}
                    onChange={(e) => setSettingsState({ ...settings, queryTimeout: parseInt(e.target.value) })}
                  >
                    <option value="10000">10 秒</option>
                    <option value="30000">30 秒</option>
                    <option value="60000">60 秒</option>
                  </select>
                </label>
              </div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.confirmBefore}
                    onChange={(e) => setSettingsState({ ...settings, confirmBefore: e.target.checked })}
                  />
                  执行前确认
                </label>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="settings-section">
              <h2>AI 设置</h2>
              <div className="form-group">
                <label>
                  API Key
                  <input
                    type="password"
                    value={aiConfig.apiKey}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                    placeholder="sk-..."
                  />
                </label>
              </div>
              <div className="form-group">
                <label>
                  API URL（可选）
                  <input
                    type="text"
                    value={aiConfig.apiUrl}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
              </div>
              <div className="form-group">
                <label>
                  模型名称
                  <input
                    type="text"
                    value={aiConfig.modelName}
                    onChange={(e) => setAiConfig({ ...aiConfig, modelName: e.target.value })}
                    placeholder="gpt-4"
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button className="btn btn-primary" onClick={handleSave}>保存</button>
          <button className="btn btn-secondary" onClick={handleReset}>重置</button>
        </div>
      </div>
    </div>
  );
}
