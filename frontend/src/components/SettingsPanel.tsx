import { useEffect, useState } from "react";
import { SettingsService, Settings as WailsSettings } from "../../bindings/changeme";
import { useTheme } from "./ThemeProvider";
import type { Settings as SettingsType, AIConfig } from "../types";
import "./settings.css";
import { DEFAULT_TIMEZONE, readDisplayTimezone, TIMEZONE_OPTIONS, writeDisplayTimezone } from "./studio/timezoneDisplay";
import { showAppMessage } from "../utils/message";

type SettingsCategory = "general" | "editor" | "query" | "timezone" | "ai";

const NAV_ITEMS: { id: SettingsCategory; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "editor", label: "编辑器" },
  { id: "query", label: "查询" },
  { id: "timezone", label: "时区" },
  { id: "ai", label: "AI" },
];

export default function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const { setTheme } = useTheme();
  const [settings, setSettingsState] = useState<SettingsType>({
    theme: "light",
    language: "zh-CN",
    autoSave: true,
    autoSaveDelay: 30,
    queryLimit: 5000,
    queryTimeout: 30000,
    confirmBefore: true,
    fontSize: 14,
    fontFamily: "Consolas",
    showLineNumbers: true,
    wordWrap: false,
    tabSize: 4,
  });
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [displayTimezone, setDisplayTimezone] = useState(() => readDisplayTimezone());
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    apiKey: "",
    apiUrl: "",
    modelName: "",
  });
  const [aiEnabled, setAiEnabled] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("settings");
    if (saved) {
      const parsed = JSON.parse(saved) as SettingsType;
      setSettingsState(parsed);
      if (parsed.theme) {
        setTheme(parsed.theme);
      }
    }
    const aiOn = localStorage.getItem("tableflux.ai_enabled");
    if (aiOn !== null) {
      setAiEnabled(aiOn === "1");
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
      localStorage.setItem("settings", JSON.stringify(settings));
      localStorage.setItem("tableflux.ai_enabled", aiEnabled ? "1" : "0");
      setTheme(settings.theme);
      writeDisplayTimezone(displayTimezone || DEFAULT_TIMEZONE);
      window.dispatchEvent(new CustomEvent("tableflux-timezone-change"));

      await SettingsService.UpdateSettings(
        new WailsSettings({
          theme: settings.theme,
          language: settings.language,
          autoSave: settings.autoSave,
          autoSaveDelay: settings.autoSaveDelay,
          queryLimit: settings.queryLimit,
          queryTimeout: settings.queryTimeout,
          confirmBefore: settings.confirmBefore,
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          showLineNumbers: settings.showLineNumbers,
          wordWrap: settings.wordWrap,
          tabSize: settings.tabSize,
          aiApiKey: aiConfig.apiKey,
          aiApiUrl: aiConfig.apiUrl,
          aiModelName: aiConfig.modelName,
        }),
      );

      showAppMessage({ variant: "success", title: "设置成功", message: "设置已保存并生效" });
    } catch (error) {
      console.error("Failed to save settings:", error);
      showAppMessage({ variant: "error", title: "设置失败", message: "设置保存失败：" + error });
    }
  };

  const handleReset = async () => {
    const defaults: SettingsType = {
      theme: "light",
      language: "zh-CN",
      autoSave: true,
      autoSaveDelay: 30,
      queryLimit: 5000,
      queryTimeout: 30000,
      confirmBefore: true,
      fontSize: 14,
      fontFamily: "Consolas",
      showLineNumbers: true,
      wordWrap: false,
      tabSize: 4,
    };
    setSettingsState(defaults);
    localStorage.setItem("settings", JSON.stringify(defaults));
    setTheme(defaults.theme);

    setAiConfig({ apiKey: "", apiUrl: "", modelName: "" });
    setAiEnabled(true);
    localStorage.removeItem("tableflux.ai_enabled");
    try {
      await SettingsService.ResetSettings();
    } catch (e) {
      console.error("ResetSettings:", e);
    }
  };

  useEffect(() => {
    if (!onClose) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [onClose]);

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-dialog-header">
          <h1 id="settings-dialog-title" className="settings-dialog-title">
            设置
          </h1>
          {onClose && (
            <button type="button" className="settings-dialog-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          )}
        </header>

        <div className="settings-dialog-body">
          <nav className="settings-nav" aria-label="设置分类">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item ${activeCategory === item.id ? "is-active" : ""}`}
                onClick={() => setActiveCategory(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane-scroll">
            {activeCategory === "general" && (
              <section className="settings-pane">
                <h2 className="settings-pane-heading">通用</h2>
                <p className="settings-pane-desc">界面语言与外观。</p>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-theme">
                    主题
                  </label>
                  <select
                    id="st-theme"
                    className="settings-control"
                    value={settings.theme}
                    onChange={(e) => setSettingsState({ ...settings, theme: e.target.value as SettingsType["theme"] })}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                    <option value="system">跟随系统</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-lang">
                    语言
                  </label>
                  <select
                    id="st-lang"
                    className="settings-control"
                    value={settings.language}
                    onChange={(e) => setSettingsState({ ...settings, language: e.target.value as SettingsType["language"] })}
                  >
                    <option value="zh-CN">中文</option>
                    <option value="en-US">English</option>
                  </select>
                </div>
              </section>
            )}

            {activeCategory === "editor" && (
              <section className="settings-pane">
                <h2 className="settings-pane-heading">编辑器</h2>
                <p className="settings-pane-desc">SQL 编辑区与自动保存。</p>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-font">
                    字体
                  </label>
                  <input
                    id="st-font"
                    className="settings-control"
                    type="text"
                    value={settings.fontFamily}
                    onChange={(e) => setSettingsState({ ...settings, fontFamily: e.target.value })}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-fz">
                    字号
                  </label>
                  <select
                    id="st-fz"
                    className="settings-control"
                    value={settings.fontSize}
                    onChange={(e) => setSettingsState({ ...settings, fontSize: parseInt(e.target.value, 10) })}
                  >
                    <option value="12">12</option>
                    <option value="14">14</option>
                    <option value="16">16</option>
                    <option value="18">18</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-tab">
                    Tab 宽度
                  </label>
                  <select
                    id="st-tab"
                    className="settings-control"
                    value={settings.tabSize}
                    onChange={(e) => setSettingsState({ ...settings, tabSize: parseInt(e.target.value, 10) })}
                  >
                    <option value="2">2</option>
                    <option value="4">4</option>
                    <option value="8">8</option>
                  </select>
                </div>
                <div className="settings-field settings-field-inline">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.showLineNumbers}
                      onChange={(e) => setSettingsState({ ...settings, showLineNumbers: e.target.checked })}
                    />
                    <span>显示行号</span>
                  </label>
                </div>
                <div className="settings-field settings-field-inline">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.wordWrap}
                      onChange={(e) => setSettingsState({ ...settings, wordWrap: e.target.checked })}
                    />
                    <span>自动换行</span>
                  </label>
                </div>
                <div className="settings-field settings-field-inline">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.autoSave}
                      onChange={(e) => setSettingsState({ ...settings, autoSave: e.target.checked })}
                    />
                    <span>自动保存</span>
                  </label>
                  {settings.autoSave && (
                    <select
                      className="settings-control settings-control-inline"
                      value={settings.autoSaveDelay}
                      onChange={(e) => setSettingsState({ ...settings, autoSaveDelay: parseInt(e.target.value, 10) })}
                      aria-label="自动保存间隔"
                    >
                      <option value="30">30 秒</option>
                      <option value="60">1 分钟</option>
                      <option value="300">5 分钟</option>
                    </select>
                  )}
                </div>
              </section>
            )}

            {activeCategory === "timezone" && (
              <section className="settings-pane">
                <h2 className="settings-pane-heading">时区</h2>
                <p className="settings-pane-desc">用于查询结果中时间字段的展示与解释；不影响数据库存储。</p>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-tz">
                    显示时区
                  </label>
                  <span className="settings-hint">当前：{displayTimezone || DEFAULT_TIMEZONE}</span>
                  <select
                    id="st-tz"
                    className="settings-control"
                    value={displayTimezone}
                    onChange={(e) => setDisplayTimezone(e.target.value)}
                  >
                    {TIMEZONE_OPTIONS.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            )}

            {activeCategory === "query" && (
              <section className="settings-pane">
                <h2 className="settings-pane-heading">查询</h2>
                <p className="settings-pane-desc">执行与结果集默认行为。</p>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-limit">
                    结果集分页大小
                  </label>
                  <span className="settings-hint">单次查询返回的最大行数</span>
                  <select
                    id="st-limit"
                    className="settings-control"
                    value={settings.queryLimit}
                    onChange={(e) => setSettingsState({ ...settings, queryLimit: parseInt(e.target.value, 10) })}
                  >
                    <option value="1000">1,000</option>
                    <option value="5000">5,000</option>
                    <option value="10000">10,000</option>
                    <option value="50000">50,000</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-timeout">
                    查询超时时间
                  </label>
                  <select
                    id="st-timeout"
                    className="settings-control"
                    value={settings.queryTimeout}
                    onChange={(e) => setSettingsState({ ...settings, queryTimeout: parseInt(e.target.value, 10) })}
                  >
                    <option value="10000">10 秒</option>
                    <option value="30000">30 秒</option>
                    <option value="60000">60 秒</option>
                    <option value="300000">5 分钟</option>
                    <option value="0">无限制</option>
                  </select>
                </div>
                <div className="settings-field settings-field-inline">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.confirmBefore}
                      onChange={(e) => setSettingsState({ ...settings, confirmBefore: e.target.checked })}
                    />
                    <span>执行前确认</span>
                  </label>
                </div>
              </section>
            )}

            {activeCategory === "ai" && (
              <section className="settings-pane">
                <h2 className="settings-pane-heading">AI</h2>
                <p className="settings-pane-desc">SQL 助手与模型配置。</p>
                <div className="settings-field settings-field-inline">
                  <label className="settings-check">
                    <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
                    <span>启用 AI 功能</span>
                  </label>
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-aik">
                    API Key
                  </label>
                  <input
                    id="st-aik"
                    className="settings-control"
                    type="password"
                    value={aiConfig.apiKey}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                    placeholder="sk-..."
                    disabled={!aiEnabled}
                    autoComplete="off"
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-aiu">
                    模型提供商 / API URL
                  </label>
                  <span className="settings-hint">可选，兼容 OpenAI 格式端点</span>
                  <input
                    id="st-aiu"
                    className="settings-control"
                    type="text"
                    value={aiConfig.apiUrl}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    disabled={!aiEnabled}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="st-aim">
                    默认模型
                  </label>
                  <input
                    id="st-aim"
                    className="settings-control"
                    type="text"
                    value={aiConfig.modelName}
                    onChange={(e) => setAiConfig({ ...aiConfig, modelName: e.target.value })}
                    placeholder="gpt-4"
                    disabled={!aiEnabled}
                  />
                </div>
              </section>
            )}
          </div>
        </div>

        <footer className="settings-dialog-footer">
          <div className="settings-footer-actions">
            {onClose && (
              <button type="button" className="settings-btn settings-btn-ghost" onClick={onClose}>
                取消
              </button>
            )}
            <button type="button" className="settings-btn settings-btn-secondary" onClick={handleReset}>
              重置
            </button>
            <button type="button" className="settings-btn settings-btn-primary" onClick={() => void handleSave()}>
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
