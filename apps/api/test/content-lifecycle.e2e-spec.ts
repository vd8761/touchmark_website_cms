/**
 * The Phase 1 exit criterion, exercised end to end: "a team can model and
 * publish real content" (§19).
 *
 * Focused on the rules that are expensive to get wrong — the schema-change
 * safety table of §7.1, the draft-versus-publish validation split, versioning
 * retention, and scheduling.
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/common/prisma.service';
import { SchedulerService } from '../src/content/scheduler.service';
import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

let ctx: TestApp;
let app: INestApplication;
let prisma: PrismaService;
let tenant: Awaited<ReturnType<typeof createTenant>>;

let ws: string;
let cookies: string[];

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  prisma = ctx.prisma;
  tenant = await createTenant(app, 'lifecycle');
  ws = tenant.workspace.id;
  cookies = tenant.user.cookies;
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const api = () => request(app.getHttpServer());

async function newType(name: string, body: Record<string, unknown> = {}) {
  const response = await api()
    .post(`/admin/v1/workspaces/${ws}/content-types`)
    .set('Cookie', cookies)
    .send({ name, ...body })
    .expect(201);
  return response.body.data;
}

async function addField(typeId: string, body: Record<string, unknown>) {
  const response = await api()
    .post(`/admin/v1/workspaces/${ws}/content-types/${typeId}/fields`)
    .set('Cookie', cookies)
    .send(body)
    .expect(201);
  return response.body.data;
}

// ---------------------------------------------------------------------------

describe('content type builder', () => {
  it('derives a snake_case api_id from the name', async () => {
    const type = await newType('Case Study');
    expect(type.api_id).toBe('case_study');
    expect(type.schema_version).toBe(1);
  });

  it('refuses to change a type api_id — it would break every consumer', async () => {
    const type = await newType('Immutable Type');

    const response = await api()
      .patch(`/admin/v1/workspaces/${ws}/content-types/${type.id}`)
      .set('Cookie', cookies)
      .send({ api_id: 'something_else' });

    // Rejected outright by validation, since api_id is not an updatable field.
    expect([400, 422]).toContain(response.status);

    const after = await api()
      .get(`/admin/v1/workspaces/${ws}/content-types/${type.id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(after.body.data.api_id).toBe('immutable_type');
  });

  it('rejects a duplicate api_id', async () => {
    await newType('Unique Thing');
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/content-types`)
      .set('Cookie', cookies)
      .send({ name: 'Unique Thing' });

    expect(response.status).toBe(409);
  });

  it('allows a safe field-type widening and refuses an unsafe one', async () => {
    const type = await newType('Widening');
    const field = await addField(type.id, { name: 'Body', type: 'text' });

    // §7.1: text → long_text is a safe widening.
    await api()
      .patch(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}`)
      .set('Cookie', cookies)
      .send({ type: 'long_text' })
      .expect(200);

    // long_text → number is not: existing values would become invalid.
    const bad = await api()
      .patch(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}`)
      .set('Cookie', cookies)
      .send({ type: 'number' });

    expect(bad.status).toBe(422);
    expect(bad.body.error.detail).toMatch(/invalid|widen/i);
  });

  it('marks existing entries incomplete when a required field is added', async () => {
    // §7.1: "Existing entries become 'incomplete' — flagged in the list,
    // blocked from re-publish until filled."
    const type = await newType('Late Requirement');
    await addField(type.id, { name: 'Title', type: 'text' });

    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Existing' } })
      .expect(201);
    expect(entry.body.data.is_incomplete).toBe(false);

    const field = await addField(type.id, { name: 'Summary', type: 'text', required: true });
    expect(field.entries_marked_incomplete).toBe(1);

    const after = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(after.body.data.is_incomplete).toBe(true);
  });

  it('reports field impact before deletion and requires deprecation first', async () => {
    const type = await newType('Impact Check');
    const field = await addField(type.id, { name: 'Subtitle', type: 'text' });

    await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.id}`)
      .set('Cookie', cookies)
      .send({ data: { subtitle: 'has a value' } })
      .expect(201);
    await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.id}`)
      .set('Cookie', cookies)
      .send({ data: {} })
      .expect(201);

    const impact = await api()
      .get(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}/impact`)
      .set('Cookie', cookies)
      .expect(200);

    expect(impact.body.data).toMatchObject({ entries_with_value: 1, entries_total: 2 });

    // Hard delete is refused until the field has been deprecated.
    const refused = await api()
      .delete(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}`)
      .set('Cookie', cookies);
    expect(refused.status).toBe(409);

    await api()
      .post(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}/deprecate`)
      .set('Cookie', cookies)
      .expect(200);

    await api()
      .delete(`/admin/v1/workspaces/${ws}/content-types/${type.id}/fields/${field.id}`)
      .set('Cookie', cookies)
      .expect(204);
  });

  it('blocks deleting a type with entries unless the name is typed', async () => {
    const type = await newType('Guarded Type');
    await addField(type.id, { name: 'Title', type: 'text' });
    await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'x' } })
      .expect(201);

    await api()
      .delete(`/admin/v1/workspaces/${ws}/content-types/${type.id}`)
      .set('Cookie', cookies)
      .send({})
      .expect(409);

    await api()
      .delete(`/admin/v1/workspaces/${ws}/content-types/${type.id}`)
      .set('Cookie', cookies)
      .send({ delete_entries: true, confirm_name: 'Wrong Name' })
      .expect(400);

    await api()
      .delete(`/admin/v1/workspaces/${ws}/content-types/${type.id}`)
      .set('Cookie', cookies)
      .send({ delete_entries: true, confirm_name: 'Guarded Type' })
      .expect(204);
  });
});

// ---------------------------------------------------------------------------

describe('entry lifecycle', () => {
  let typeId: string;

  beforeAll(async () => {
    const type = await newType('Article');
    typeId = type.id;
    await addField(typeId, { name: 'Title', type: 'text', required: true });
    await addField(typeId, { name: 'Body', type: 'rich_text' });
    await addField(typeId, { name: 'Read Time', type: 'number', validation: { min: 1 } });
  });

  it('saves an incomplete draft but refuses to publish it', async () => {
    // Drafts use relaxed validation so authors never lose work; publishing is
    // strict.
    const draft = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: {} })
      .expect(201);

    expect(draft.body.data.status).toBe('draft');

    const refused = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${draft.body.data.id}/publish`)
      .set('Cookie', cookies)
      .send({});

    expect(refused.status).toBe(422);
    expect(refused.body.error.fields[0]).toMatchObject({ field: 'title', code: 'required' });
  });

  it('publishes a complete entry and records the live version', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Ready to go', read_time: 4 } })
      .expect(201);

    const published = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}/publish`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    expect(published.body.data.status).toBe('published');
    expect(published.body.data.published_at).not.toBeNull();
    expect(published.body.data.published_version).toBe(published.body.data.current_version);
    expect(published.body.data.has_unpublished_changes).toBe(false);
  });

  it('flags unpublished changes after editing a published entry', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Live article' } })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}/publish`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    const edited = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Live article, revised' } })
      .expect(200);

    // The live version is unchanged; the working copy has moved ahead.
    expect(edited.body.data.has_unpublished_changes).toBe(true);
    expect(edited.body.data.status).toBe('published');
  });

  it('merges partial updates instead of replacing the whole document', async () => {
    // The editor sends only the fields it rendered; a collapsed group must not
    // be wiped by saving.
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Keeps its body', read_time: 7 } })
      .expect(201);

    const updated = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Renamed' } })
      .expect(200);

    expect(updated.body.data.data).toMatchObject({ title: 'Renamed', read_time: 7 });
  });

  it('rejects a concurrent overwrite when expected_version is supplied', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Contested' } })
      .expect(201);

    const id = entry.body.data.id;
    const staleVersion = entry.body.data.current_version;

    await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'First writer wins' } })
      .expect(200);

    const conflict = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Second writer' }, expected_version: staleVersion });

    expect(conflict.status).toBe(409);

    const current = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(current.body.data.data.title).toBe('First writer wins');
  });

  it('validates field rules and reports every failure at once', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Valid' } })
      .expect(201);

    const response = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { read_time: 0, body: 'not a document' } });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.map((f: { field: string }) => f.field).sort()).toEqual([
      'body',
      'read_time',
    ]);
  });

  it('keeps a version per save and can restore one', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Version one' } })
      .expect(201);

    const id = entry.body.data.id;

    await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Version two' }, change_note: 'Retitled' })
      .expect(200);

    const versions = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${id}/versions`)
      .set('Cookie', cookies)
      .expect(200);

    expect(versions.body.data.length).toBeGreaterThanOrEqual(2);

    const restored = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${id}/versions/restore`)
      .set('Cookie', cookies)
      .send({ version: 1 })
      .expect(200);

    expect(restored.body.data.data.title).toBe('Version one');
    // Restoring appends rather than rewinding, so history stays append-only.
    expect(restored.body.data.current_version).toBeGreaterThan(2);
  });

  it('never prunes a version that was published', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Published then edited a lot' } })
      .expect(201);

    const id = entry.body.data.id;
    await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${id}/publish`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    const publishedVersion = 1;

    // Push well past the 50-version retention window.
    for (let i = 0; i < 55; i++) {
      await api()
        .patch(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
        .set('Cookie', cookies)
        .send({ data: { title: `Edit ${i}` } })
        .expect(200);
    }

    const survived = await prisma.asSystem((tx) =>
      tx.contentVersion.count({ where: { entryId: id, version: publishedVersion } }),
    );
    expect(survived).toBe(1);

    const total = await prisma.asSystem((tx) => tx.contentVersion.count({ where: { entryId: id } }));
    expect(total).toBeLessThanOrEqual(52);
  }, 60_000);

  it('refuses a publish time in the past', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Backdated' } })
      .expect(201);

    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}/publish`)
      .set('Cookie', cookies)
      .send({ scheduled_at: new Date(Date.now() - 60_000).toISOString() });

    expect(response.status).toBe(400);
  });

  it('publishes scheduled entries when the scheduler runs', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Goes live later' } })
      .expect(201);

    const id = entry.body.data.id;
    const when = new Date(Date.now() + 60_000);

    const scheduled = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${id}/publish`)
      .set('Cookie', cookies)
      .send({ scheduled_at: when.toISOString() })
      .expect(200);

    expect(scheduled.body.data.status).toBe('scheduled');

    // Not yet due — the sweep must leave it alone.
    const scheduler = app.get(SchedulerService);
    await scheduler.tick(new Date(Date.now() - 1000));

    let current = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(current.body.data.status).toBe('scheduled');

    // Now due.
    const result = await scheduler.tick(new Date(Date.now() + 120_000));
    expect(result.published).toBeGreaterThanOrEqual(1);

    current = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(current.body.data.status).toBe('published');
  });

  it('unpublishes entries whose expiry has passed', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Expires' } })
      .expect(201);

    const id = entry.body.data.id;
    await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${id}/publish`)
      .set('Cookie', cookies)
      .send({ unpublish_at: new Date(Date.now() + 30_000).toISOString() })
      .expect(200);

    await app.get(SchedulerService).tick(new Date(Date.now() + 60_000));

    const current = await api()
      .get(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .expect(200);
    expect(current.body.data.status).toBe('draft');
  });

  it('generates unique slugs within a type and locale', async () => {
    const first = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ slug: 'shared-slug', data: { title: 'One' } })
      .expect(201);

    const second = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ slug: 'shared-slug', data: { title: 'Two' } })
      .expect(201);

    expect(first.body.data.slug).toBe('shared-slug');
    expect(second.body.data.slug).toBe('shared-slug-1');
  });

  it('allows exactly one entry for a single content type', async () => {
    const single = await newType('Homepage', { kind: 'single' });
    await addField(single.id, { name: 'Headline', type: 'text' });

    await api()
      .post(`/admin/v1/workspaces/${ws}/content/${single.id}`)
      .set('Cookie', cookies)
      .send({ data: { headline: 'Welcome' } })
      .expect(201);

    const second = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${single.id}`)
      .set('Cookie', cookies)
      .send({ data: { headline: 'Another' } });

    expect(second.status).toBe(409);
  });
});

describe('slug derivation', () => {
  let typeId: string;

  beforeAll(async () => {
    const type = await newType('Slugged');
    typeId = type.id;
    await addField(typeId, { name: 'Title', type: 'text', required: true });
  });

  it('derives the slug from the title once an empty draft is filled in', async () => {
    // The "New entry" button creates an empty draft, which has no title to
    // derive from yet. Without re-deriving, every entry would be untitled,
    // untitled-1, untitled-2…
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: {} })
      .expect(201);

    expect(entry.body.data.slug).toBe('untitled');

    const named = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Designing a Multi-Site CMS' } })
      .expect(200);

    expect(named.body.data.slug).toBe('designing-a-multi-site-cms');
  });

  it('never changes the slug of an entry that has been published', async () => {
    // A live URL must not move underneath the site serving it (§17.5).
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ slug: 'stable-url', data: { title: 'Original' } })
      .expect(201);

    const id = entry.body.data.id;
    await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${id}/publish`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    const renamed = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Completely Different Title' } })
      .expect(200);

    expect(renamed.body.data.slug).toBe('stable-url');
  });

  it('leaves a deliberately chosen slug alone', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ slug: 'chosen-by-hand', data: {} })
      .expect(201);

    const updated = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Some Title' } })
      .expect(200);

    expect(updated.body.data.slug).toBe('chosen-by-hand');
  });

  it('still honours an explicit slug change', async () => {
    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${typeId}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Renameable' } })
      .expect(201);

    const updated = await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ slug: 'explicitly-set' })
      .expect(200);

    expect(updated.body.data.slug).toBe('explicitly-set');
  });
});
