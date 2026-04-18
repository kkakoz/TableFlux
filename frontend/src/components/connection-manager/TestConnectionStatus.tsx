type TestPhase = "idle" | "loading" | "success" | "error";

type Props = {
  phase: TestPhase;
  message: string;
};

export default function TestConnectionStatus({ phase, message }: Props) {
  if (phase === "idle" && !message) return null;

  const variant = phase === "idle" ? "info" : phase;
  const title =
    phase === "loading"
      ? "正在测试"
      : phase === "success"
        ? "连接可用"
        : phase === "error"
          ? "连接失败"
          : "提示";

  return (
    <div className={`tf-message-card tf-inline-message tf-message-${variant}`}>
      <div className="tf-message-mark">
        {phase === "loading" ? (
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-current" />
        )}
      </div>
      <div className="tf-message-content">
        <div className="tf-message-title">{title}</div>
        <div className="tf-message-text">{phase === "loading" ? "正在测试连接..." : message}</div>
      </div>
    </div>
  );
}
