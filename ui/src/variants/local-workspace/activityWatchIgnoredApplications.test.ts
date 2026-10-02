import { describe, expect, it } from "vitest";
import {
  isApplicationIgnored,
  loadIgnoredApplications,
  saveIgnoredApplications,
} from "./activityWatchIgnoredApplications";

describe("ActivityWatch ignored applications", () => {
  it("ignores macOS loginwindow by default without hiding unrelated work", () => {
    const storage = { getItem: () => null };
    const ignored = loadIgnoredApplications(storage);
    expect(isApplicationIgnored("loginwindow", ignored)).toBe(true);
    expect(isApplicationIgnored("Visual Studio Code", ignored)).toBe(false);
  });

  it("persists normalized user choices and allows defaults to be restored", () => {
    let stored = "";
    const storage = {
      getItem: () => stored || null,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    expect(saveIgnoredApplications(new Set([" LoginWindow ", "Dialog"]), storage)).toBe(true);
    const ignored = loadIgnoredApplications(storage);
    expect([...ignored]).toEqual(["dialog", "loginwindow"]);
    expect(isApplicationIgnored("DIALOG", ignored)).toBe(true);
  });

  it("rejects malformed persisted values and falls back safely", () => {
    const ignored = loadIgnoredApplications({
      getItem: () => JSON.stringify(["x".repeat(121)]),
    });
    expect([...ignored]).toEqual(["loginwindow"]);
  });
});
