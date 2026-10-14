interface CacheEntry<T> {
  present: boolean;
  value?: T;
  pending?: Promise<T>;
}

/** Keeps recent results and shares reads. A write supersedes earlier reads. */
export class WorkspaceMemoryCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly limit = 24) {}

  has(key: string): boolean {
    return this.entries.get(key)?.present ?? false;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.touch(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.touch(key, { present: true, value });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }

  load(key: string, read: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key) ?? { present: false };
    this.touch(key, entry);
    if (entry.pending) return entry.pending;
    const latestValue = (fallback: T) => {
      const latest = this.entries.get(key);
      return latest?.present ? latest.value as T : fallback;
    };
    const pending = Promise.resolve().then(read).then(
      (value) => {
        if (this.entries.get(key) !== entry) return latestValue(value);
        entry.present = true;
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        const latest = this.entries.get(key);
        if (latest !== entry && latest?.present) return latest.value as T;
        throw error;
      },
    ).finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
    });
    entry.pending = pending;
    return pending;
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
