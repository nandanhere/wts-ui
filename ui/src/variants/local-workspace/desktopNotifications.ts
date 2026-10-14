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
  path?: string,
) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_desktop_notification", { title, body, tag, path: path ?? null });
}

/** The event that the desktop app sends when the user clicks a notification. */
export const NOTIFICATION_OPEN_EVENT = "wts://notification-open";

/** Returns the in-app path, or null when the value is not a safe WTS path. */
export function notificationOpenPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 512 ||
    path.includes("://") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return null;
  }
  return path;
}

/** Opens the screen that a clicked notification names. */
export function openNotificationPath(value: unknown): boolean {
  const path = notificationOpenPath(value);
  if (!path) return false;
  const current = `${globalThis.location?.pathname ?? ""}${globalThis.location?.search ?? ""}`;
  if (current !== path) globalThis.history?.pushState(null, "", path);
  globalThis.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

type NotificationListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

async function tauriListen(
  event: string,
  handler: (event: { payload: unknown }) => void,
) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<unknown>(event, handler);
}

/** Opens the named screen each time the user clicks a WTS notification. */
export function subscribeNotificationOpen(
  listen: NotificationListen | undefined = tauriRuntime() ? tauriListen : undefined,
): () => void {
  if (!listen) return () => {};
  let active = true;
  let stop: (() => void) | undefined;
  void listen(NOTIFICATION_OPEN_EVENT, (event) => {
    if (active) openNotificationPath(event.payload);
  })
    .then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    })
    .catch(() => {});
  return () => {
    active = false;
    stop?.();
  };
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

export interface DesktopNotificationOptions {
  /** The in-app path to open when the user clicks the notification. */
  path?: string;
  api?: NotificationApi;
  nativeInvoke?: typeof invokeDesktopNotification;
}

export async function sendDesktopNotification(
  title: string,
  body: string,
  tag: string,
  options: DesktopNotificationOptions = {},
): Promise<boolean> {
  const path = options.path ? (notificationOpenPath(options.path) ?? undefined) : undefined;
  const nativeInvoke = options.nativeInvoke ?? invokeDesktopNotification;
  const api = "api" in options ? options.api : notificationApi();
  if (tauriRuntime()) {
    try {
      await nativeInvoke(title, body, tag, path);
      return true;
    } catch {
      return false;
    }
  }
  if (!api || api.permission !== "granted") return false;
  try {
    const notification = new api(title, { body, tag }) as NotificationInstance & {
      onclick?: (() => void) | null;
    };
    if (path) {
      notification.onclick = () => {
        globalThis.focus?.();
        openNotificationPath(path);
      };
    }
    return true;
  } catch {
    return false;
  }
}
