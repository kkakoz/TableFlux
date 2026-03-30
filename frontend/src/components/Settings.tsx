import { useState, useEffect } from 'react';
import { useTheme } from './ThemeProvider';
import type { Settings as SettingsType } from '../types';

export function Settings() {
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

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await fetch('http://localhost:34115/api/SettingsService.GetSettings');
      const data = await response.json();
      setSettingsState(data);
      setTheme(data.theme);
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  };

  const handleSave = async () => {
    try {
      const response = await fetch('http://localhost:34115/api/SettingsService.UpdateSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        setTheme(settings.theme);
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  const handleReset = async () => {
    try {
      await fetch('http://localhost:34115/api/SettingsService.ResetSettings', {
        method: 'POST',
      });
      loadSettings();
    } catch (error) {
      console.error('FailedFailed to reset settings:', error);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-tabs">
        <button
          className={activeTab === 'general' ? 'active' : ''}
          onClick={() => setActiveTab('general')}
        >
          通用
        </button>
        <button
          className={activeTab === 'editor' ? 'active' : ''}
          onClick={() => setActiveTab('editor')}
        >
          编辑器
        </button>
        <button
          className={activeTab === 'query' ? 'active' : ''}
          onClick={() => setActiveTab('query')}
        >
          查询
        </button>
      </div>

      <div className="settings-content">
        {activeTab === 'general' && (
          <div className="settings-section">
            <h3>通用设置</h3>
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
            <h3>编辑器设置</h3>
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
            <h3>查询设置</h3>
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
      </div>

      <div className="settings-actions">
        <button onClick={handleSave}>保存</button>
        <button onClick={handleReset}>重置</button>
      </div>
    </div>
  );
}
