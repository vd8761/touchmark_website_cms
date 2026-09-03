import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { AppError } from '../common/errors';

/**
 * Fixed-window counter with exponential lockout, for the auth endpoints of
 * §6.1: "5 failed logins per email per 15 min, 20 per IP per 15 min;
 * exponential lockout after that."
 *
 * **Shared, not in-process.** This used to be a `Map` on the service, which is
 * exactly right on one instance and wrong on two: N instances each keep their
 * own tally, so the real limit is N×5 and adding capacity quietly weakens the
 * brute-force defence. It now counts in `rate_limit_counters`, the same table
 * the Delivery API limiter uses, so the limit is a property of the platform
 * rather than of one process — and no new infrastructure appears to get it.
 *
 * Three rows model one subject:
 *
 * | Bucket      | Holds                                          |
 * |-------------|------------------------------------------------|
 * | `auth:a:…`  | attempts in the current 15-minute window       |
 * | `auth:s:…`  | strikes — times the limit has been hit today   |
 * | `auth:l:…`  | the lockout, as `expires_at`                   |
 *
 * Splitting them is what makes the lockout survive the attempt window rolling
 * over. A single counter cannot express "you may try again in four hours",
 * because the window it is counted in is fifteen minutes long.
 */
export class RateLimiter {
  private static readonly logger = new Logger(RateLimiter.name);

  /** Strikes decay on a daily boundary, so a lockout cannot escalate forever. */
  private static readonly STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
  private static readonly MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limit: number,
    private readonly windowMs: number,
    /** Distinguishes the per-email limiter's rows from the per-IP one's. */
    private readonly scope: string,
  ) {}

  /**
   * Throws when the subject is currently barred.
   *
   * Infrastructure failures here are logged and allowed through, deliberately.
   * A limiter that fails closed would turn a database blip into a total sign-in
   * outage — and it would buy nothing, because every path this guards has to
   * reach the same database one statement later to look the user up. The
   * failure mode is "the limiter is briefly absent", not "the limiter is
   * bypassed while logins still work".
   */
  async check(key: string, message: string): Promise<void> {
    try {
      const now = Date.now();

      const lock = await this.read(this.bucket('l', key));
      if (lock && lock.expiresAt.getTime() > now) {
        throw this.exceeded(message, lock.expiresAt.getTime() - now);
      }

      const attempts = await this.read(this.bucket('a', key));
      if (!attempts) return;

      const windowEnd = attempts.windowStart.getTime() + this.windowMs;
      if (windowEnd > now && attempts.count >= this.limit) {
        throw this.exceeded(message, windowEnd - now);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      RateLimiter.logger.error(`Auth rate limit check failed: ${(error as Error).message}`);
    }
  }

  /**
   * Counts one failure.
   *
   * Reaching the limit takes a strike and extends the lockout to
   * `window × 2^strikes`, capped at a day: 15 minutes, then 30, then an hour,
   * and so on. The doubling is what separates a person who has forgotten which
   * password they used from a script working through a list.
   */
  async record(key: string): Promise<void> {
    try {
      const now = Date.now();
      const attempts = await this.increment(this.bucket('a', key), now, this.windowMs);
      if (attempts < this.limit) return;

      const strikes = await this.increment(
        this.bucket('s', key),
        now,
        RateLimiter.STRIKE_WINDOW_MS,
      );
      const backoff = Math.min(this.windowMs * 2 ** strikes, RateLimiter.MAX_LOCKOUT_MS);

      await this.setLock(this.bucket('l', key), new Date(now + backoff));
    } catch (error) {
      // Never let bookkeeping mask the caller's real result — a failure to
      // record a bad password must still surface as a bad password.
      RateLimiter.logger.error(`Auth rate limit record failed: ${(error as Error).message}`);
    }
  }

  /** Clears every trace of a subject. Called on a successful sign-in. */
  async reset(key: string): Promise<void> {
    try {
      await this.prisma.asSystem((tx) =>
        tx.rateLimitCounter.deleteMany({
          where: { bucket: { in: ['a', 's', 'l'].map((kind) => this.bucket(kind, key)) } },
        }),
      );
    } catch (error) {
      RateLimiter.logger.error(`Auth rate limit reset failed: ${(error as Error).message}`);
    }
  }

  // -- storage ---------------------------------------------------------------

  private bucket(kind: string, key: string): string {
    return `auth:${kind}:${this.scope}:${key}`;
  }

  private async read(
    bucket: string,
  ): Promise<{ count: number; windowStart: Date; expiresAt: Date } | null> {
    const row = await this.prisma.asSystem((tx) =>
      tx.rateLimitCounter.findUnique({ where: { bucket } }),
    );
    return row ?? null;
  }

  /**
   * Increments a fixed-window counter and returns its new value.
   *
   * The same single-statement upsert the Delivery limiter uses: two instances
   * racing on one bucket still produce consecutive counts, because the
   * increment happens inside the row lock Postgres already takes. Expiry is
   * arithmetic — a stored `window_start` from an older window resets the count
   * to 1 rather than waiting for a sweep to remove the row.
   */
  private async increment(bucket: string, now: number, windowMs: number): Promise<number> {
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs * 2);

    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        INSERT INTO rate_limit_counters (bucket, window_start, count, expires_at)
        VALUES (${bucket}, ${windowStart}, 1, ${expiresAt})
        ON CONFLICT (bucket) DO UPDATE
          SET count = CASE
                        WHEN rate_limit_counters.window_start = EXCLUDED.window_start
                        THEN rate_limit_counters.count + 1
                        ELSE 1
                      END,
              window_start = EXCLUDED.window_start,
              expires_at = EXCLUDED.expires_at
        RETURNING count
      `),
    );

    return Number(rows[0].count);
  }

  /**
   * Writes the lockout deadline.
   *
   * `GREATEST` matters: two instances recording the fifth and sixth failure at
   * the same moment must not let the shorter of the two lockouts overwrite the
   * longer one. A lockout may only ever be extended.
   */
  private async setLock(bucket: string, until: Date): Promise<void> {
    await this.prisma.asSystem((tx) =>
      tx.$executeRaw(Prisma.sql`
        INSERT INTO rate_limit_counters (bucket, window_start, count, expires_at)
        VALUES (${bucket}, NOW(), 1, ${until})
        ON CONFLICT (bucket) DO UPDATE
          SET expires_at = GREATEST(rate_limit_counters.expires_at, EXCLUDED.expires_at),
              count = rate_limit_counters.count + 1
      `),
    );
  }

  private exceeded(message: string, remainingMs: number): AppError {
    const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
    return new AppError('rate_limit_exceeded', message, {
      detail: `Try again in ${formatDuration(retryAfter)}.`,
    });
  }
}

/** "45 seconds", "3 minutes", "2 hours" — a lockout may now be hours long. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
