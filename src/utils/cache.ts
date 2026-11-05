// Minimal in-memory TTL cache for hot, rarely-changing lookups (tenant, user + permissions).
// Entries expire on their own; call invalidate() after writes that change the cached data.
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private ttlMs: number, private maxEntries = 5000) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V) {
    if (this.store.size >= this.maxEntries) {
      // Drop the oldest entry (Map keeps insertion order)
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}
