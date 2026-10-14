import { describe, expect, it } from "vitest";
import {
  CHECK_FOR_UPDATE_TAURI_COMMAND,
  DOWNLOAD_AND_INSTALL_UPDATE_TAURI_COMMAND,
  GET_UPDATE_STATUS_TAURI_COMMAND,
  RELAUNCH_UPDATED_APP_TAURI_COMMAND,
  normalizeAppUpdateProgress,
  normalizeAppUpdateStatus,
} from "./wtsClient";

describe("app update transport contract", () => {
  it("normalizes a bounded available update", () => {
    expect(normalizeAppUpdateStatus({
      schemaVersion: 1,
      state: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0-qa.1",
      publishedAt: "2026-08-14T08:15:00Z",
      notes: "Fixes the app reopen flow.",
      detail: "A signed local update is ready to download.",
    })).toMatchObject({
      state: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0-qa.1",
    });
  });

  it("keeps the Tauri command names stable", () => {
    expect(GET_UPDATE_STATUS_TAURI_COMMAND).toBe("get_update_status");
    expect(CHECK_FOR_UPDATE_TAURI_COMMAND).toBe("check_for_update");
    expect(DOWNLOAD_AND_INSTALL_UPDATE_TAURI_COMMAND).toBe(
      "download_and_install_update",
    );
    expect(RELAUNCH_UPDATED_APP_TAURI_COMMAND).toBe("relaunch_updated_app");
  });

  it("normalizes bounded native download progress", () => {
    expect(normalizeAppUpdateProgress({
      version: "0.2.0",
      downloadedBytes: 512,
      totalBytes: 1_024,
    })).toEqual({
      version: "0.2.0",
      downloadedBytes: 512,
      totalBytes: 1_024,
    });
    expect(() => normalizeAppUpdateProgress({
      version: "0.2.0",
      downloadedBytes: 2_048,
      totalBytes: 1_024,
    })).toThrow(/invalid/i);
  });

  it.each([
    {
      schemaVersion: 1,
      state: "upToDate",
      currentVersion: "version one",
      detail: "Current.",
    },
    {
      schemaVersion: 1,
      state: "disabled",
      currentVersion: "0.1.0",
      detail: "Disabled.",
    },
    {
      schemaVersion: 1,
      state: "error",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      detail: "Offline.",
      diagnosticCode: "networkUnavailable",
    },
    {
      schemaVersion: 1,
      state: "downloading",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      downloadedBytes: 2_000,
      totalBytes: 1_000,
      detail: "Downloads.",
    },
    {
      schemaVersion: 1,
      state: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      notes: "x".repeat(4_001),
      detail: "Available.",
    },
    {
      schemaVersion: 1,
      state: "upToDate",
      currentVersion: "0.1.0",
      detail: "x".repeat(2_049),
    },
  ])("rejects malformed or oversized update payload %#", (payload) => {
    expect(() => normalizeAppUpdateStatus(payload)).toThrow(/invalid/i);
  });
});
