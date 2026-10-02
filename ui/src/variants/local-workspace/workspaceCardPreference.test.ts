import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_CARD_CLICK_STORAGE_KEY,
  loadWorkspaceCardClickPreference,
  normalizeWorkspaceCardClickPreference,
  resolveWorkspaceCardAction,
  setWorkspaceCardClickPreference,
} from "./workspaceCardPreference";

afterEach(() => {
  localStorage.removeItem(WORKSPACE_CARD_CLICK_STORAGE_KEY);
});

describe("workspace card click preference", () => {
  it("uses details by default and normalizes unknown stored values", () => {
    expect(loadWorkspaceCardClickPreference()).toBe("details");
    expect(normalizeWorkspaceCardClickPreference("unknown")).toBe("details");
  });

  it("persists workspace-first behavior", () => {
    setWorkspaceCardClickPreference("workspace");
    expect(localStorage.getItem(WORKSPACE_CARD_CLICK_STORAGE_KEY)).toBe(
      "workspace",
    );
    expect(loadWorkspaceCardClickPreference()).toBe("workspace");
  });

  it("uses Command-click for the alternate card action", () => {
    expect(resolveWorkspaceCardAction("details", false, true)).toBe(
      "details",
    );
    expect(resolveWorkspaceCardAction("details", true, true)).toBe(
      "workspace",
    );
    expect(resolveWorkspaceCardAction("workspace", false, true)).toBe(
      "workspace",
    );
    expect(resolveWorkspaceCardAction("workspace", true, true)).toBe(
      "details",
    );
    expect(resolveWorkspaceCardAction("workspace", false, false)).toBe(
      "details",
    );
  });
});
