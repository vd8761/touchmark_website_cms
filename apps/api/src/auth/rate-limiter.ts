import { AppError } from '../common/errors';

/**
 * Fixed-window counter with exponential lockout, for the auth endpoints of
 * §6.1: "5 failed logins per email per 15 min, 20 per IP per 15 min;
 * exponential lockout after that."
 *
 * In-process, which is correct for a single instance and too permissive across
 * several: N instances allow roughly N times the limit. The platform stores
 * everything in Postgres and nothing else, so the shared version of this is the
 * `rate_limit_counters` table that ApiKeysService already uses — this interface
 * is the seam to move it behind when a deployment first runs more than one
 * instance. It is not there yet, and pretending otherwise in a comment helped
 * nobody.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number; strikes: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, message: string): void {
    const entry = this.hits.get(key);
    if (!entry) return;

    if (Date.now() > entry.resetAt) {
      this.hits.delete(key);
      return;
    }

    if (entry.count >= this.limit) {
      const retryAfter = Math.ceil((entry.resetAt - Date.now()) / 1000);
      throw new AppError('rate_limit_exceeded', message, {
        detail: `Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
      });
    }
  }

  record(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs, strikes: 0 });
      return;
    }

    entry.count += 1;

    // Each time the limit is hit again, the window doubles — up to 24 hours.
    if (entry.count >= this.limit) {
      entry.strikes += 1;
      const backoff = Math.min(this.windowMs * 2 ** entry.strikes, 24 * 60 * 60 * 1000);
      entry.resetAt = now + backoff;
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
