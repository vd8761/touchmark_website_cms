/**
 * The tenant-isolation suite — spec §4.4 safeguard 5.
 *
 *   "An automated test suite that, for every list/read endpoint, creates two
 *    workspaces and asserts workspace A's key cannot read workspace B's records.
 *    This runs in CI and blocks merges."
 *
 * And §19's sequencing note: "Build the tenant-isolation test suite in Phase 0,
 * not later. Retrofitting isolation guarantees is the single most expensive
 * mistake available in this architecture."
 *
 * The suite has three layers, because a leak can happen at three depths:
 *   1. HTTP — every workspace-scoped route, driven end to end.
 *   2. Repository — the base repository's injected filter.
 *   3. Database — the RLS policies, tested by querying with the scope of the
 *      wrong tenant set.
 *
 * ROUTE COVERAGE is asserted, not assumed: the suite enumerates the app's
 * registered routes and fails if a workspace-scoped route has no isolation
 * test. Adding an endpoint in Phase 1 without a test therefore fails CI, which
 * is the only way this stays true as the surface grows.
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/common/prisma.service';
import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

let ctx: TestApp;
let app: INestApplication;
let prisma: PrismaService;

let alice: Awaited<ReturnType<typeof createTenant>>;
let bob: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  prisma = ctx.prisma;

  // Two complete, unrelated tenants. Nothing is shared between them — not the
  // user, not the organisation, not the workspace.
  alice = await createTenant(app, 'alice');
  bob = await createTenant(app, 'bob');
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

// ---------------------------------------------------------------------------
// Layer 1 — HTTP
// ---------------------------------------------------------------------------

/**
 * Every workspace-scoped route, as `[method, path template]`. The path is
 * templated on `:workspaceId` so the suite can substitute the *other* tenant's
 * id and assert the request is refused.
 */
const WORKSPACE_SCOPED_ROUTES: [string, string][] = [
  ['get', '/admin/v1/workspaces/:workspaceId'],
  ['patch', '/admin/v1/workspaces/:workspaceId'],
  ['post', '/admin/v1/workspaces/:workspaceId/archive'],
  ['post', '/admin/v1/workspaces/:workspaceId/restore'],
  ['delete', '/admin/v1/workspaces/:workspaceId'],
  ['get', '/admin/v1/workspaces/:workspaceId/members'],
  ['post', '/admin/v1/workspaces/:workspaceId/members'],
  ['patch', '/admin/v1/workspaces/:workspaceId/members/:userId'],
  ['delete', '/admin/v1/workspaces/:workspaceId/members/:userId'],
  ['get', '/admin/v1/workspaces/:workspaceId/audit-logs'],
  // Added with site ownership transfer and never covered — the coverage guard
  // below is what caught it. Handing another tenant's site to yourself would be
  // the most complete cross-tenant takeover the API could offer, so this route
  // wants an isolation test more than most.
  ['post', '/admin/v1/workspaces/:workspaceId/transfer-ownership'],
  ['get', '/admin/v1/workspaces/:workspaceId/email/configurations'],
  ['patch', '/admin/v1/workspaces/:workspaceId/email/configuration'],
  ['get', '/admin/v1/workspaces/:workspaceId/email/senders'],
  ['post', '/admin/v1/workspaces/:workspaceId/email/senders'],
  ['post', '/admin/v1/workspaces/:workspaceId/email/senders/:id/default'],
  ['delete', '/admin/v1/workspaces/:workspaceId/email/senders/:id'],
  ['get', '/admin/v1/workspaces/:workspaceId/api-keys'],
  ['post', '/admin/v1/workspaces/:workspaceId/api-keys'],
  ['patch', '/admin/v1/workspaces/:workspaceId/api-keys/:keyId'],
  ['post', '/admin/v1/workspaces/:workspaceId/api-keys/:keyId/rotate'],
  ['get', '/admin/v1/workspaces/:workspaceId/api-keys/:keyId/request-logs'],
  ['post', '/admin/v1/workspaces/:workspaceId/api-keys/:keyId/revoke'],
  ['get', '/admin/v1/workspaces/:workspaceId/api-logs/summary'],
  ['get', '/admin/v1/workspaces/:workspaceId/webhooks'],
  ['post', '/admin/v1/workspaces/:workspaceId/webhooks'],
  ['delete', '/admin/v1/workspaces/:workspaceId/webhooks/:webhookId'],
  ['get', '/admin/v1/workspaces/:workspaceId/webhooks/:webhookId/deliveries'],
  ['post', '/admin/v1/workspaces/:workspaceId/webhooks/:webhookId/test'],
  ['post', '/admin/v1/workspaces/:workspaceId/webhooks/deliveries/:deliveryId/replay'],

  // Phase 1 — content
  ['get', '/admin/v1/workspaces/:workspaceId/content-types'],
  ['post', '/admin/v1/workspaces/:workspaceId/content-types'],
  ['get', '/admin/v1/workspaces/:workspaceId/content-types/:typeId'],
  ['patch', '/admin/v1/workspaces/:workspaceId/content-types/:typeId'],
  ['delete', '/admin/v1/workspaces/:workspaceId/content-types/:typeId'],
  ['post', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields'],
  ['patch', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields/:fieldId'],
  ['get', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields/:fieldId/impact'],
  ['post', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields/:fieldId/deprecate'],
  ['delete', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields/:fieldId'],
  ['post', '/admin/v1/workspaces/:workspaceId/content-types/:typeId/fields/reorder'],
  ['get', '/admin/v1/workspaces/:workspaceId/content/:typeId'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/:typeId'],
  ['get', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId'],
  ['patch', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId'],
  ['delete', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/publish'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/unpublish'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/archive'],
  ['get', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/versions'],
  ['get', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/versions/:version'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/versions/restore'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/lock'],
  ['delete', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/lock'],
  ['post', '/admin/v1/workspaces/:workspaceId/content/entries/:entryId/preview-token'],

  // Phase 1 — taxonomies, menus, media
  ['get', '/admin/v1/workspaces/:workspaceId/taxonomies'],
  ['post', '/admin/v1/workspaces/:workspaceId/taxonomies'],
  ['delete', '/admin/v1/workspaces/:workspaceId/taxonomies/:taxonomyId'],
  ['get', '/admin/v1/workspaces/:workspaceId/taxonomies/:taxonomyId/terms'],
  ['post', '/admin/v1/workspaces/:workspaceId/taxonomies/:taxonomyId/terms'],
  ['patch', '/admin/v1/workspaces/:workspaceId/terms/:termId'],
  ['delete', '/admin/v1/workspaces/:workspaceId/terms/:termId'],
  ['post', '/admin/v1/workspaces/:workspaceId/terms/:termId/merge'],
  ['get', '/admin/v1/workspaces/:workspaceId/menus'],
  ['post', '/admin/v1/workspaces/:workspaceId/menus'],
  ['get', '/admin/v1/workspaces/:workspaceId/menus/:menuId'],
  ['post', '/admin/v1/workspaces/:workspaceId/menus/:menuId/items'],
  ['delete', '/admin/v1/workspaces/:workspaceId/menus/:menuId'],
  ['get', '/admin/v1/workspaces/:workspaceId/media'],
  ['post', '/admin/v1/workspaces/:workspaceId/media/upload-url'],
  ['get', '/admin/v1/workspaces/:workspaceId/media/folders'],
  ['post', '/admin/v1/workspaces/:workspaceId/media/folders'],
  ['delete', '/admin/v1/workspaces/:workspaceId/media/folders/:folderId'],
  ['get', '/admin/v1/workspaces/:workspaceId/media/:assetId'],
  ['patch', '/admin/v1/workspaces/:workspaceId/media/:assetId'],
  ['post', '/admin/v1/workspaces/:workspaceId/media/:assetId/complete'],
  ['get', '/admin/v1/workspaces/:workspaceId/media/:assetId/usages'],
  ['delete', '/admin/v1/workspaces/:workspaceId/media/:assetId'],
];

describe('tenant isolation — HTTP', () => {
  describe.each(WORKSPACE_SCOPED_ROUTES)('%s %s', (method, template) => {
    it("refuses Alice access to Bob's workspace", async () => {
      const path = template
        .replace(':workspaceId', bob.workspace.id)
        .replace(':userId', bob.user.id)
        .replace(':id', bob.user.id)
        // Bob's real content ids, so a leak would be a genuine cross-tenant
        // read rather than a lookup that fails for an unrelated reason.
        .replace(':typeId', bob.contentType.id)
        .replace(':fieldId', bob.field.id)
        .replace(':entryId', bob.entry.id)
        .replace(':taxonomyId', bob.taxonomy.id)
        .replace(':termId', bob.term.id)
        .replace(':menuId', bob.menu.id)
        .replace(':assetId', bob.asset.id)
        .replace(':folderId', bob.folder.id)
        .replace(':keyId', bob.user.id)
        .replace(':webhookId', bob.user.id)
        .replace(':deliveryId', bob.user.id)
        // A version number, not an id — 1 always exists on Bob's entry, so a
        // leak here would be a real cross-tenant read.
        .replace(':version', '1');

      const agent = request(app.getHttpServer()) as any;
      const response = await agent[method](path)
        .set('Cookie', alice.user.cookies)
        .send({});

      // 404 rather than 403 is intentional: a 403 would confirm that Bob's
      // workspace exists, which is itself a cross-tenant disclosure.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('resource_not_found');

      // And nothing of Bob's may appear in the body, whatever the status.
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(bob.workspace.name);
      expect(body).not.toContain(bob.user.email);
      // Bob's actual content must never surface, whatever the status code.
      expect(body).not.toContain('secret headline');
      expect(body).not.toContain(bob.contentType.api_id);
    });
  });

  it("does not list Bob's workspace among Alice's", async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/v1/auth/me')
      .set('Cookie', alice.user.cookies)
      .expect(200);

    const workspaceIds = response.body.data.workspaces.map((w: { id: string }) => w.id);
    expect(workspaceIds).toContain(alice.workspace.id);
    expect(workspaceIds).not.toContain(bob.workspace.id);

    const orgIds = response.body.data.organisations.map((o: { id: string }) => o.id);
    expect(orgIds).not.toContain(bob.org.id);
  });

  it("refuses Alice access to Bob's organisation and its members", async () => {
    for (const path of [
      `/admin/v1/orgs/${bob.org.id}`,
      `/admin/v1/orgs/${bob.org.id}/members`,
      `/admin/v1/orgs/${bob.org.id}/audit-logs`,
      `/admin/v1/orgs/${bob.org.id}/workspaces`,
    ]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Cookie', alice.user.cookies);

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(bob.user.email);
    }
  });

  it('ignores a body-supplied workspace id — scope comes from the path only', async () => {
    // §3.4: the workspace "comes from the URL path or an X-Workspace-Id header —
    // never from a client-supplied body field." A body field that could
    // re-target the write would defeat every other layer.
    const response = await request(app.getHttpServer())
      .patch(`/admin/v1/workspaces/${alice.workspace.id}`)
      .set('Cookie', alice.user.cookies)
      .send({ name: 'Renamed', workspace_id: bob.workspace.id, workspaceId: bob.workspace.id });

    // forbidNonWhitelisted rejects the unknown field outright rather than
    // silently ignoring it.
    expect(response.status).toBe(400);

    const bobWorkspace = await prisma.asSystem((tx) =>
      tx.workspace.findUniqueOrThrow({ where: { id: bob.workspace.id } }),
    );
    expect(bobWorkspace.name).toBe(bob.workspace.name);
  });

  it('ignores an X-Workspace-Id header pointing at another tenant', async () => {
    const response = await request(app.getHttpServer())
      .get(`/admin/v1/workspaces/${alice.workspace.id}`)
      .set('Cookie', alice.user.cookies)
      .set('X-Workspace-Id', bob.workspace.id)
      .expect(200);

    // The path parameter wins over the header, so the header cannot be used to
    // widen a request that the path already scoped.
    expect(response.body.data.id).toBe(alice.workspace.id);
  });

  it("refuses to add Bob's user to Alice's workspace — cross-org membership", async () => {
    const response = await request(app.getHttpServer())
      .post(`/admin/v1/workspaces/${alice.workspace.id}/members`)
      .set('Cookie', alice.user.cookies)
      .send({ user_id: bob.user.id, role: 'editor' });

    expect(response.status).toBe(400);

    const leaked = await prisma.asSystem((tx) =>
      tx.workspaceMember.count({ where: { workspaceId: alice.workspace.id, userId: bob.user.id } }),
    );
    expect(leaked).toBe(0);
  });

  it('rejects an unauthenticated request to a workspace route', async () => {
    const response = await request(app.getHttpServer()).get(
      `/admin/v1/workspaces/${alice.workspace.id}`,
    );
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — repository
// ---------------------------------------------------------------------------

describe('tenant isolation — repository scope', () => {
  it('returns only the scoped workspace’s members', async () => {
    const aliceMembers = await prisma.withWorkspaceScope(alice.workspace.id, (tx) =>
      tx.workspaceMember.findMany({}),
    );

    expect(aliceMembers.length).toBeGreaterThan(0);
    expect(aliceMembers.every((m) => m.workspaceId === alice.workspace.id)).toBe(true);
  });

  it('cannot read another workspace’s rows even when asked for them by id', async () => {
    // The query explicitly names Bob's workspace, and is run under Alice's
    // scope. RLS is what makes this return nothing.
    const rows = await prisma.withWorkspaceScope(alice.workspace.id, (tx) =>
      tx.workspaceMember.findMany({ where: { workspaceId: bob.workspace.id } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into another workspace', async () => {
    await expect(
      prisma.withWorkspaceScope(alice.workspace.id, (tx) =>
        tx.auditLog.create({
          data: {
            id: crypto.randomUUID(),
            workspaceId: bob.workspace.id,
            actorType: 'user',
            actorId: alice.user.id,
            action: 'test.cross_tenant_write',
            resourceType: 'test',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — database policies
// ---------------------------------------------------------------------------

describe('tenant isolation — row-level security', () => {
  it('has RLS enabled and forced on every table carrying workspace_id', async () => {
    const unprotected = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    `;

    expect(unprotected.map((r) => r.relname)).toEqual([]);
  });

  it('the audit log is append-only at the database level', async () => {
    // §5.6: "Append-only; never updated or deleted." UPDATE and DELETE are
    // revoked from the application role, so even a compromised app cannot
    // rewrite history.
    const privileges = await prisma.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'cms_app' AND table_name = 'audit_logs'
    `;

    const granted = privileges.map((p) => p.privilege_type);
    expect(granted).toContain('INSERT');
    expect(granted).toContain('SELECT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// Coverage guard — this is what keeps the suite honest as the API grows
// ---------------------------------------------------------------------------

describe('tenant isolation — coverage', () => {
  it('tests every workspace-scoped route the application registers', () => {
    const registered = listRegisteredRoutes(app)
      .filter(([, path]) => path.includes(':workspaceId'))
      .map(([method, path]) => `${method} ${path}`)
      .sort();

    const tested = WORKSPACE_SCOPED_ROUTES.map(([m, p]) => `${m} ${p}`).sort();

    const untested = registered.filter((route) => !tested.includes(route));

    // If this fails you have added a workspace-scoped endpoint without an
    // isolation test. Add it to WORKSPACE_SCOPED_ROUTES — do not delete this
    // assertion.
    expect(untested).toEqual([]);
  });
});

function listRegisteredRoutes(application: INestApplication): [string, string][] {
  const server = application.getHttpAdapter().getInstance();
  const router = server._router ?? server.router;
  const stack: any[] = router?.stack ?? [];

  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods)
        .filter((method) => layer.route.methods[method])
        .map((method) => [method, normalisePath(layer.route.path)] as [string, string]),
    );
}

function normalisePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
