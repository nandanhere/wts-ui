import { describe, expect, it, vi } from "vitest";
import {
  desktopNotificationState,
  NOTIFICATION_OPEN_EVENT,
  notificationOpenPath,
  requestDesktopNotifications,
  sendDesktopNotification,
  subscribeNotificationOpen,
  type NotificationApi,
} from "./desktopNotifications";

function fakeNotificationApi(permission: NotificationPermission) {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];
  class FakeNotification {
    static permission = permission;
    static async requestPermission() {
      return FakeNotification.permission;
    }
    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
    close() {}
  }
  return { api: FakeNotification as unknown as NotificationApi, calls };
}

describe("desktop notifications", () => {
  it("reports unsupported when the API is unavailable", () => {
    expect(desktopNotificationState(undefined)).toBe("unsupported");
  });

  it("requests permission only through the explicit request boundary", async () => {
    const { api } = fakeNotificationApi("granted");
    await expect(requestDesktopNotifications(api)).resolves.toBe("granted");
  });

  it("sends a notification only after permission is granted", async () => {
    const granted = fakeNotificationApi("granted");
    await expect(
      sendDesktopNotification(
        "Review is ready",
        "WTS has new work to review.",
        "review-ready",
        { api: granted.api },
      ),
    ).resolves.toBe(true);
    expect(granted.calls).toEqual([
      {
        title: "Review is ready",
        options: {
          body: "WTS has new work to review.",
          tag: "review-ready",
        },
      },
    ]);

    const denied = fakeNotificationApi("denied");
    await expect(
      sendDesktopNotification("Title", "Body", "tag", { api: denied.api }),
    ).resolves.toBe(false);
    expect(denied.calls).toHaveLength(0);
  });

  it("uses the native desktop command in a Tauri window", async () => {
    const nativeInvoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("isTauri", true);

    expect(desktopNotificationState(undefined)).toBe("granted");
    await expect(requestDesktopNotifications(undefined)).resolves.toBe(
      "granted",
    );
    await expect(
      sendDesktopNotification(
        "Review is ready",
        "WTS has new work to review.",
        "review-ready",
        { api: undefined, nativeInvoke, path: "/time" },
      ),
    ).resolves.toBe(true);
    expect(nativeInvoke).toHaveBeenCalledWith(
      "Review is ready",
      "WTS has new work to review.",
      "review-ready",
      "/time",
    );

    vi.unstubAllGlobals();
  });

  it("accepts only in-app paths as notification targets", () => {
    expect(notificationOpenPath("/time")).toBe("/time");
    expect(notificationOpenPath("/sessions/ws_1/verification")).toBe(
      "/sessions/ws_1/verification",
    );
    expect(notificationOpenPath("time")).toBeNull();
    expect(notificationOpenPath("//evil.example/x")).toBeNull();
    expect(notificationOpenPath("https://evil.example")).toBeNull();
    expect(notificationOpenPath("/a\nb")).toBeNull();
    expect(notificationOpenPath(42)).toBeNull();
  });

  it("opens the named screen when the user clicks a desktop notification", async () => {
    globalThis.history.replaceState(null, "", "/");
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (event: string, next: typeof handler) => {
      expect(event).toBe(NOTIFICATION_OPEN_EVENT);
      handler = next;
      return unlisten;
    });
    const popstate = vi.fn(() => globalThis.location.pathname);
    globalThis.addEventListener("popstate", popstate);

    const stop = subscribeNotificationOpen(listen);
    await Promise.resolve();
    handler?.({ payload: "/time" });
    expect(globalThis.location.pathname).toBe("/time");
    expect(popstate).toHaveReturnedWith("/time");

    handler?.({ payload: "https://evil.example" });
    expect(globalThis.location.pathname).toBe("/time");
    expect(popstate).toHaveBeenCalledTimes(1);

    stop();
    expect(unlisten).toHaveBeenCalled();
    globalThis.removeEventListener("popstate", popstate);
  });

  it("opens the named screen when the user clicks a browser notification", async () => {
    globalThis.history.replaceState(null, "", "/");
    const instances: Array<{ onclick?: () => void }> = [];
    class ClickableNotification {
      static permission: NotificationPermission = "granted";
      static async requestPermission() {
        return "granted" as NotificationPermission;
      }
      onclick?: () => void;
      constructor() {
        instances.push(this);
      }
      close() {}
    }
    await sendDesktopNotification("T", "B", "tag", {
      api: ClickableNotification as unknown as NotificationApi,
      path: "/reviews",
    });
    instances[0]?.onclick?.();
    expect(globalThis.location.pathname).toBe("/reviews");
  });
});
