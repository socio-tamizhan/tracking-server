interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
    // Prune expired entries every 5 minutes
    setInterval(() => this.prune(), 5 * 60 * 1000).unref();
  }

  set(key: string, value: T, ttlSeconds?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlSeconds ? ttlSeconds * 1000 : this.ttlMs),
    });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}

export class TokenCache {
  private token: string | null = null;
  private expiresAt = 0;

  set(token: string, expiresInSeconds: number): void {
    this.token = token;
    this.expiresAt = Date.now() + (expiresInSeconds - 60) * 1000; // 60s buffer
  }

  get(): string | null {
    if (!this.token || Date.now() > this.expiresAt) return null;
    return this.token;
  }

  clear(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}
