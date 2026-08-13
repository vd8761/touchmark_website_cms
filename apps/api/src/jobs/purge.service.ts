import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { StorageService } from '../media/storage';
import { JOB_NAMES } from './job-names';
import { JobQueueService } from './job-queue.service';

/**
 * The `purge-soft-deleted` job of spec §4.6 and §11.6.
 *
 * Every soft delete in this system writes a tombstone and stops there. That is
 * the right shape — it makes deletion reversible and keeps foreign keys intact
 * — but nothing was ever removing the tombstones, so the database and the
 * object store grew without bound and a site "deleted" two years ago still had
 * every row and every byte of its media on disk. For a platform holding other
 * people's content, that is a retention problem as much as a cost one.
 *
 * Two rules shape the implementation:
 *
 * **Storage first, row second.** Deleting the row first and then failing to
 * delete the object leaves an orphan nothing points at, which no later run can
 * find. Losing the object and keeping the row is recoverable: the next run
 * retries, and a missing object deletes as a no-op on both drivers.
 *
 * **Everything is batched.** The first run on an existing database may face
 * years of accumulation. Each category takes at most `PURGE_BATCH_SIZE` rows
 * per run, so the job is a series of short transactions rather than one that
 * holds locks for minutes and times out.
 */
@Injectable()
export class PurgeService implements OnModuleInit {
  private readonly logger = new Logger(PurgeService.name);
  private running = false;

  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly mediaRetentionMs: number;
  private readonly abandonedUploadMs: number;
  private readonly completedJobRetentionMs: number;
  private readonly deadLetteredJobRetentionMs: number;
  private readonly requestLogRetentionMs: number;
  private readonly webhookDeliveryRetentionMs: number;
  private readonly expiredTokenGraceMs: number;
  private readonly expiredSessionGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: JobQueueService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = positiveInt(config.get('PURGE_BATCH_SIZE'), 500);
    this.intervalMs = positiveInt(config.get('PURGE_INTERVAL_MS'), 60 * 60_000);
    this.mediaRetentionMs = days(config.get('MEDIA_PURGE_AFTER_DAYS'), 30);
    this.abandonedUploadMs = hours(config.get('ABANDONED_UPLOAD_AFTER_HOURS'), 24);
    this.completedJobRetentionMs = days(config.get('JOB_RETENTION_DAYS'), 7);
    this.deadLetteredJobRetentionMs = days(config.get('DEAD_LETTER_RETENTION_DAYS'), 30);
    this.requestLogRetentionMs = days(config.get('API_REQUEST_LOG_RETENTION_DAYS'), 30);
    this.webhookDeliveryRetentionMs = days(config.get('WEBHOOK_DELIVERY_RETENTION_DAYS'), 30);
    this.expiredTokenGraceMs = days(config.get('EXPIRED_TOKEN_GRACE_DAYS'), 1);
    this.expiredSessionGraceMs = days(config.get('EXPIRED_SESSION_GRACE_DAYS'), 7);
  }

  onModuleInit(): void {
    if (this.config.get('NODE_ENV') === 'test' || this.config.get('DISABLE_PURGE') === 'true') {
      this.logger.log('Purge disabled.');
      return;
    }
    if (!this.jobs.isEnabled()) {
      this.logger.log('Purge disabled because the job queue is disabled.');
      return;
    }

    this.jobs.registerRecurring(JOB_NAMES.purgeSoftDeleted, this.intervalMs, async () => {
      await this.tick();
    });
    this.logger.log(`Purge registered, every ${this.intervalMs}ms.`);
  }

  /**
   * Runs one pass. Public so tests and an operator can step it directly rather
   * than waiting an hour for the schedule.
   */
  async tick(now = new Date()): Promise<PurgeCounts> {
    const counts = emptyCounts();

    // A pass that outlives its interval must not start a second copy of itself
    // and double the delete load on the database.
    if (this.running) return counts;
    this.running = true;

    try {
      counts.workspaces = await this.purgeWorkspaces(now);
      counts.mediaAssets = await this.purgeDeletedMedia(now);
      counts.abandonedUploads = await this.purgeAbandonedUploads(now);
      counts.requestLogs = await this.purgeRequestLogs(now);
      counts.webhookDeliveries = await this.purgeWebhookDeliveries(now);
      counts.jobs = await this.purgeJobs(now);
      counts.sessions = await this.purgeExpiredSessions(now);
      counts.tokens = await this.purgeExpiredTokens(now);

      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      if (total > 0) this.logger.log(`Purged ${summarise(counts)}.`);

      return counts;
    } catch (error) {
      // The queue retries; one bad pass must not stop future ones. Returning
      // the partial counts is deliberate — the categories that ran before the
      // failure really did delete those rows.
      this.logger.error(`Purge tick failed: ${(error as Error).message}`);
      return counts;
    } finally {
      this.running = false;
    }
  }

  // -- Sites ------------------------------------------------------------------

  /**
   * Removes sites whose 30-day window has closed (§6.3).
   *
   * The row is deleted rather than anonymised, and every workspace-scoped table
   * cascades from it, so this is the one purge that removes a large graph at
   * once. The audit rows for the site go with it: they are scoped to the
   * workspace, and §6.3 describes the purge as removing the site's data. Org-
   * level audit entries — including the `workspace.deletion_scheduled` record
   * of who asked for this and when — have a null `workspace_id` and survive.
   */
  private async purgeWorkspaces(now: Date): Promise<number> {
    const due = await this.prisma.asSystem((tx) =>
      tx.workspace.findMany({
        where: { purgeAfter: { not: null, lte: now } },
        select: { id: true, name: true, organisationId: true },
        take: this.batchSize,
      }),
    );

    let purged = 0;

    for (const workspace of due) {
      try {
        const objects = await this.storage.deletePrefix(
          StorageService.workspacePrefix(workspace.id),
        );
        await this.prisma.asSystem((tx) => tx.workspace.delete({ where: { id: workspace.id } }));

        this.logger.warn(
          `Purged site "${workspace.name}" (${workspace.id}) and ${objects} stored object(s).`,
        );
        purged += 1;
      } catch (error) {
        // One unreachable bucket or one constraint violation must not strand
        // the rest of the batch; this site is simply still due next hour.
        this.logger.error(
          `Failed to purge site ${workspace.id}: ${(error as Error).message}`,
        );
      }
    }

    return purged;
  }

  // -- Media ------------------------------------------------------------------

  /** Soft-deleted assets, once the recovery window has passed. */
  private async purgeDeletedMedia(now: Date): Promise<number> {
    return this.purgeAssets({
      deletedAt: { not: null, lte: new Date(now.getTime() - this.mediaRetentionMs) },
    });
  }

  /**
   * Rows whose upload was presigned but never confirmed.
   *
   * `uploaded_at` is null until the client calls `complete`, so an abandoned
   * upload leaves a row pointing at either nothing or a half-written object.
   * The cutoff has to comfortably exceed the 15-minute presign TTL, or a slow
   * upload still in flight gets its row deleted underneath it.
   */
  private async purgeAbandonedUploads(now: Date): Promise<number> {
    return this.purgeAssets({
      uploadedAt: null,
      deletedAt: null,
      createdAt: { lte: new Date(now.getTime() - this.abandonedUploadMs) },
    });
  }

  private async purgeAssets(where: Prisma.MediaAssetWhereInput): Promise<number> {
    const assets = await this.prisma.asSystem((tx) =>
      tx.mediaAsset.findMany({
        where,
        select: { id: true, storageKey: true },
        take: this.batchSize,
      }),
    );
    if (assets.length === 0) return 0;

    // Storage first: an object outliving its row can never be found again,
    // whereas a row outliving its object is retried on the next pass.
    const removed: string[] = [];
    for (const asset of assets) {
      try {
        await this.storage.delete(asset.storageKey);
        removed.push(asset.id);
      } catch (error) {
        this.logger.error(
          `Failed to delete object ${asset.storageKey}: ${(error as Error).message}`,
        );
      }
    }
    if (removed.length === 0) return 0;

    const { count } = await this.prisma.asSystem((tx) =>
      tx.mediaAsset.deleteMany({ where: { id: { in: removed } } }),
    );
    return count;
  }

  // -- Log and delivery retention ---------------------------------------------

  /**
   * §5.6 request-log retention. These are the highest-volume rows in the
   * system — one per Delivery API request — and nothing else prunes them.
   */
  private async purgeRequestLogs(now: Date): Promise<number> {
    return this.deleteBatch('api_request_logs', 'occurred_at', this.requestLogRetentionMs, now);
  }

  /**
   * Settled webhook deliveries, which carry a full request and response body
   * each and are therefore the widest rows the platform accumulates.
   *
   * `pending` is the retry queue rather than a record of one — a delivery on
   * its fifth backoff is still pending — so no pending row is ever removed,
   * whatever its age. `dead_lettered` rows are kept for the longer dead-letter
   * window, because they are a customer's evidence that an event never arrived.
   * That leaves `delivered` as the only status this prunes on the short clock.
   */
  private async purgeWebhookDeliveries(now: Date): Promise<number> {
    const ids = await this.prisma.asSystem((tx) =>
      tx.webhookDelivery.findMany({
        where: {
          OR: [
            {
              status: 'delivered',
              createdAt: { lte: new Date(now.getTime() - this.webhookDeliveryRetentionMs) },
            },
            {
              status: 'dead_lettered',
              createdAt: { lte: new Date(now.getTime() - this.deadLetteredJobRetentionMs) },
            },
          ],
        },
        select: { id: true },
        take: this.batchSize,
      }),
    );
    if (ids.length === 0) return 0;

    const { count } = await this.prisma.asSystem((tx) =>
      tx.webhookDelivery.deleteMany({ where: { id: { in: ids.map((row) => row.id) } } }),
    );
    return count;
  }

  /**
   * Finished job rows.
   *
   * Dead-lettered rows are kept far longer than completed ones, and never
   * deleted quickly: a dead letter is the only record that a piece of work was
   * asked for and never happened, so it has to outlive the incident that caused
   * it. Pending and running rows are never touched.
   */
  private async purgeJobs(now: Date): Promise<number> {
    const completed = await this.prisma.asSystem((tx) =>
      tx.job.findMany({
        where: {
          status: 'completed',
          completedAt: { lte: new Date(now.getTime() - this.completedJobRetentionMs) },
        },
        select: { id: true },
        take: this.batchSize,
      }),
    );

    const dead = await this.prisma.asSystem((tx) =>
      tx.job.findMany({
        where: {
          status: 'dead_lettered',
          updatedAt: { lte: new Date(now.getTime() - this.deadLetteredJobRetentionMs) },
        },
        select: { id: true },
        take: this.batchSize,
      }),
    );

    const ids = [...completed, ...dead].map((row) => row.id);
    if (ids.length === 0) return 0;

    const { count } = await this.prisma.asSystem((tx) =>
      tx.job.deleteMany({ where: { id: { in: ids } } }),
    );
    return count;
  }

  // -- Credentials -------------------------------------------------------------

  /**
   * Expired and revoked sessions.
   *
   * The grace period matters: `TokenService` treats a revoked session as proof
   * of refresh-token theft and kills the whole family on reuse (§6.1). Deleting
   * the row the moment it expires would turn a replayed stolen token from
   * "detected, family revoked" into "unknown token, rejected quietly" — the
   * rejection is the same, but the theft signal is lost. Keeping the rows for a
   * week preserves that signal well past any legitimate token's lifetime.
   */
  private async purgeExpiredSessions(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.expiredSessionGraceMs);

    const ids = await this.prisma.asSystem((tx) =>
      tx.session.findMany({
        where: { expiresAt: { lte: cutoff } },
        select: { id: true },
        take: this.batchSize,
      }),
    );
    if (ids.length === 0) return 0;

    const { count } = await this.prisma.asSystem((tx) =>
      tx.session.deleteMany({ where: { id: { in: ids.map((row) => row.id) } } }),
    );
    return count;
  }

  /** Spent and expired single-use tokens: email verification, reset, preview. */
  private async purgeExpiredTokens(now: Date): Promise<number> {
    const emails = await this.deleteBatch(
      'email_tokens',
      'expires_at',
      this.expiredTokenGraceMs,
      now,
    );
    const previews = await this.deleteBatch(
      'preview_tokens',
      'expires_at',
      this.expiredTokenGraceMs,
      now,
    );
    return emails + previews;
  }

  // -- helpers -----------------------------------------------------------------

  /**
   * Deletes up to one batch of rows older than a cutoff.
   *
   * Raw SQL because Prisma's `deleteMany` has no `LIMIT`, and the alternative —
   * selecting ids and deleting by `IN` — costs a second round trip and a
   * parameter list per row for tables that may hold millions. `ctid` is the
   * physical row address, which makes the delete a direct fetch rather than a
   * second index lookup.
   *
   * The table and column names are compile-time literals from this file only;
   * no caller-supplied value ever reaches the statement.
   */
  private async deleteBatch(
    table: 'api_request_logs' | 'email_tokens' | 'preview_tokens',
    timestampColumn: 'occurred_at' | 'expires_at',
    retentionMs: number,
    now: Date,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionMs);

    return this.prisma.asSystem((tx) =>
      tx.$executeRaw(
        Prisma.sql`
          DELETE FROM ${Prisma.raw(`"${table}"`)}
           WHERE ctid IN (
             SELECT ctid
               FROM ${Prisma.raw(`"${table}"`)}
              WHERE ${Prisma.raw(`"${timestampColumn}"`)} <= ${cutoff}
              LIMIT ${this.batchSize}
           )
        `,
      ),
    );
  }
}

export interface PurgeCounts {
  workspaces: number;
  mediaAssets: number;
  abandonedUploads: number;
  requestLogs: number;
  webhookDeliveries: number;
  jobs: number;
  sessions: number;
  tokens: number;
}

function emptyCounts(): PurgeCounts {
  return {
    workspaces: 0,
    mediaAssets: 0,
    abandonedUploads: 0,
    requestLogs: 0,
    webhookDeliveries: 0,
    jobs: 0,
    sessions: 0,
    tokens: 0,
  };
}

function summarise(counts: PurgeCounts): string {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${value} ${key}`)
    .join(', ');
}

function positiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function days(raw: unknown, fallback: number): number {
  return positiveInt(raw, fallback) * 24 * 60 * 60_000;
}

function hours(raw: unknown, fallback: number): number {
  return positiveInt(raw, fallback) * 60 * 60_000;
}
