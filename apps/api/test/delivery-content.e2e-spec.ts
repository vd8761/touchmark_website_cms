import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { newId } from '../src/common/uuid';
import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

let ctx: TestApp;
let app: INestApplication;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;

let ws: string;
let cookies: string[];
let keyCounter = 0;

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  tenant = await createTenant(app, 'delivery');
  other = await createTenant(app, 'delivery-other');
  ws = tenant.workspace.id;
  cookies = tenant.user.cookies;

  await api()
    .post(`/admin/v1/workspaces/${ws}/content/entries/${tenant.entry.id}/publish`)
    .set('Cookie', cookies)
    .send({})
    .expect(200);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const api = () => request(app.getHttpServer());

/** A real 1x1 PNG, so Delivery media tests go through the completed-upload path. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function createDeliveryKey(scopes: string[] = ['content.read']) {
  return api()
    .post(`/admin/v1/workspaces/${ws}/api-keys`)
    .set('Cookie', cookies)
    .send({ name: `Delivery key ${Date.now()} ${keyCounter++}`, type: 'secret', scopes })
    .expect(201)
    .then((response) => response.body.data);
}

async function uploadMedia(bytes: Buffer, filename: string, mimeType: string) {
  const reserved = await api()
    .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
    .set('Cookie', cookies)
    .send({ filename, mime_type: mimeType, size_bytes: bytes.length })
    .expect(201);

  const { asset_id: assetId, upload_url: uploadUrl } = reserved.body.data;
  const path = uploadUrl.replace(/^https?:\/\/[^/]+/, '');

  await api().put(path).set('Content-Type', mimeType).send(bytes).expect(200);

  return api()
    .post(`/admin/v1/workspaces/${ws}/media/${assetId}/complete`)
    .set('Cookie', cookies)
    .expect(200)
    .then((response) => response.body.data);
}

describe('Delivery content API', () => {
  it('lists and fetches content type schemas with cache headers', async () => {
    const key = await createDeliveryKey();

    const list = await api()
      .get('/v1/content-types')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(list.headers['cache-control']).toContain('max-age=60');
    expect(list.headers.etag).toMatch(/^W\//);
    expect(list.body.data.map((type: { api_id: string }) => type.api_id)).toContain(
      tenant.contentType.api_id,
    );

    const schema = await api()
      .get(`/v1/content-types/${tenant.contentType.api_id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(schema.body.data).toMatchObject({
      id: tenant.contentType.id,
      api_id: tenant.contentType.api_id,
      schema_version: 2,
    });
    expect(schema.body.data.fields[0]).toMatchObject({ api_id: 'title', type: 'text' });
  });

  it('serves only published entries for a content type and slug', async () => {
    const key = await createDeliveryKey();
    const draft = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${tenant.contentType.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Not public yet' } })
      .expect(201)
      .then((response) => response.body.data);

    const list = await api()
      .get(`/v1/content/${tenant.contentType.api_id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(list.body.data.map((entry: { id: string }) => entry.id)).toContain(tenant.entry.id);
    expect(list.body.data.map((entry: { id: string }) => entry.id)).not.toContain(draft.id);
    expect(list.body.meta.total).toBe(1);

    const fetched = await api()
      .get(`/v1/content/${tenant.contentType.api_id}/${tenant.entry.slug}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(fetched.body.data).toMatchObject({
      id: tenant.entry.id,
      type: tenant.contentType.api_id,
      slug: tenant.entry.slug,
      data: { title: 'delivery secret headline' },
    });
    expect(fetched.body.data.status).toBeUndefined();

    await api()
      .get(`/v1/content/${tenant.contentType.api_id}/${draft.slug}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(404)
      .expect((response) => {
        expect(response.body.error.code).toBe('resource_not_found');
      });
  });

  it('fetches published entries by ID and lists entries related by shared taxonomy terms', async () => {
    const key = await createDeliveryKey();
    const related = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${tenant.contentType.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Related delivery headline' } })
      .expect(201)
      .then((response) => response.body.data);
    const draft = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${tenant.contentType.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Draft but tagged' } })
      .expect(201)
      .then((response) => response.body.data);

    await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${related.id}/publish`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    await ctx.prisma.asSystem((tx) =>
      tx.entryTerm.createMany({
        data: [
          { workspaceId: ws, entryId: tenant.entry.id, termId: tenant.term.id },
          { workspaceId: ws, entryId: related.id, termId: tenant.term.id },
          { workspaceId: ws, entryId: draft.id, termId: tenant.term.id },
        ],
        skipDuplicates: true,
      }),
    );

    const byId = await api()
      .get(`/v1/content/id/${tenant.entry.id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(byId.body.data).toMatchObject({
      id: tenant.entry.id,
      type: tenant.contentType.api_id,
      slug: tenant.entry.slug,
    });

    const response = await api()
      .get(`/v1/content/${tenant.contentType.api_id}/${tenant.entry.slug}/related?limit=5`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    const ids = response.body.data.map((entry: { id: string }) => entry.id);
    expect(ids).toContain(related.id);
    expect(ids).not.toContain(tenant.entry.id);
    expect(ids).not.toContain(draft.id);
    expect(response.body.meta.source_id).toBe(tenant.entry.id);
  });

  it('does not let one workspace key read another workspace content type', async () => {
    const key = await createDeliveryKey();

    await api()
      .get(`/v1/content-types/${other.contentType.api_id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(404)
      .expect((response) => {
        const body = JSON.stringify(response.body);
        expect(body).not.toContain(other.workspace.name);
      });
  });

  it('supports search, field selection, data filters and locale fallback', async () => {
    const contentKey = await createDeliveryKey(['content.read']);
    const searchKey = await createDeliveryKey(['search.read']);

    const search = await api()
      .get('/v1/search')
      .query({ q: 'secret headline', type: 'content' })
      .set('Authorization', `Bearer ${searchKey.key}`)
      .expect(200);

    expect(search.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'content',
          data: expect.objectContaining({ id: tenant.entry.id }),
        }),
      ]),
    );

    const filtered = await api()
      .get(`/v1/content/${tenant.contentType.api_id}`)
      .query({
        fields: 'id,data.title',
        'filter[data.title]': 'delivery secret headline',
      })
      .set('Authorization', `Bearer ${contentKey.key}`)
      .expect(200);

    expect(filtered.body.data).toEqual([
      { id: tenant.entry.id, data: { title: 'delivery secret headline' } },
    ]);
    expect(filtered.body.data[0].seo).toBeUndefined();

    const fallback = await api()
      .get(`/v1/content/${tenant.contentType.api_id}/${tenant.entry.slug}`)
      .query({ locale: 'fr' })
      .set('Authorization', `Bearer ${contentKey.key}`)
      .expect(200);

    expect(fallback.body.data).toMatchObject({ id: tenant.entry.id, locale: 'en' });

    await api()
      .get(`/v1/content/${tenant.contentType.api_id}/${tenant.entry.slug}`)
      .query({ locale: 'fr', locale_fallback: 'false' })
      .set('Authorization', `Bearer ${contentKey.key}`)
      .expect(404);
  });

  it('serves taxonomies and hierarchical terms', async () => {
    const key = await createDeliveryKey();

    const taxonomies = await api()
      .get('/v1/taxonomies')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(taxonomies.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tenant.taxonomy.id,
          api_id: tenant.taxonomy.api_id,
          is_hierarchical: true,
        }),
      ]),
    );

    const terms = await api()
      .get(`/v1/taxonomies/${tenant.taxonomy.api_id}/terms`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(terms.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tenant.term.id,
          slug: tenant.term.slug,
          children: [],
        }),
      ]),
    );
  });

  it('serves menus as visible resolved trees', async () => {
    const key = await createDeliveryKey();

    await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${tenant.menu.id}/items`)
      .set('Cookie', cookies)
      .send({
        items: [
          { label: 'Blog', link_type: 'entry', entry_id: tenant.entry.id },
          { label: 'Topic', link_type: 'term', term_id: tenant.term.id },
          { label: 'External', link_type: 'url', url: 'https://example.com' },
          { label: 'Hidden', link_type: 'url', url: 'https://example.com/private', visible: false },
        ],
      })
      .expect(200);

    const menus = await api()
      .get('/v1/menus')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(menus.body.data.map((menu: { api_id: string }) => menu.api_id)).toContain(
      tenant.menu.api_id,
    );

    const menu = await api()
      .get(`/v1/menus/${tenant.menu.api_id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    const labels = menu.body.data.items.map((item: { label: string }) => item.label);
    expect(labels).toEqual(['Blog', 'Topic', 'External']);

    const blog = menu.body.data.items.find((item: { label: string }) => item.label === 'Blog');
    expect(blog).toMatchObject({
      link_type: 'entry',
      entry_id: tenant.entry.id,
      resolved_url: `/${tenant.contentType.api_id}/${tenant.entry.slug}`,
      entry: { id: tenant.entry.id, type: tenant.contentType.api_id, slug: tenant.entry.slug },
    });

    const topic = menu.body.data.items.find((item: { label: string }) => item.label === 'Topic');
    expect(topic).toMatchObject({
      link_type: 'term',
      term_id: tenant.term.id,
      resolved_url: `/${tenant.taxonomy.api_id}/${tenant.term.slug}`,
      term: { id: tenant.term.id, taxonomy: tenant.taxonomy.api_id, slug: tenant.term.slug },
    });
  });

  it('serves completed media assets and hides abandoned reservations', async () => {
    const key = await createDeliveryKey(['media.read']);
    const asset = await uploadMedia(PNG, 'delivery-pixel.png', 'image/png');

    const list = await api()
      .get('/v1/media?type=image/&limit=5')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    const ids = list.body.data.map((item: { id: string }) => item.id);
    expect(ids).toContain(asset.id);
    expect(ids).not.toContain(tenant.asset.id);

    const fetched = await api()
      .get(`/v1/media/${asset.id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(fetched.body.data).toMatchObject({
      id: asset.id,
      filename: 'delivery-pixel.png',
      mime_type: 'image/png',
      width: 1,
      height: 1,
      size_bytes: PNG.length,
    });
    expect(fetched.body.data.url).toContain('/uploads/local/');
  });

  it('writes subscribers, lists and form submissions through Delivery endpoints', async () => {
    const listId = newId();
    await ctx.prisma.asSystem((tx) =>
      tx.audienceList.create({
        data: {
          id: listId,
          workspaceId: ws,
          name: 'Newsletter',
          apiId: 'newsletter',
          description: 'Launch updates',
        },
      }),
    );
    await ctx.prisma.asSystem((tx) =>
      tx.form.create({
        data: {
          id: newId(),
          workspaceId: ws,
          listId,
          name: 'Signup',
          apiId: 'signup',
          schema: [{ name: 'email', type: 'email', required: true }],
          successMessage: 'Welcome aboard.',
        },
      }),
    );
    const key = await createDeliveryKey([
      'content.read',
      'subscriber.read',
      'subscriber.write',
      'form.submit',
    ]);

    const lists = await api()
      .get('/v1/lists')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(lists.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: listId, api_id: 'newsletter', subscriber_count: 0 }),
      ]),
    );

    const form = await api()
      .get('/v1/forms/signup')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(form.body.data).toMatchObject({
      api_id: 'signup',
      list: { api_id: 'newsletter' },
      success_message: 'Welcome aboard.',
    });

    const submitted = await api()
      .post('/v1/forms/signup/submit')
      .set('Authorization', `Bearer ${key.key}`)
      .send({
        payload: { email: 'Fan@Example.com', first_name: 'Fan', topic: 'cms' },
        tags: [' launch ', 'vip'],
      })
      .expect(201);

    expect(submitted.body.data.subscriber).toMatchObject({
      email: 'fan@example.com',
      first_name: 'Fan',
      status: 'subscribed',
      tags: ['launch', 'vip'],
      lists: [expect.objectContaining({ api_id: 'newsletter' })],
    });

    const subscriber = await api()
      .get('/v1/subscribers/fan%40example.com')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    expect(subscriber.body.data).toMatchObject({
      email: 'fan@example.com',
      lists: [expect.objectContaining({ api_id: 'newsletter' })],
    });

    const patched = await api()
      .patch('/v1/subscribers/fan%40example.com')
      .set('Authorization', `Bearer ${key.key}`)
      .send({
        last_name: 'Reader',
        attributes: { source_detail: 'e2e' },
        list_api_ids: [],
      })
      .expect(200);

    expect(patched.body.data).toMatchObject({
      email: 'fan@example.com',
      last_name: 'Reader',
      attributes: { source_detail: 'e2e' },
      lists: [],
    });

    const unsubscribed = await api()
      .post('/v1/subscribers/fan%40example.com/unsubscribe')
      .set('Authorization', `Bearer ${key.key}`)
      .send({})
      .expect(200);

    expect(unsubscribed.body.data).toMatchObject({
      email: 'fan@example.com',
      status: 'unsubscribed',
      lists: [],
    });
  });

  it('resolves draft content through short-lived preview tokens without an API key', async () => {
    const draft = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${tenant.contentType.id}`)
      .set('Cookie', cookies)
      .send({ data: { title: 'Draft preview headline' } })
      .expect(201)
      .then((response) => response.body.data);

    const token = await api()
      .post(`/admin/v1/workspaces/${ws}/content/entries/${draft.id}/preview-token`)
      .set('Cookie', cookies)
      .send({})
      .expect(201);

    expect(token.body.data.token).toMatch(/^pv_/);
    expect(token.body.data.preview_url).toBe(`/v1/preview/${token.body.data.token}`);

    const preview = await api()
      .get(token.body.data.preview_url)
      .expect(200);

    expect(preview.headers['cache-control']).toContain('no-store');
    expect(preview.body.data).toMatchObject({
      id: draft.id,
      status: 'draft',
      preview: true,
      data: { title: 'Draft preview headline' },
    });
  });

  it('creates webhooks, queues test deliveries and replays deliveries', async () => {
    const created = await api()
      .post(`/admin/v1/workspaces/${ws}/webhooks`)
      .set('Cookie', cookies)
      .send({
        name: `Delivery webhook ${Date.now()}`,
        url: 'https://example.com/webhooks/cms',
        events: ['content.published'],
      })
      .expect(201);

    const webhook = created.body.data;
    expect(webhook.signing_secret).toMatch(/^whsec_/);
    expect(webhook.signing_secret_last_four).toBe(webhook.signing_secret.slice(-4));
    expect(webhook.events).toEqual(['content.published']);

    const list = await api()
      .get(`/admin/v1/workspaces/${ws}/webhooks`)
      .set('Cookie', cookies)
      .expect(200);

    expect(list.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: webhook.id })]),
    );

    const testDelivery = await api()
      .post(`/admin/v1/workspaces/${ws}/webhooks/${webhook.id}/test`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    expect(testDelivery.body.data).toMatchObject({
      webhook_id: webhook.id,
      event_type: 'webhook.test',
      status: 'pending',
    });

    const deliveries = await api()
      .get(`/admin/v1/workspaces/${ws}/webhooks/${webhook.id}/deliveries`)
      .set('Cookie', cookies)
      .expect(200);

    expect(deliveries.body.data.map((delivery: { id: string }) => delivery.id)).toContain(
      testDelivery.body.data.id,
    );

    const replay = await api()
      .post(`/admin/v1/workspaces/${ws}/webhooks/deliveries/${testDelivery.body.data.id}/replay`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    expect(replay.body.data).toMatchObject({
      webhook_id: webhook.id,
      event_type: 'webhook.test',
      status: 'pending',
    });
    expect(replay.body.data.id).not.toBe(testDelivery.body.data.id);
  });

  it('requires the content.read API key scope', async () => {
    const key = await createDeliveryKey(['media.read']);

    await api()
      .get('/v1/content-types')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('insufficient_scope');
      });
  });

  it('requires the media.read API key scope for media', async () => {
    const key = await createDeliveryKey(['content.read']);

    await api()
      .get('/v1/media')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('insufficient_scope');
      });
  });

  it('requires the new Delivery write/search scopes', async () => {
    const contentKey = await createDeliveryKey(['content.read']);

    await api()
      .get('/v1/search')
      .query({ q: 'secret' })
      .set('Authorization', `Bearer ${contentKey.key}`)
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('insufficient_scope');
      });

    await api()
      .post('/v1/subscribers')
      .set('Authorization', `Bearer ${contentKey.key}`)
      .send({ email: 'scope-test@example.com' })
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('insufficient_scope');
      });

    await api()
      .post('/v1/forms/unknown/submit')
      .set('Authorization', `Bearer ${contentKey.key}`)
      .send({ email: 'scope-test@example.com' })
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('insufficient_scope');
      });
  });
});
