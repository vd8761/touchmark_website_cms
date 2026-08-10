import { randomUUID } from 'node:crypto';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';
import { isJobName, type JobName } from './job-names';

type JobPayload = Record<string, unknown>;

export interface ClaimedJob {
  id: string;
  name: JobName;
  payload: JobPayload;
  attempts: number;
}

type JobProcessor = (job: ClaimedJob) => Promise<unknown>;

interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Reuse an existing row with this key instead of adding a second one. */
  dedupeKey?: string;
}

/**
 * Deferred work, backed by Postgres.
 *
 * There is no broker. Postgres is the only datastore this platform requires, and
 * a second one — to deploy, secure, back up, monitor and restore — costs more in
 * practice than the throughput a dedicated queue would buy at this size.
 *
 * Correctness comes from `FOR UPDATE SKIP LOCKED`: a claim locks the rows it
 * takes and every other worker skips straight past them, so several API
 * instances can run this loop at once and no job is ever handed out twice.
 * That, not the polling interval, is the load-bearing part.
 *
 * The trade this accepts: latency is bounded below by the poll interval, and a
 * claimed job whose process dies stays claimed until the stale-claim sweep
 * releases it. Both are fine for publishing content and delivering webhooks;
 * neither would be fine for a low-latency fan-out, which this is not.
 */
@Injectable()
export class JobQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly processors = new Map<JobName, JobProcessor>();
  private readonly recurring: { name: JobName; intervalMs: number }[] = [];

  private readonly enabled: boolean;
  private readonly workerEnabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  /** How long a claim may sit untouched before another worker may take it. */
  private readonly claimTimeoutMs: number;
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Tests drive the runner directly; a background loop there would make them
    // non-deterministic and leak open handles.
    this.enabled =
      config.get<string>('NODE_ENV') !== 'test' &&
      config.get<string>('JOB_QUEUE_ENABLED') !== 'false';
    this.workerEnabled = this.enabled && config.get<string>('JOB_WORKER_ENABLED') !== 'false';
    this.pollIntervalMs = positiveInt(config.get<string>('JOB_POLL_INTERVAL_MS'), 5_000);
    this.batchSize = positiveInt(config.get<string>('JOB_BATCH_SIZE'), 10);
    this.claimTimeoutMs = positiveInt(config.get<string>('JOB_CLAIM_TIMEOUT_MS'), 5 * 60_000);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isWorkerEnabled(): boolean {
    return this.workerEnabled;
  }

  /** Queues one job. Returns null when the queue is disabled, as it is in tests. */
  async enqueue(
    name: JobName,
    payload: JobPayload = {},
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!this.enabled) return null;

    const id = newId();
    const runAt = options.runAt ?? new Date();

    // A dedupe key collides with the row already queued for that key; bringing
    // its run_at forward is the useful behaviour, because the caller is asking
    // for the work to happen *now*.
    if (options.dedupeKey) {
      await this.prisma.asSystem((tx) =>
        tx.job.upsert({
          where: { dedupeKey: options.dedupeKey },
          create: {
            id,
            name,
            payload: payload as Prisma.InputJsonValue,
            runAt,
            dedupeKey: options.dedupeKey,
            maxAttempts: options.maxAttempts ?? 3,
          },
          update: { runAt, status: 'pending' },
        }),
      );
      return id;
    }

    await this.prisma.asSystem((tx) =>
      tx.job.create({
        data: {
          id,
          name,
          payload: payload as Prisma.InputJsonValue,
          runAt,
          maxAttempts: options.maxAttempts ?? 3,
        },
      }),
    );
    return id;
  }

  registerProcessor(name: JobName, processor: JobProcessor): void {
    this.processors.set(name, processor);
  }

  /**
   * Declares a job that should keep running forever.
   *
   * The schedule is a row, not a cron expression: after each run the worker
   * pushes `run_at` one interval into the future. One row per recurring job,
   * held by its dedupe key, so restarting an instance re-uses the schedule
   * rather than adding a second copy of it.
   */
  registerRecurring(name: JobName, intervalMs: number, processor: JobProcessor): void {
    this.registerProcessor(name, processor);
    this.recurring.push({ name, intervalMs });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Job queue disabled.');
      return;
    }

    for (const job of this.recurring) {
      await this.prisma.asSystem((tx) =>
        tx.job.upsert({
          where: { dedupeKey: `recurring:${job.name}` },
          create: {
            id: newId(),
            name: job.name,
            dedupeKey: `recurring:${job.name}`,
            intervalMs: job.intervalMs,
            runAt: new Date(),
          },
          // An interval change in code should win over the stored schedule.
          update: { intervalMs: job.intervalMs },
        }),
      );
    }

    if (!this.workerEnabled) {
      this.logger.log('Job queue enabled, worker disabled on this instance.');
      return;
    }

    this.timer = setInterval(() => void this.drain(), this.pollIntervalMs);
    // unref so a pending poll never holds the process open on shutdown.
    this.timer.unref?.();
    this.logger.log(
      `Job worker ${this.workerId} polling every ${this.pollIntervalMs}ms, batch ${this.batchSize}.`,
    );
    void this.drain();
  }

  /**
   * Claims and runs one batch. Public so tests can step the queue deterministically
   * instead of waiting on a timer.
   */
  async drain(): Promise<number> {
    if (this.draining || this.stopped) return 0;
    this.draining = true;

    try {
      await this.releaseStaleClaims();
      const claimed = await this.claim(this.batchSize);
      for (const job of claimed) {
        await this.run(job);
      }
      return claimed.length;
    } catch (error) {
      // A failed poll must never stop the loop; the next tick retries.
      this.logger.error(`Job poll failed: ${(error as Error).message}`);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Takes up to `limit` due jobs.
   *
   * The inner SELECT locks only the rows it returns and skips rows another
   * worker already holds, so two workers polling at the same instant get
   * disjoint sets rather than fighting over one.
   */
  private async claim(limit: number): Promise<ClaimedJob[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<Array<{ id: string; name: string; payload: JobPayload; attempts: number }>>(
        Prisma.sql`
          UPDATE jobs
             SET status = 'running',
                 locked_at = NOW(),
                 locked_by = ${this.workerId},
                 attempts = attempts + 1,
                 updated_at = NOW()
           WHERE id IN (
             SELECT id
               FROM jobs
              WHERE status = 'pending'
                AND run_at <= NOW()
              ORDER BY run_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
           )
          RETURNING id, name, payload, attempts
        `,
      ),
    );

    return rows.flatMap((row) => {
      if (isJobName(row.name)) {
        return [{ id: row.id, name: row.name, payload: row.payload ?? {}, attempts: row.attempts }];
      }
      // A name no longer in the codebase would otherwise be claimed and failed
      // on every poll forever.
      this.logger.error(`Unknown job "${row.name}" (${row.id}); dead-lettering.`);
      void this.deadLetter(row.id, `Unknown job "${row.name}".`);
      return [];
    });
  }

  private async run(job: ClaimedJob): Promise<void> {
    const processor = this.processors.get(job.name);
    if (!processor) {
      // Expected on an instance that runs the API but not this job's module.
      await this.reschedule(job, `No processor registered for "${job.name}".`);
      return;
    }

    try {
      await processor(job);
      await this.settleSuccess(job);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Job ${job.name} (${job.id}) failed: ${message}`);
      await this.reschedule(job, message);
    }
  }

  private async settleSuccess(job: ClaimedJob): Promise<void> {
    await this.prisma.asSystem(async (tx) => {
      const row = await tx.job.findUnique({
        where: { id: job.id },
        select: { intervalMs: true },
      });

      if (row?.intervalMs) {
        await tx.job.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            runAt: new Date(Date.now() + row.intervalMs),
            attempts: 0,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
        return;
      }

      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
    });
  }

  /**
   * Retries with exponential backoff, or gives up.
   *
   * A recurring job never dies: exhausting its attempts moves it to the next
   * scheduled run instead of dead-lettering it, because a schedule that stops
   * after three bad minutes is worse than one that keeps trying.
   */
  private async reschedule(job: ClaimedJob, error: string): Promise<void> {
    await this.prisma.asSystem(async (tx) => {
      const row = await tx.job.findUnique({
        where: { id: job.id },
        select: { intervalMs: true, attempts: true, maxAttempts: true },
      });
      if (!row) return;

      const exhausted = row.attempts >= row.maxAttempts;

      if (exhausted && row.intervalMs) {
        await tx.job.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            runAt: new Date(Date.now() + row.intervalMs),
            attempts: 0,
            lockedAt: null,
            lockedBy: null,
            lastError: error,
          },
        });
        return;
      }

      if (exhausted) {
        await tx.job.update({
          where: { id: job.id },
          data: { status: 'dead_lettered', lastError: error, lockedAt: null, lockedBy: null },
        });
        return;
      }

      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          runAt: new Date(Date.now() + backoffMs(row.attempts)),
          lastError: error,
          lockedAt: null,
          lockedBy: null,
        },
      });
    });
  }

  private async deadLetter(id: string, error: string): Promise<void> {
    await this.prisma
      .asSystem((tx) =>
        tx.job.update({ where: { id }, data: { status: 'dead_lettered', lastError: error } }),
      )
      .catch(() => undefined);
  }

  /**
   * Returns jobs whose worker died mid-run.
   *
   * Without this a crash strands the row in `running` forever. The timeout has
   * to exceed the slowest job, or a long-running job gets picked up a second
   * time while the first is still going.
   */
  private async releaseStaleClaims(): Promise<void> {
    const cutoff = new Date(Date.now() - this.claimTimeoutMs);
    const { count } = await this.prisma.asSystem((tx) =>
      tx.job.updateMany({
        where: { status: 'running', lockedAt: { lt: cutoff } },
        data: { status: 'pending', lockedAt: null, lockedBy: null },
      }),
    );

    if (count > 0) {
      this.logger.warn(`Released ${count} stale job claim(s) older than ${this.claimTimeoutMs}ms.`);
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}

/** 5s, 25s, 125s … capped, so a broken dependency is not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(5_000 * 5 ** Math.max(0, attempts - 1), 30 * 60_000);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
