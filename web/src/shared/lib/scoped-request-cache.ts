type Entry<T> = { promise: Promise<T>; expiresAt: number };

/** Short-lived, in-memory reads only. A new login discards the previous account's data. */
export class ScopedRequestCache<T> {
    private scope: string | undefined;
    private entries = new Map<string, Entry<T>>();

    private readonly ttlMs: number;
    private readonly limit: number;
    private readonly now: () => number;

    constructor(ttlMs: number, limit = 300, now = Date.now) {
        this.ttlMs = ttlMs;
        this.limit = limit;
        this.now = now;
    }

    read(scope: string, key: string, loader: () => Promise<T>): Promise<T> {
        if (this.scope !== scope) {
            this.clear();
            this.scope = scope;
        }
        const cached = this.entries.get(key);
        if (cached && cached.expiresAt > this.now()) return cached.promise;
        const entry: Entry<T> = { promise: undefined!, expiresAt: Infinity };
        entry.promise = Promise.resolve().then(loader).then(value => {
            if (this.entries.get(key) === entry) entry.expiresAt = this.now() + this.ttlMs;
            return value;
        }, error => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
            throw error;
        });
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
        return entry.promise;
    }

    clear() { this.entries.clear(); }
}
