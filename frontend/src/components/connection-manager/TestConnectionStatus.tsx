type TestPhase = "idle" | "loading" | "success" | "error";

type Props = {
  phase: TestPhase;
  message: string;
};

export default function TestConnectionStatus({ phase, message }: Props) {
  if (phase === "idle" && !message) return null;

  const styles =
    phase === "loading"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : phase === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : phase === "error"
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <div className={`rounded-lg border px-2.5 py-2 text-[12px] leading-snug ${styles}`}>
      {phase === "loading" ? (
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
          正在测试连接…
        </span>
      ) : (
        message
      )}
    </div>
  );
}
