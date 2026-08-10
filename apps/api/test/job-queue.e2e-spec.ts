import { ConfigService } from '@nestjs/config';

import { JobQueueService } from '../src/jobs/job-queue.service';
import { JOB_NAMES } from '../src/jobs/job-names';
import { PrismaService } from '../src/common/prisma.service';
import { createTestApp, type TestApp } from './helpers';

/**
 * The Postgres-backed queue, against a real database.
 *
 * Claiming is raw SQL built on `FOR UPDATE SKIP LOCKED`, so a mocked client
 * would prove nothing about the part most likely to be wrong.
 */
let ctx: TestApp;
let prisma: PrismaService;
let previousNodeEnv: string | undefined;
let previousWorkerEnabled: string | undefined;

/** A queue that is enabled but drains only when the test says so. */
function buildQueue(): JobQueueService {
  return new JobQueueService(
    prisma,
    new ConfigService({ JOB_WORKER_ENABLED: 'false', JOB_BATCH_SIZE: '10' }),
  );
}

beforeAll(async () => {
  // The service disables itself under NODE_ENV=test so that the app under test
  // never starts a background loop. Here we are testing the queue itself.
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';

  // Leaving NODE_ENV as development also wakes the *application's* own queue,
  // whose polling timer would outlive the suite. Tests here step drain() by
  // hand, which does not consult this flag, so switching the loop off costs
  // nothing and keeps the process exiting cleanly.
  previousWorkerEnabled = process.env.JOB_WORKER_ENABLED;
  process.env.JOB_WORKER_ENABLED = 'false';

  ctx = await createTestApp();
  prisma = ctx.prisma;
});

afterAll(async () => {
  // These tests are the only thing that ever queues these job names, and the
  // recurring ones would otherwise be left behind as permanent schedules that
  // the real application has no processor for — a failing job every minute, in
  // whatever database the suite last ran against.
  await prisma.asSystem((tx) =>
    tx.job.deleteMany({
      where: {
        name: {
          in: [
            JOB_NAMES.purgeSoftDeleted,
            JOB_NAMES.keyUsageFlush,
            JOB_NAMES.mediaTransform,
            JOB_NAMES.analyticsRollup,
            JOB_NAMES.subscriberImport,
            JOB_NAMES.subscriberExport,
          ],
        },
      },
    }),
  );

  process.env.NODE_ENV = previousNodeEnv;
  process.env.JOB_WORKER_ENABLED = previousWorkerEnabled;
  await ctx.close();
});

async function jobRow(id: string) {
  return prisma.asSystem((tx) => tx.job.findUniqueOrThrow({ where: { id } }));
}

describe('Postgres job queue', () => {
  it('runs a queued job once and marks it completed', async () => {
    const queue = buildQueue();
    const seen: string[] = [];
    queue.registerProcessor(JOB_NAMES.purgeSoftDeleted, async (job) => {
      seen.push(job.id);
    });

    const id = (await queue.enqueue(JOB_NAMES.purgeSoftDeleted, { probe: 'once' }))!;
    expect(id).toBeTruthy();

    await queue.drain();
    expect(seen).toContain(id);

    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.attempts).toBe(1);

    // A second drain must not run it again.
    await queue.drain();
    expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
  });

  it('hands a job to only one of two competing workers', async () => {
    const first = buildQueue();
    const second = buildQueue();

    const runs: string[] = [];
    const processor = async (job: { id: string }) => {
      runs.push(job.id);
    };
    first.registerProcessor(JOB_NAMES.keyUsageFlush, processor);
    second.registerProcessor(JOB_NAMES.keyUsageFlush, processor);

    const id = (await first.enqueue(JOB_NAMES.keyUsageFlush))!;

    // SKIP LOCKED is what makes this safe; without it both would claim the row.
    await Promise.all([first.drain(), second.drain()]);

    expect(runs.filter((runId) => runId === id)).toHaveLength(1);
    expect((await jobRow(id)).status).toBe('completed');
  });

  it('retries a failing job with backoff, then dead-letters it', async () => {
    const queue = buildQueue();
    queue.registerProcessor(JOB_NAMES.mediaTransform, async () => {
      throw new Error('storage unavailable');
    });

    const id = (await queue.enqueue(JOB_NAMES.mediaTransform, {}, { maxAttempts: 2 }))!;

    await queue.drain();
    let row = await jobRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('storage unavailable');
    // Backoff pushes it into the future, so an immediate drain skips it.
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());

    await queue.drain();
    expect((await jobRow(id)).attempts).toBe(1);

    // Bring it due and let the final attempt exhaust maxAttempts.
    await prisma.asSystem((tx) =>
      tx.job.update({ where: { id }, data: { runAt: new Date(Date.now() - 1000) } }),
    );
    await queue.drain();

    row = await jobRow(id);
    expect(row.status).toBe('dead_lettered');
    expect(row.attempts).toBe(2);
  });

  it('keeps a recurring job alive instead of dead-lettering it', async () => {
    const queue = buildQueue();
    queue.registerRecurring(JOB_NAMES.analyticsRollup, 60_000, async () => {
      throw new Error('rollup exploded');
    });

    // registerRecurring only declares it; bootstrap creates the row.
    await queue.onApplicationBootstrap();

    const row = await prisma.asSystem((tx) =>
      tx.job.findUniqueOrThrow({ where: { dedupeKey: `recurring:${JOB_NAMES.analyticsRollup}` } }),
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await prisma.asSystem((tx) =>
        tx.job.update({ where: { id: row.id }, data: { runAt: new Date(Date.now() - 1000) } }),
      );
      await queue.drain();
    }

    const after = await jobRow(row.id);
    // A schedule that stops after a few bad minutes is worse than one that keeps trying.
    expect(after.status).toBe('pending');
    expect(after.lastError).toContain('rollup exploded');
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('reschedules a recurring job forward after a successful run', async () => {
    const queue = buildQueue();
    let runs = 0;
    queue.registerRecurring(JOB_NAMES.purgeSoftDeleted, 60_000, async () => {
      runs += 1;
    });
    await queue.onApplicationBootstrap();

    const row = await prisma.asSystem((tx) =>
      tx.job.findUniqueOrThrow({ where: { dedupeKey: `recurring:${JOB_NAMES.purgeSoftDeleted}` } }),
    );

    // Bootstrap deliberately leaves an existing schedule's run_at alone, so a
    // restart does not re-run every recurring job immediately. That means the
    // row is only due here if this is the first run against this database.
    await prisma.asSystem((tx) =>
      tx.job.update({ where: { id: row.id }, data: { runAt: new Date(Date.now() - 1000) } }),
    );

    await queue.drain();
    expect(runs).toBe(1);

    const after = await jobRow(row.id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it('reuses one row for a dedupe key rather than queueing duplicates', async () => {
    const queue = buildQueue();
    const key = `test-dedupe-${Date.now()}`;

    const first = await queue.enqueue(JOB_NAMES.subscriberExport, {}, { dedupeKey: key });
    await queue.enqueue(JOB_NAMES.subscriberExport, {}, { dedupeKey: key });

    const rows = await prisma.asSystem((tx) => tx.job.findMany({ where: { dedupeKey: key } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first);
  });

  it('releases a claim whose worker died', async () => {
    const queue = buildQueue();
    const runs: string[] = [];
    queue.registerProcessor(JOB_NAMES.subscriberImport, async (job) => {
      runs.push(job.id);
    });

    const id = (await queue.enqueue(JOB_NAMES.subscriberImport))!;

    // Exactly the state a hard crash mid-run leaves behind.
    await prisma.asSystem((tx) =>
      tx.job.update({
        where: { id },
        data: {
          status: 'running',
          lockedAt: new Date(Date.now() - 60 * 60_000),
          lockedBy: 'dead-worker',
        },
      }),
    );

    await queue.drain();

    expect(runs).toContain(id);
    expect((await jobRow(id)).status).toBe('completed');
  });
});
