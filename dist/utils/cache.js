"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TtlCache = void 0;
// Minimal in-memory TTL cache for hot, rarely-changing lookups (tenant, user + permissions).
// Entries expire on their own; call invalidate() after writes that change the cached data.
class TtlCache {
    ttlMs;
    maxEntries;
    store = new Map();
    constructor(ttlMs, maxEntries = 5000) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        if (this.store.size >= this.maxEntries) {
            // Drop the oldest entry (Map keeps insertion order)
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined)
                this.store.delete(oldest);
        }
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
    invalidate(key) {
        this.store.delete(key);
    }
    clear() {
        this.store.clear();
    }
}
exports.TtlCache = TtlCache;
