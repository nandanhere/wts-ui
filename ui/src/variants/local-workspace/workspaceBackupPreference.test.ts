import { beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkspaceBackupPreference,
  setWorkspaceBackupPreference,
  WORKSPACE_BACKUP_STORAGE_KEY,
} from "./workspaceBackupPreference";

describe("workspaceBackupPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to empty string when not set", () => {
    expect(loadWorkspaceBackupPreference()).toBe("");
  });

  it("stores and loads a configured backup path", () => {
    setWorkspaceBackupPreference("/Users/test/backups");
    expect(localStorage.getItem(WORKSPACE_BACKUP_STORAGE_KEY)).toBe(
      "/Users/test/backups",
    );
    expect(loadWorkspaceBackupPreference()).toBe("/Users/test/backups");
  });

  it("trims whitespace when storing", () => {
    setWorkspaceBackupPreference("  /Users/test/wts-backups  ");
    expect(loadWorkspaceBackupPreference()).toBe("/Users/test/wts-backups");
  });
});
