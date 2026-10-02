import { describe, expect, it, vi } from "vitest";
import { WorkspaceMemoryCache } from "./workspaceMemoryCache";

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("workspace memory cache", () => {
  it("shares an active transport read and lets a mutation supersede it", async () => {
    const cache = new WorkspaceMemoryCache<string>();
    const read = pending<string>();
    const transport = vi.fn(() => read.promise);
    const first = cache.load("a", transport);
    const second = cache.load("a", transport);
    await Promise.resolve();
    expect(transport).toHaveBeenCalledTimes(1);
    cache.set("a", "saved contents");
    read.resolve("old contents");
    expect(await first).toBe("saved contents");
    expect(await second).toBe("saved contents");
    expect(cache.get("a")).toBe("saved contents");
  });

  it("evicts the least recently used entry and does not restore an evicted read", async () => {
    const cache = new WorkspaceMemoryCache<string>(2);
    const read = pending<string>();
    const loading = cache.load("old", () => read.promise);
    cache.set("recent", "recent value");
    cache.set("latest", "latest value");
    read.resolve("old value");
    await loading;
    expect(cache.has("old")).toBe(false);
    expect(cache.get("recent")).toBe("recent value");
    cache.set("new", "new value");
    expect(cache.has("latest")).toBe(false);
    expect(cache.has("recent")).toBe(true);
  });

  it("keeps cached content after a refresh failure and permits another read", async () => {
    const cache = new WorkspaceMemoryCache<string>();
    cache.set("a", "cached");
    await expect(cache.load("a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(cache.get("a")).toBe("cached");
    expect(await cache.load("a", async () => "fresh")).toBe("fresh");
  });
});
