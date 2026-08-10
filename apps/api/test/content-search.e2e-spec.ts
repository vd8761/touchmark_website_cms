import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

/**
 * Full-text search, over a real Postgres with the GIN index in place.
 *
 * The behaviours worth pinning are the ones a substring match got wrong:
 * stemming, prefix matching while someone is still typing, ranking by relevance
 * rather than by date, and not falling over on punctuation.
 */
let ctx: TestApp;
let app: INestApplication;
let tenant: Awaited<ReturnType<typeof createTenant>>;

let ws: string;
let cookies: string[];
let typeApiId: string;
let searchKey: string;

const api = () => request(app.getHttpServer());

async function createEntry(title: string, body: string) {
  const entry = await api()
    .post(`/admin/v1/workspaces/${ws}/content/${typeApiId}`)
    .set('Cookie', cookies)
    .send({ data: { title } })
    .expect(201)
    .then((response) => response.body.data);

  // `body` goes in a second field so the ranking test can put the term in a
  // paragraph on one entry and in the title on another.
  await api()
    .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.id}`)
    .set('Cookie', cookies)
    .send({ data: { title, body }, expected_version: entry.current_version })
    .expect(200);

  return entry;
}

async function publish(entryId: string) {
  await api()
    .post(`/admin/v1/workspaces/${ws}/content/entries/${entryId}/publish`)
    .set('Cookie', cookies)
    .send({})
    .expect(200);
}

async function adminSearch(term: string): Promise<string[]> {
  const response = await api()
    .get(`/admin/v1/workspaces/${ws}/content/${typeApiId}`)
    .query({ search: term, limit: 50 })
    .set('Cookie', cookies)
    .expect(200);
  return response.body.data.map((entry: { id: string }) => entry.id);
}

async function deliverySearch(term: string): Promise<string[]> {
  const response = await api()
    .get('/v1/search')
    .query({ q: term, type: 'content' })
    .set('Authorization', `Bearer ${searchKey}`)
    .expect(200);
  return response.body.data.map((item: { data: { id: string } }) => item.data.id);
}

let cathedral: { id: string };
let mentions: { id: string };
let draft: { id: string };

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  tenant = await createTenant(app, 'search');
  ws = tenant.workspace.id;
  cookies = tenant.user.cookies;
  typeApiId = tenant.contentType.api_id;

  await api()
    .post(`/admin/v1/workspaces/${ws}/content-types/${tenant.contentType.id}/fields`)
    .set('Cookie', cookies)
    .send({ name: 'Body', type: 'long_text' })
    .expect(201);

  cathedral = await createEntry('Cathedrals of Ravenna', 'An architectural tour.');
  mentions = await createEntry('Holiday planning', 'We visited a cathedral on Tuesday.');
  draft = await createEntry('Cathedral restoration draft', 'Not published yet.');

  await publish(cathedral.id);
  await publish(mentions.id);

  searchKey = await api()
    .post(`/admin/v1/workspaces/${ws}/api-keys`)
    .set('Cookie', cookies)
    .send({ name: `Search key ${Date.now()}`, type: 'secret', scopes: ['search.read'] })
    .expect(201)
    .then((response) => response.body.data.key);
}, 90_000);

afterAll(async () => {
  await ctx?.close();
});

describe('content full-text search', () => {
  it('matches a word inside a field value, not just the slug', async () => {
    expect(await adminSearch('Ravenna')).toContain(cathedral.id);
  });

  it('stems, so a different word form still matches', async () => {
    // The entry says "Cathedrals"; the search says "cathedral".
    expect(await adminSearch('cathedral')).toContain(cathedral.id);
  });

  it('matches a prefix, so search-as-you-type works before the word is finished', async () => {
    expect(await adminSearch('cathe')).toContain(cathedral.id);
  });

  it('requires every word, rather than matching any of them', async () => {
    expect(await adminSearch('cathedrals ravenna')).toContain(cathedral.id);
    expect(await adminSearch('cathedrals reykjavik')).not.toContain(cathedral.id);
  });

  it('survives punctuation instead of returning a tsquery syntax error', async () => {
    // to_tsquery has a real grammar; these characters are operators in it, and
    // people type them into search boxes constantly.
    for (const term of ["it's", 'a & b', '!(nope', 'x | y', '--dash--']) {
      await api()
        .get(`/admin/v1/workspaces/${ws}/content/${typeApiId}`)
        .query({ search: term, limit: 5 })
        .set('Cookie', cookies)
        .expect(200);
    }
  });

  it('returns nothing when the query reduces to no searchable words', async () => {
    const response = await api()
      .get(`/admin/v1/workspaces/${ws}/content/${typeApiId}`)
      .query({ search: '!!!', limit: 5 })
      .set('Cookie', cookies)
      .expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.meta.total).toBe(0);
  });

  it('ranks a title match above a passing mention', async () => {
    // `mentions` was published later, so a date-ordered search would put it
    // first — which is exactly what the old substring implementation did.
    const results = await deliverySearch('cathedral');
    expect(results.indexOf(cathedral.id)).toBeLessThan(results.indexOf(mentions.id));
  });

  it('keeps unpublished entries out of Delivery search but in admin search', async () => {
    expect(await deliverySearch('restoration')).not.toContain(draft.id);
    expect(await adminSearch('restoration')).toContain(draft.id);
  });

  it('keeps the search vector in step with the row, without the app writing it', async () => {
    // The vector is a generated column, so nothing in the application updates
    // it. This asserts that editing an entry through the normal API is enough
    // for the old words to stop matching and the new ones to start.
    //
    // The edit is to the body rather than the title on purpose: the slug is
    // derived from the title and is itself part of the search document, so a
    // renamed title legitimately stays findable under its old name.
    const entry = await createEntry('Steady title', 'ephemeralword appears here');
    expect(await adminSearch('ephemeralword')).toContain(entry.id);

    await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Steady title', body: 'replacedword appears here' } })
      .expect(200);

    expect(await adminSearch('ephemeralword')).not.toContain(entry.id);
    expect(await adminSearch('replacedword')).toContain(entry.id);
  });
});
