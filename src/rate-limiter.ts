/**
 * Per-user in-memory rate limiter for HTTP (Cloud Run) mode.
 *
 * Uses a fixed-window counter: each user gets a fresh quota every windowMs.
 * Default: 60 requests per minute — enough for any normal Claude session,
 * but prevents one user from hammering the Dropbox API and burning quota for everyone.
 *
 * Limitation: this is per-instance. If Cloud Run scales to multiple instances,
 * each has its own counter (so the effective limit is max * instances).
 * With min-instances=1 and a mid-size company this is fine — a single instance
 * handles all traffic. If you ever scale up, move this to Firestore or Redis.
 */

interface Window {
  count: number;
  resetAt: number; // unix ms when this window expires
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 60, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /**
   * Consume one request for the given key (user email).
   * Returns true if allowed, false if the limit is exceeded.
   */
  check(key: string): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (existing.count >= this.max) {
      return false;
    }

    existing.count++;
    return true;
  }

  /**
   * Seconds until the current window resets for this key.
   * Use this for the Retry-After header on 429 responses.
   */
  retryAfter(key: string): number {
    const existing = this.windows.get(key);
    if (!existing) return 0;
    return Math.ceil((existing.resetAt - Date.now()) / 1000);
  }
}
