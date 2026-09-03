import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../src/common/prisma.service';
import { JobQueueService } from '../src/jobs/job-queue.service';
import { PurgeService } from '../src/jobs/purge.service';
import { StorageService } from '../src/media/storage';
import { newId } from '../src/common/uuid';
import { createTenant, createTestApp, type TestApp } from './helpers';

/**
 * The purge job, against a real database and a real storage driver.
 *
 * Mocking either would defeat the point. The two properties worth proving are
 * that a cascade actually removes a site's whole graph, and that an object is
 * gone from storage and not merely dereferenced — neither of which a stubbed
 * Prisma client or a fake driver can tell you anything about.
 */
let ctx: TestApp;
let prisma: PrismaService;
let storage: StorageService;

/**
 * A purge whose clocks are short enough to test. Every retention window is
 * expressed in whole days or hours by config, so the fixtures are backdated
 * rather than the windows being shrunk below their real granularity.
 */
function buildPurge(): PurgeService {
  const jobs = new JobQueueService(prisma, new ConfigService({ NODE_ENV: 'test' }));
  return new PurgeService(
    prisma,
    storage,
    jobs,
    new ConfigService({
      NODE_ENV: 'test',
      PURGE_BATCH_SIZE: '100',
      MEDIA_PURGE_AFTER_DAYS: '30',
      ABANDONED_UPLOAD_AFTER_HOURS: '24',
      JOB_RETENTION_DAYS: '7',
      DEAD_LETTER_RETENTION_DAYS: '30',
      EXPIRED_SESSION_GRACE_DAYS: '7',
    }),
  );
}

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

beforeAll(async () => {
  ctx = await createTestApp();
  prisma = ctx.prisma;
  storage = ctx.app.get(StorageService);
});

afterAll(async () => {
  await ctx.close();
});

describe('purge-soft-deleted', () => {
  it('removes a site whose 30-day window has closed, with its content and its objects', async () => {
    const tenant = await createTenant(ctx.app, 'purge-due');

    // A real object under the site's prefix, so the assertion is about storage
    // and not only about rows.
    const key = StorageService.keyFor(tenant.workspace.id, tenant.asset.id, 'headline.png');
    await storage.local!.write(key, Readable.from([Buffer.from('not really a png')]));
    expect(await storage.head(key)).not.toBeNull();

    await prisma.asSystem((tx) =>
      tx.workspace.update({
        where: { id: tenant.workspace.id },
        data: { status: 'archived', deletedAt: ago(31 * DAY), purgeAfter: ago(DAY) },
      }),
    );

    const counts = await buildPurge().tick();
    expect(counts.workspaces).toBeGreaterThanOrEqual(1);

    const survivors = await prisma.asSystem((tx) =>
      tx.workspace.count({ where: { id: tenant.workspace.id } }),
    );
    expect(survivors).toBe(0);

    // The cascade is the load-bearing part: rows in workspace-scoped tables
    // must go with the site rather than being orphaned by a null foreign key.
    const entries = await prisma.asSystem((tx) =>
      tx.contentEntry.count({ where: { workspaceId: tenant.workspace.id } }),
    );
    const types = await prisma.asSystem((tx) =>
      tx.contentType.count({ where: { workspaceId: tenant.workspace.id } }),
    );
    expect(entries).toBe(0);
    expect(types).toBe(0);

    expect(await storage.head(key)).toBeNull();
  });

  it('leaves a site still inside its recovery window alone', async () => {
    const tenant = await createTenant(ctx.app, 'purge-pending');

    await prisma.asSystem((tx) =>
      tx.workspace.update({
        where: { id: tenant.workspace.id },
        data: { status: 'archived', deletedAt: new Date(), purgeAfter: new Date(Date.now() + DAY) },
      }),
    );

    await buildPurge().tick();

    // The whole point of the soft delete is that this is still restorable.
    const workspace = await prisma.asSystem((tx) =>
      tx.workspace.findUnique({ where: { id: tenant.workspace.id } }),
    );
    expect(workspace).not.toBeNull();
    expect(
      await prisma.asSystem((tx) =>
        tx.contentEntry.count({ where: { workspaceId: tenant.workspace.id } }),
      ),
    ).toBeGreaterThan(0);
  });

  it('deletes the object before the row for a soft-deleted asset, and keeps recent ones', async () => {
    const tenant = await createTenant(ctx.app, 'purge-media');

    const stale = await seedAsset(tenant.workspace.id, 'stale.png', {
      uploadedAt: ago(60 * DAY),
      deletedAt: ago(31 * DAY),
    });
    const recent = await seedAsset(tenant.workspace.id, 'recent.png', {
      uploadedAt: ago(2 * DAY),
      deletedAt: ago(DAY),
    });

    await buildPurge().tick();

    expect(await assetExists(stale.id)).toBe(false);
    expect(await storage.head(stale.key)).toBeNull();

    // Deleted yesterday: still inside the window, still restorable.
    expect(await assetExists(recent.id)).toBe(true);
    expect(await storage.head(recent.key)).not.toBeNull();
  });

  it('sweeps uploads that were reserved but never confirmed', async () => {
    const tenant = await createTenant(ctx.app, 'purge-abandoned');

    // uploadedAt null is exactly the state a client that walked away leaves.
    const abandoned = await seedAsset(tenant.workspace.id, 'abandoned.png', {
      uploadedAt: null,
      createdAt: ago(2 * DAY),
    });
    const inFlight = await seedAsset(tenant.workspace.id, 'in-flight.png', {
      uploadedAt: null,
      createdAt: new Date(),
    });

    await buildPurge().tick();

    expect(await assetExists(abandoned.id)).toBe(false);
    // A presign is valid for 15 minutes; deleting a row for an upload still in
    // progress would fail the client's `complete` call.
    expect(await assetExists(inFlight.id)).toBe(true);
  });

  it('prunes finished jobs but never pending ones, and keeps dead letters longer', async () => {
    const completed = await seedJob({ status: 'completed', completedAt: ago(8 * DAY) });
    const completedRecently = await seedJob({ status: 'completed', completedAt: ago(DAY) });
    const pending = await seedJob({ status: 'pending', runAt: ago(400 * DAY) });
    const deadRecent = await seedJob({ status: 'dead_lettered', updatedAt: ago(10 * DAY) });

    await buildPurge().tick();

    expect(await jobExists(completed)).toBe(false);
    expect(await jobExists(completedRecently)).toBe(true);
    // Age is not a reason to drop work that has not run yet.
    expect(await jobExists(pending)).toBe(true);
    // A dead letter is the only record that work was asked for and never
    // happened, so it has to outlive the incident that produced it.
    expect(await jobExists(deadRecent)).toBe(true);
  });

  it('never removes a webhook delivery that is still retrying', async () => {
    const tenant = await createTenant(ctx.app, 'purge-webhook');
    const endpoint = await prisma.asSystem((tx) =>
      tx.webhookEndpoint.create({
        data: {
          id: newId(),
          workspaceId: tenant.workspace.id,
          name: 'Retrying',
          url: 'https://example.test/hook',
          events: ['entry.published'],
          secretCiphertext: 'ciphertext-placeholder',
          secretLastFour: '0000',
        },
      }),
    );

    // Old, many attempts in, still pending: this is the retry queue, not a log
    // of one, and dropping it would silently cancel an undelivered event.
    const retrying = await prisma.asSystem((tx) =>
      tx.webhookDelivery.create({
        data: {
          id: newId(),
          workspaceId: tenant.workspace.id,
          webhookId: endpoint.id,
          eventId: newId(),
          eventType: 'entry.published',
          status: 'pending',
          attempt: 4,
          createdAt: ago(90 * DAY),
        },
      }),
    );

    const delivered = await prisma.asSystem((tx) =>
      tx.webhookDelivery.create({
        data: {
          id: newId(),
          workspaceId: tenant.workspace.id,
          webhookId: endpoint.id,
          eventId: newId(),
          eventType: 'entry.published',
          status: 'delivered',
          deliveredAt: ago(90 * DAY),
          createdAt: ago(90 * DAY),
        },
      }),
    );

    await buildPurge().tick();

    expect(
      await prisma.asSystem((tx) => tx.webhookDelivery.count({ where: { id: retrying.id } })),
    ).toBe(1);
    expect(
      await prisma.asSystem((tx) => tx.webhookDelivery.count({ where: { id: delivered.id } })),
    ).toBe(0);
  });

  it('keeps expired sessions long enough to still detect token reuse', async () => {
    const tenant = await createTenant(ctx.app, 'purge-session');

    const justExpired = await seedSession(tenant.user.id, ago(DAY));
    const longExpired = await seedSession(tenant.user.id, ago(30 * DAY));

    await buildPurge().tick();

    // A replayed token whose session row is gone is rejected, but silently —
    // the family-revocation theft signal of §6.1 is lost with the row.
    expect(
      await prisma.asSystem((tx) => tx.session.count({ where: { id: justExpired } })),
    ).toBe(1);
    expect(
      await prisma.asSystem((tx) => tx.session.count({ where: { id: longExpired } })),
    ).toBe(0);
  });
});

// -- fixtures ----------------------------------------------------------------

async function seedAsset(
  workspaceId: string,
  filename: string,
  timestamps: { uploadedAt?: Date | null; deletedAt?: Date | null; createdAt?: Date },
) {
  const id = newId();
  const key = StorageService.keyFor(workspaceId, id, filename);
  await storage.local!.write(key, Readable.from([Buffer.from(filename)]));

  await prisma.asSystem((tx) =>
    tx.mediaAsset.create({
      data: {
        id,
        workspaceId,
        filename,
        storageKey: key,
        mimeType: 'image/png',
        sizeBytes: BigInt(filename.length),
        ...timestamps,
      },
    }),
  );

  return { id, key };
}

async function assetExists(id: string): Promise<boolean> {
  const count = await prisma.asSystem((tx) => tx.mediaAsset.count({ where: { id } }));
  return count === 1;
}

async function seedJob(data: {
  status: 'completed' | 'pending' | 'dead_lettered';
  completedAt?: Date;
  updatedAt?: Date;
  runAt?: Date;
}): Promise<string> {
  const id = newId();
  await prisma.asSystem((tx) =>
    tx.job.create({ data: { id, name: 'purge-soft-deleted', ...data } }),
  );

  // `updatedAt` carries @updatedAt, so Prisma overwrites whatever create was
  // given; the dead-letter window is measured against it and has to be forced.
  if (data.updatedAt) {
    await prisma.asSystem((tx) =>
      tx.$executeRaw`UPDATE jobs SET updated_at = ${data.updatedAt} WHERE id = ${id}::uuid`,
    );
  }

  return id;
}

async function jobExists(id: string): Promise<boolean> {
  const count = await prisma.asSystem((tx) => tx.job.count({ where: { id } }));
  return count === 1;
}

async function seedSession(userId: string, expiresAt: Date): Promise<string> {
  const id = newId();
  await prisma.asSystem((tx) =>
    tx.session.create({
      data: {
        id,
        userId,
        refreshTokenHash: `hash-${id}`,
        familyId: newId(),
        expiresAt,
      },
    }),
  );
  return id;
}
