export type DesktopNotificationState =
  | "unsupported"
  | "default"
  | "denied"
  | "granted";

interface NotificationInstance {
  close(): void;
}

export interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (
    title: string,
    options?: NotificationOptions,
  ): NotificationInstance;
}

function notificationApi(): NotificationApi | undefined {
  return "Notification" in globalThis
    ? (globalThis.Notification as unknown as NotificationApi)
    : undefined;
}

function tauriRuntime() {
  const runtime = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
  };
  return runtime.isTauri === true || "__TAURI_INTERNALS__" in runtime;
}

async function invokeDesktopNotification(
  title: string,
  body: string,
  tag: string,
) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_desktop_notification", { title, body, tag });
}

export function desktopNotificationState(
  api: NotificationApi | undefined = notificationApi(),
): DesktopNotificationState {
  if (tauriRuntime()) return "granted";
  return api?.permission ?? "unsupported";
}

export async function requestDesktopNotifications(
  api: NotificationApi | undefined = notificationApi(),
): Promise<DesktopNotificationState> {
  if (tauriRuntime()) return "granted";
  if (!api) return "unsupported";
  return api.requestPermission();
}

export async function sendDesktopNotification(
  title: string,
  body: string,
  tag: string,
  api: NotificationApi | undefined = notificationApi(),
  nativeInvoke: typeof invokeDesktopNotification = invokeDesktopNotification,
): Promise<boolean> {
  if (tauriRuntime()) {
    try {
      await nativeInvoke(title, body, tag);
      return true;
    } catch {
      return false;
    }
  }
  if (!api || api.permission !== "granted") return false;
  try {
    new api(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}
