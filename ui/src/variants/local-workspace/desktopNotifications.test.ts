import { describe, expect, it, vi } from "vitest";
import {
  desktopNotificationState,
  requestDesktopNotifications,
  sendDesktopNotification,
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
        granted.api,
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
      sendDesktopNotification("Title", "Body", "tag", denied.api),
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
        undefined,
        nativeInvoke,
      ),
    ).resolves.toBe(true);
    expect(nativeInvoke).toHaveBeenCalledWith(
      "Review is ready",
      "WTS has new work to review.",
      "review-ready",
    );

    vi.unstubAllGlobals();
  });
});
