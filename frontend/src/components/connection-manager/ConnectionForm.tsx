import { useId } from "react";
import { ChevronDown } from "lucide-react";
import type { ConnectionFormValues } from "./connectionFormTypes";

type EnvOpt = ConnectionFormValues["env"];

type Props = {
  values: ConnectionFormValues;
  onChange: (next: ConnectionFormValues) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  passwordHint: string;
  autoFocus?: boolean;
};

export default function ConnectionForm({
  values,
  onChange,
  advancedOpen,
  onToggleAdvanced,
  passwordHint,
  autoFocus,
}: Props) {
  const advId = useId();

  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <label className="flex flex-col gap-1">
        <span className="text-slate-600">连接名称</span>
        <input
          autoFocus={autoFocus}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-900 outline-none ring-blue-500/0 transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          placeholder="例如：本地 MySQL"
          autoComplete="off"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-slate-600">数据库类型</span>
        <select
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          value={values.driver}
          onChange={(e) => {
            const d = e.target.value as "mysql" | "postgres";
            onChange({
              ...values,
              driver: d,
              port: d === "postgres" ? 5432 : 3306,
            });
          }}
        >
          <option value="mysql">MySQL</option>
          <option value="postgres">PostgreSQL</option>
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-600">主机</span>
          <input
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
            value={values.host}
            onChange={(e) => onChange({ ...values, host: e.target.value })}
            placeholder="127.0.0.1"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-600">端口</span>
          <input
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
            type="number"
            value={values.port}
            onChange={(e) => onChange({ ...values, port: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-600">用户名</span>
          <input
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
            value={values.user}
            onChange={(e) => onChange({ ...values, user: e.target.value })}
            autoComplete="username"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-600">密码</span>
          <input
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
            type="password"
            value={values.password}
            onChange={(e) => onChange({ ...values, password: e.target.value })}
            placeholder={passwordHint}
            autoComplete="current-password"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-slate-600">默认数据库</span>
        <input
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          value={values.defaultDb}
          onChange={(e) => onChange({ ...values, defaultDb: e.target.value })}
          placeholder="可选"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-slate-600">环境标签</span>
        <select
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          value={values.env}
          onChange={(e) =>
            onChange({ ...values, env: e.target.value as EnvOpt })
          }
        >
          <option value="">无</option>
          <option value="dev">开发</option>
          <option value="test">测试</option>
        </select>
      </label>

      <div className="rounded-lg border border-slate-200/80 bg-slate-50/80">
        <button
          type="button"
          id={advId}
          className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[12px] font-medium text-slate-700 hover:bg-slate-100/80"
          onClick={onToggleAdvanced}
          aria-expanded={advancedOpen}
        >
          <span>高级设置</span>
          <ChevronDown className={`h-4 w-4 shrink-0 transition ${advancedOpen ? "rotate-180" : ""}`} />
        </button>
        {advancedOpen ? (
          <div className="space-y-2 border-t border-slate-200/80 px-2.5 pb-2.5 pt-1">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600">字符集</span>
              <input
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
                value={values.charset}
                onChange={(e) => onChange({ ...values, charset: e.target.value })}
                placeholder="utf8mb4"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600">SSL</span>
              <select
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
                value={values.sslMode}
                onChange={(e) => onChange({ ...values, sslMode: e.target.value })}
              >
                <option value="disable">关闭</option>
                <option value="require">require</option>
                <option value="verify-full">verify-full</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600">连接超时（秒）</span>
              <input
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
                type="number"
                min={1}
                value={values.connectTimeoutSec}
                onChange={(e) =>
                  onChange({ ...values, connectTimeoutSec: Math.max(1, Number(e.target.value) || 30) })
                }
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
