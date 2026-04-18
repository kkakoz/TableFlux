export type AppMessageVariant = "success" | "error" | "info" | "loading";

export type AppMessagePayload = {
  title?: string;
  message: string;
  variant?: AppMessageVariant;
  duration?: number;
};

export const APP_MESSAGE_EVENT = "tableflux-message";

export function showAppMessage(payload: AppMessagePayload) {
  window.dispatchEvent(
    new CustomEvent<AppMessagePayload>(APP_MESSAGE_EVENT, {
      detail: {
        variant: "info",
        duration: payload.variant === "error" ? 4400 : 2600,
        ...payload,
      },
    }),
  );
}
