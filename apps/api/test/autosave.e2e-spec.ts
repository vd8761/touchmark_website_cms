import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { PrismaService } from '../src/common/prisma.service';
import { createTenant, createTestApp, registerUser, type TestApp } from './helpers';

/**
 * Autosave version coalescing, against a real database.
 *
 * The editor saves after a few seconds of inactivity. Without coalescing that
 * is a version row every few seconds, and the 50-row retention would evict
 * every meaningful restore point within a couple of minutes of typing — the
 * feature meant to protect an author's work would quietly destroy their ability
 * to recover it. This suite exists to make sure that stays fixed.
 */
let ctx: TestApp;
let prisma: PrismaService;
let tenant: Awaited<ReturnType<typeof createTenant>>;

const path = () =>
  `/admin/v1/workspaces/${tenant.workspace.id}/content/entries/${tenant.entry.id}`;

async function patch(body: Record<string, unknown>) {
  const response = await request(ctx.app.getHttpServer())
    .patch(path())
    .set('Cookie', tenant.user.cookies)
    .send(body);

  if (response.status !== 200) {
    throw new Error(`PATCH failed ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as { current_version: number };
}

async function versions() {
  return prisma.asSystem((tx) =>
    tx.contentVersion.findMany({
      where: { entryId: tenant.entry.id },
      orderBy: { version: 'desc' },
    }),
  );
}

beforeAll(async () => {
  ctx = await createTestApp();
  prisma = ctx.prisma;
  tenant = await createTenant(ctx.app, 'autosave');
});

afterAll(async () => {
  await ctx.close();
});

describe('autosave version coalescing', () => {
  it('amends one snapshot across a burst of autosaves', async () => {
    const before = (await versions()).length;

    for (const title of ['One', 'One t', 'One tw', 'One two', 'One two three']) {
      await patch({ data: { title }, autosave: true });
    }

    const after = await versions();

    // Five saves, one restore point.
    expect(after.length).toBe(before + 1);
    // And it holds the newest content, not the first keystroke of the burst.
    expect((after[0].data as { title: string }).title).toBe('One two three');
  });

  it('moves the amended snapshot to the entry’s current version', async () => {
    const entry = await patch({ data: { title: 'Version tracking' }, autosave: true });
    const [latest] = await versions();

    // A restore has to land on the state the author last saw; leaving the row
    // pinned to an older number would make the history lie about what it holds.
    expect(latest.version).toBe(entry.current_version);
  });

  it('commits a separate restore point for an explicit save', async () => {
    const before = (await versions()).length;

    await patch({ data: { title: 'Autosaved' }, autosave: true });
    await patch({ data: { title: 'Deliberately saved' } });

    // The autosave amends; the explicit save adds. Pressing save is the author
    // saying "this is a point I might come back to".
    expect((await versions()).length).toBe(before + 1);
  });

  it('never amends a snapshot carrying a change note', async () => {
    await patch({ data: { title: 'Noted' }, change_note: 'Reviewed with legal' });
    const before = await versions();

    await patch({ data: { title: 'Typed after' }, autosave: true });
    const after = await versions();

    // Someone labelled that version deliberately; overwriting it would destroy
    // the one thing making it findable.
    expect(after.length).toBe(before.length + 1);
    const noted = after.find((version) => version.changeNote === 'Reviewed with legal');
    expect((noted?.data as { title: string }).title).toBe('Noted');
  });

  it('never amends a published snapshot', async () => {
    await request(ctx.app.getHttpServer())
      .post(`${path()}/publish`)
      .set('Cookie', tenant.user.cookies)
      .send({})
      .expect(200);

    const published = (await versions()).find((version) => version.wasPublished);
    expect(published).toBeDefined();

    await patch({ data: { title: 'Edited after publishing' }, autosave: true });

    const stillThere = (await versions()).find((version) => version.id === published!.id);
    // What went live must remain recoverable exactly as it was served.
    expect(stillThere).toBeDefined();
    expect(stillThere!.data).toEqual(published!.data);
  });

  it('starts a new snapshot for a different author', async () => {
    const other = await registerUser(ctx.app, 'autosave-other');

    // Joining normally means an invitation; the membership rows are what this
    // test needs, and going through the invite flow would only test that.
    await prisma.asSystem((tx) =>
      tx.organisationMember.create({
        data: {
          id: randomUUID(),
          organisationId: tenant.org.id,
          userId: other.id,
          role: 'member',
        },
      }),
    );

    await request(ctx.app.getHttpServer())
      .post(`/admin/v1/workspaces/${tenant.workspace.id}/members`)
      .set('Cookie', tenant.user.cookies)
      .send({ user_id: other.id, role: 'editor' })
      .expect(201);

    await patch({ data: { title: 'Mine' }, autosave: true });
    const before = await versions();

    await request(ctx.app.getHttpServer())
      .patch(path())
      .set('Cookie', other.cookies)
      .send({ data: { title: 'Theirs' }, autosave: true })
      .expect(200);

    // Amending across authors would attribute one person's writing to another
    // and lose the boundary between them.
    expect((await versions()).length).toBe(before.length + 1);
  });
});
