/**
 * Media, taxonomies and menus — the remainder of Phase 1.
 *
 * The media tests drive the real two-step upload against the local storage
 * driver, including the presigned PUT, so the flow a browser performs is the
 * flow under test rather than a stubbed approximation.
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

let ctx: TestApp;
let app: INestApplication;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let ws: string;
let cookies: string[];

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  tenant = await createTenant(app, 'media');
  ws = tenant.workspace.id;
  cookies = tenant.user.cookies;
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const api = () => request(app.getHttpServer());

/** A real 1×1 PNG, so magic-byte checks and dimension parsing see genuine bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Performs the full client-side upload: ask for a URL, PUT the bytes to it,
 * then confirm. The presigned URL points at this same app under the local
 * driver, so its path is extracted and replayed through supertest.
 */
async function upload(bytes: Buffer, filename: string, mimeType: string) {
  const reserved = await api()
    .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
    .set('Cookie', cookies)
    .send({ filename, mime_type: mimeType, size_bytes: bytes.length })
    .expect(201);

  const { asset_id: assetId, upload_url: uploadUrl } = reserved.body.data;
  const path = uploadUrl.replace(/^https?:\/\/[^/]+/, '');

  await api().put(path).set('Content-Type', mimeType).send(bytes).expect(200);

  return { assetId, complete: () =>
    api()
      .post(`/admin/v1/workspaces/${ws}/media/${assetId}/complete`)
      .set('Cookie', cookies) };
}

// ---------------------------------------------------------------------------

describe('media upload', () => {
  it('completes a real upload and reads the image dimensions', async () => {
    const { assetId, complete } = await upload(PNG, 'pixel.png', 'image/png');
    const response = await complete().expect(200);

    expect(response.body.data).toMatchObject({
      id: assetId,
      filename: 'pixel.png',
      mime_type: 'image/png',
      width: 1,
      height: 1,
      size_bytes: PNG.length,
    });
    expect(response.body.data.uploaded_at).not.toBeNull();
  });

  it('hides an asset from the library until the upload is completed', async () => {
    const before = await api()
      .get(`/admin/v1/workspaces/${ws}/media`)
      .set('Cookie', cookies)
      .expect(200);

    const reserved = await api()
      .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
      .set('Cookie', cookies)
      .send({ filename: 'never-finished.png', mime_type: 'image/png', size_bytes: 10 })
      .expect(201);

    const after = await api()
      .get(`/admin/v1/workspaces/${ws}/media`)
      .set('Cookie', cookies)
      .expect(200);

    // A reserved-but-unuploaded row would render as a broken thumbnail.
    expect(after.body.meta.total).toBe(before.body.meta.total);
    expect(after.body.data.map((a: { id: string }) => a.id)).not.toContain(
      reserved.body.data.asset_id,
    );
  });

  it('refuses to complete when nothing was uploaded', async () => {
    const reserved = await api()
      .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
      .set('Cookie', cookies)
      .send({ filename: 'absent.png', mime_type: 'image/png', size_bytes: 10 })
      .expect(201);

    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/media/${reserved.body.data.asset_id}/complete`)
      .set('Cookie', cookies);

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/no file/i);
  });

  it('rejects a file whose contents disagree with its declared type', async () => {
    // §18.2: uploads are MIME-sniffed. HTML served as image/png is stored XSS.
    const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
    const { complete } = await upload(html, 'evil.png', 'image/png');

    const response = await complete();
    expect(response.status).toBe(422);
    expect(response.body.error.detail).toMatch(/HTML|scripts/i);
  });

  it('rejects a disallowed MIME type before issuing a URL', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
      .set('Cookie', cookies)
      .send({ filename: 'app.exe', mime_type: 'application/x-msdownload', size_bytes: 100 });

    expect(response.status).toBe(422);
  });

  it('rejects an unsigned upload to the local storage endpoint', async () => {
    // The endpoint is unauthenticated by design, exactly like a presigned S3
    // URL — authority comes entirely from the signature.
    const response = await api()
      .put('/uploads/local?key=ws/x/y/z.png&content_type=image/png&expires=99999999999&signature=forged')
      .set('Content-Type', 'image/png')
      .send(PNG);

    expect(response.status).toBe(403);
  });
});

describe('media usage tracking', () => {
  it('records which entries reference an asset, and blocks deletion until they do not', async () => {
    const { assetId, complete } = await upload(PNG, 'used.png', 'image/png');
    await complete().expect(200);

    const type = await api()
      .post(`/admin/v1/workspaces/${ws}/content-types`)
      .set('Cookie', cookies)
      .send({ name: 'Illustrated' })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/content-types/${type.body.data.id}/fields`)
      .set('Cookie', cookies)
      .send({ name: 'Hero', type: 'media' })
      .expect(201);

    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { hero: assetId } })
      .expect(201);

    const usages = await api()
      .get(`/admin/v1/workspaces/${ws}/media/${assetId}/usages`)
      .set('Cookie', cookies)
      .expect(200);

    expect(usages.body.data).toHaveLength(1);
    expect(usages.body.data[0]).toMatchObject({
      entry_id: entry.body.data.id,
      field_api_id: 'hero',
    });

    // §17.7: the usage warning comes before deletion, not as a broken image later.
    const refused = await api()
      .delete(`/admin/v1/workspaces/${ws}/media/${assetId}`)
      .set('Cookie', cookies);
    expect(refused.status).toBe(409);

    // Clearing the reference releases the asset.
    await api()
      .patch(`/admin/v1/workspaces/${ws}/content/entries/${entry.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { hero: null } })
      .expect(200);

    const after = await api()
      .get(`/admin/v1/workspaces/${ws}/media/${assetId}/usages`)
      .set('Cookie', cookies)
      .expect(200);
    expect(after.body.data).toHaveLength(0);

    await api()
      .delete(`/admin/v1/workspaces/${ws}/media/${assetId}`)
      .set('Cookie', cookies)
      .expect(204);
  });

  it('ignores a media reference to an asset that does not exist', async () => {
    // Stale ids in the jsonb must not create usage rows pointing at nothing —
    // or, worse, at another tenant's asset.
    const type = await api()
      .post(`/admin/v1/workspaces/${ws}/content-types`)
      .set('Cookie', cookies)
      .send({ name: 'Stale Refs' })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/content-types/${type.body.data.id}/fields`)
      .set('Cookie', cookies)
      .send({ name: 'Picture', type: 'media' })
      .expect(201);

    const entry = await api()
      .post(`/admin/v1/workspaces/${ws}/content/${type.body.data.id}`)
      .set('Cookie', cookies)
      .send({ data: { picture: '00000000-0000-7000-8000-000000000000' } })
      .expect(201);

    const usages = await ctx.prisma.asSystem((tx) =>
      tx.mediaUsage.count({ where: { entryId: entry.body.data.id } }),
    );
    expect(usages).toBe(0);
  });
});

describe('media folders', () => {
  it('refuses to delete a folder that still has contents', async () => {
    const folder = await api()
      .post(`/admin/v1/workspaces/${ws}/media/folders`)
      .set('Cookie', cookies)
      .send({ name: 'Occupied' })
      .expect(201);

    const reserved = await api()
      .post(`/admin/v1/workspaces/${ws}/media/upload-url`)
      .set('Cookie', cookies)
      .send({
        filename: 'in-folder.png',
        mime_type: 'image/png',
        size_bytes: PNG.length,
        folder_id: folder.body.data.id,
      })
      .expect(201);

    const path = reserved.body.data.upload_url.replace(/^https?:\/\/[^/]+/, '');
    await api().put(path).set('Content-Type', 'image/png').send(PNG).expect(200);
    await api()
      .post(`/admin/v1/workspaces/${ws}/media/${reserved.body.data.asset_id}/complete`)
      .set('Cookie', cookies)
      .expect(200);

    const refused = await api()
      .delete(`/admin/v1/workspaces/${ws}/media/folders/${folder.body.data.id}`)
      .set('Cookie', cookies);

    expect(refused.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describe('taxonomies', () => {
  let taxonomyId: string;

  beforeAll(async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies`)
      .set('Cookie', cookies)
      .send({ name: 'Topic', is_hierarchical: true })
      .expect(201);
    taxonomyId = response.body.data.id;
  });

  it('returns hierarchical terms as a nested tree', async () => {
    const parent = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Engineering' })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Databases', parent_id: parent.body.data.id })
      .expect(201);

    const terms = await api()
      .get(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .expect(200);

    const engineering = terms.body.data.find(
      (t: { name: string }) => t.name === 'Engineering',
    );
    expect(engineering.children).toHaveLength(1);
    expect(engineering.children[0].name).toBe('Databases');
  });

  it('refuses to nest terms in a flat taxonomy', async () => {
    const flat = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies`)
      .set('Cookie', cookies)
      .send({ name: 'Tag' })
      .expect(201);

    const term = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${flat.body.data.id}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Parent tag' })
      .expect(201);

    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${flat.body.data.id}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Child tag', parent_id: term.body.data.id });

    expect(response.status).toBe(422);
  });

  it('refuses to delete a term that has children', async () => {
    const parent = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Has children' })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'A child', parent_id: parent.body.data.id })
      .expect(201);

    const response = await api()
      .delete(`/admin/v1/workspaces/${ws}/terms/${parent.body.data.id}`)
      .set('Cookie', cookies);

    expect(response.status).toBe(409);
  });

  it('merges one term into another and re-parents its children', async () => {
    const target = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Canonical' })
      .expect(201);

    const source = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Duplicate' })
      .expect(201);

    const child = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Child of duplicate', parent_id: source.body.data.id })
      .expect(201);

    await api()
      .post(`/admin/v1/workspaces/${ws}/terms/${source.body.data.id}/merge`)
      .set('Cookie', cookies)
      .send({ target_id: target.body.data.id })
      .expect(200);

    const moved = await ctx.prisma.asSystem((tx) =>
      tx.taxonomyTerm.findUnique({ where: { id: child.body.data.id } }),
    );
    expect(moved?.parentId).toBe(target.body.data.id);

    const gone = await ctx.prisma.asSystem((tx) =>
      tx.taxonomyTerm.count({ where: { id: source.body.data.id } }),
    );
    expect(gone).toBe(0);
  });

  it('generates unique slugs within a taxonomy', async () => {
    const first = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Same Name' })
      .expect(201);

    const second = await api()
      .post(`/admin/v1/workspaces/${ws}/taxonomies/${taxonomyId}/terms`)
      .set('Cookie', cookies)
      .send({ name: 'Same Name' })
      .expect(201);

    expect(first.body.data.slug).toBe('same-name');
    expect(second.body.data.slug).toBe('same-name-1');
  });
});

describe('menus', () => {
  let menuId: string;

  beforeAll(async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/menus`)
      .set('Cookie', cookies)
      .send({ name: 'Footer' })
      .expect(201);
    menuId = response.body.data.id;
  });

  it('replaces the item tree atomically and returns it nested', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${menuId}/items`)
      .set('Cookie', cookies)
      .send({
        items: [
          {
            label: 'Company',
            link_type: 'none',
            children: [
              { label: 'About', link_type: 'url', url: 'https://acme.com/about' },
              { label: 'Careers', link_type: 'url', url: 'https://acme.com/careers' },
            ],
          },
          { label: 'Blog', link_type: 'entry', entry_id: tenant.entry.id },
        ],
      })
      .expect(200);

    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0].children).toHaveLength(2);
    expect(response.body.data.items[1].entry_id).toBe(tenant.entry.id);

    // Replacing again fully supersedes the previous tree.
    const replaced = await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${menuId}/items`)
      .set('Cookie', cookies)
      .send({ items: [{ label: 'Only item', link_type: 'url', url: 'https://acme.com' }] })
      .expect(200);

    expect(replaced.body.data.items).toHaveLength(1);
  });

  it('rejects a menu item pointing at an entry that does not exist', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${menuId}/items`)
      .set('Cookie', cookies)
      .send({
        items: [
          {
            label: 'Ghost',
            link_type: 'entry',
            entry_id: '00000000-0000-7000-8000-000000000000',
          },
        ],
      });

    expect(response.status).toBe(400);
  });

  it('rejects nesting deeper than three levels', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${menuId}/items`)
      .set('Cookie', cookies)
      .send({
        items: [
          {
            label: 'L1',
            link_type: 'none',
            children: [
              {
                label: 'L2',
                link_type: 'none',
                children: [
                  {
                    label: 'L3',
                    link_type: 'none',
                    children: [{ label: 'L4', link_type: 'url', url: 'https://acme.com' }],
                  },
                ],
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(422);
  });

  it('rejects a url item with no url', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/menus/${menuId}/items`)
      .set('Cookie', cookies)
      .send({ items: [{ label: 'Broken', link_type: 'url' }] });

    expect(response.status).toBe(400);
  });
});
