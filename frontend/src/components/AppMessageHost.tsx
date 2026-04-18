import { useEffect, useState } from "react";
import { CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { APP_MESSAGE_EVENT, type AppMessagePayload, type AppMessageVariant } from "../utils/message";

type MessageItem = Required<Pick<AppMessagePayload, "message" | "variant" | "duration">> &
  Pick<AppMessagePayload, "title"> & {
    id: number;
  };

const icons: Record<AppMessageVariant, JSX.Element> = {
  success: <CheckCircle2 className="tf-message-icon" strokeWidth={2} />,
  error: <XCircle className="tf-message-icon" strokeWidth={2} />,
  info: <Info className="tf-message-icon" strokeWidth={2} />,
  loading: <Loader2 className="tf-message-icon animate-spin" strokeWidth={2} />,
};

export default function AppMessageHost() {
  const [items, setItems] = useState<MessageItem[]>([]);

  useEffect(() => {
    const onMessage = (event: Event) => {
      const detail = (event as CustomEvent<AppMessagePayload>).detail;
      if (!detail?.message) return;
      const item: MessageItem = {
        id: Date.now() + Math.random(),
        message: detail.message,
        title: detail.title,
        variant: detail.variant ?? "info",
        duration: detail.duration ?? (detail.variant === "error" ? 4400 : 2600),
      };

      setItems((prev) => [item, ...prev].slice(0, 4));
      if (item.duration > 0) {
        window.setTimeout(() => {
          setItems((prev) => prev.filter((x) => x.id !== item.id));
        }, item.duration);
      }
    };

    window.addEventListener(APP_MESSAGE_EVENT, onMessage);
    return () => window.removeEventListener(APP_MESSAGE_EVENT, onMessage);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="tf-message-viewport" aria-live="polite" aria-atomic="true">
      {items.map((item) => (
        <div key={item.id} className={`tf-message-card tf-message-${item.variant}`}>
          <div className="tf-message-mark">{icons[item.variant]}</div>
          <div className="tf-message-content">
            {item.title ? <div className="tf-message-title">{item.title}</div> : null}
            <div className="tf-message-text">{item.message}</div>
          </div>
          <button
            type="button"
            className="tf-message-close"
            aria-label="关闭提示"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== item.id))}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
