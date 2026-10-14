import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceAttention } from "./useWorkspaceAttention";
import type { WorkspaceAttentionSnapshot, WorkspaceAttentionStore } from "./workspaceAttention";

describe("attention render isolation", () => {
  it("keeps unrelated workspace status out of the board subscription", () => {
    let snapshot: WorkspaceAttentionSnapshot = { items: [], history: [], sources: {}, inboxes: {}, refreshing: false };
    const listeners = new Set<() => void>();
    const store: WorkspaceAttentionStore = { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh: vi.fn(), acknowledge: vi.fn() };
    const render = vi.fn();
    const hook = renderHook(() => { render(); return useWorkspaceAttention(store, value => ({ items: value.items, refreshing: value.refreshing }),
      (a, b) => a.items === b.items && a.refreshing === b.refreshing); });
    expect(render).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) {
      act(() => {
        const fresh = { status: "fresh" as const, refreshing: false, updatedAt: index, error: "", detail: "" };
        snapshot = { ...snapshot, sources: { ...snapshot.sources, [`workspace-${index}`]: { agent: fresh, verification: fresh, gitlab: fresh } } };
        listeners.forEach(listener => listener());
      });
    }
    expect(render).toHaveBeenCalledTimes(1);
    act(() => { snapshot = { ...snapshot, refreshing: true }; listeners.forEach(listener => listener()); });
    expect(hook.result.current.refreshing).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
    hook.unmount(); expect(listeners.size).toBe(0);
  });
});
