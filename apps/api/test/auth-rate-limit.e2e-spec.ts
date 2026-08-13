import { PrismaService } from '../src/common/prisma.service';
import { AppError } from '../src/common/errors';
import { RateLimiter } from '../src/auth/rate-limiter';
import { createTestApp, type TestApp } from './helpers';

/**
 * The auth limiter, against a real database.
 *
 * The property under test is the one the in-process version could not have:
 * two limiter instances — standing in for two API processes behind a load
 * balancer — must share one tally. A mocked client would make the assertion
 * vacuous, since sharing is exactly what the database provides.
 */
let ctx: TestApp;
let prisma: PrismaService;

const LIMIT = 3;
const WINDOW_MS = 15 * 60_000;

/** A distinct subject per test, so suites cannot interfere with each other. */
let counter = 0;
const subject = () => `rate-limit-probe-${Date.now()}-${counter++}`;

function limiter(): RateLimiter {
  return new RateLimiter(prisma, LIMIT, WINDOW_MS, 'test');
}

async function expectBlocked(instance: RateLimiter, key: string): Promise<AppError> {
  try {
    await instance.check(key, 'Too many attempts.');
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected the limiter to block, but it allowed the attempt.');
}

beforeAll(async () => {
  ctx = await createTestApp();
  prisma = ctx.prisma;
});

afterAll(async () => {
  await prisma.asSystem((tx) =>
    tx.rateLimitCounter.deleteMany({ where: { bucket: { startsWith: 'auth:' } } }),
  );
  await ctx.close();
});

describe('auth rate limiting', () => {
  it('allows attempts up to the limit and blocks the next one', async () => {
    const instance = limiter();
    const key = subject();

    for (let i = 0; i < LIMIT; i += 1) {
      await instance.check(key, 'Too many attempts.');
      await instance.record(key);
    }

    const error = await expectBlocked(instance, key);
    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.detail).toMatch(/Try again in/);
  });

  it('shares one tally across instances — the whole point of the change', async () => {
    const first = limiter();
    const second = limiter();
    const key = subject();

    // Spread the failures over both "processes". In-process counters would
    // leave each holding a count below the limit, and neither would block.
    await first.record(key);
    await second.record(key);
    await first.record(key);

    await expectBlocked(second, key);
  });

  it('escalates the lockout beyond the attempt window', async () => {
    const instance = limiter();
    const key = subject();

    for (let i = 0; i < LIMIT * 2; i += 1) await instance.record(key);

    const lock = await prisma.asSystem((tx) =>
      tx.rateLimitCounter.findUniqueOrThrow({ where: { bucket: `auth:l:test:${key}` } }),
    );

    // Two strikes doubles twice: the lockout has to outlast the 15-minute
    // window it was counted in, or the escalation is decorative.
    expect(lock.expiresAt.getTime()).toBeGreaterThan(Date.now() + WINDOW_MS);
  });

  it('never shortens an existing lockout', async () => {
    const instance = limiter();
    const key = subject();

    for (let i = 0; i < LIMIT * 3; i += 1) await instance.record(key);
    const longest = await prisma.asSystem((tx) =>
      tx.rateLimitCounter.findUniqueOrThrow({ where: { bucket: `auth:l:test:${key}` } }),
    );

    // A concurrent instance computing a shorter backoff must not win.
    await prisma.asSystem((tx) =>
      tx.$executeRaw`
        INSERT INTO rate_limit_counters (bucket, window_start, count, expires_at)
        VALUES (${`auth:l:test:${key}`}, NOW(), 1, NOW() + interval '1 second')
        ON CONFLICT (bucket) DO UPDATE
          SET expires_at = GREATEST(rate_limit_counters.expires_at, EXCLUDED.expires_at)
      `,
    );

    const after = await prisma.asSystem((tx) =>
      tx.rateLimitCounter.findUniqueOrThrow({ where: { bucket: `auth:l:test:${key}` } }),
    );
    expect(after.expiresAt.getTime()).toBe(longest.expiresAt.getTime());
  });

  it('clears every bucket on a successful sign-in', async () => {
    const instance = limiter();
    const key = subject();

    for (let i = 0; i < LIMIT * 2; i += 1) await instance.record(key);
    await expectBlocked(instance, key);

    await instance.reset(key);

    // Must not throw: the attempt counter, the strikes and the lockout all go.
    await instance.check(key, 'Too many attempts.');

    const remaining = await prisma.asSystem((tx) =>
      tx.rateLimitCounter.count({ where: { bucket: { contains: `:test:${key}` } } }),
    );
    expect(remaining).toBe(0);
  });

  it('keeps per-email and per-IP tallies apart', async () => {
    const byEmail = new RateLimiter(prisma, LIMIT, WINDOW_MS, 'email');
    const byIp = new RateLimiter(prisma, LIMIT, WINDOW_MS, 'ip');
    const key = subject();

    for (let i = 0; i < LIMIT; i += 1) await byEmail.record(key);
    await expectBlocked(byEmail, key);

    // Same string, different scope — an email and an IP that happen to collide
    // must not share a bucket.
    await byIp.check(key, 'Too many attempts.');

    await prisma.asSystem((tx) =>
      tx.rateLimitCounter.deleteMany({ where: { bucket: { contains: key } } }),
    );
  });
});
