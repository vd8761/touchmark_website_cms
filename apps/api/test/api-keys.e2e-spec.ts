import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/common/prisma.service';
import { createTenant, createTestApp, disableExternalChecks, type TestApp } from './helpers';

disableExternalChecks();

let ctx: TestApp;
let app: INestApplication;
let prisma: PrismaService;
let tenant: Awaited<ReturnType<typeof createTenant>>;

let ws: string;
let cookies: string[];
let previousRateLimitEnabled: string | undefined;
let previousSecretLimit: string | undefined;
let previousPublishableLimit: string | undefined;

beforeAll(async () => {
  previousRateLimitEnabled = process.env.API_KEY_RATE_LIMIT_ENABLED;
  previousSecretLimit = process.env.API_KEY_RATE_LIMIT_SECRET_PER_MINUTE;
  previousPublishableLimit = process.env.API_KEY_RATE_LIMIT_PUBLISHABLE_PER_MINUTE;
  process.env.API_KEY_RATE_LIMIT_ENABLED = 'true';
  process.env.API_KEY_RATE_LIMIT_SECRET_PER_MINUTE = '2';
  process.env.API_KEY_RATE_LIMIT_PUBLISHABLE_PER_MINUTE = '2';

  ctx = await createTestApp();
  app = ctx.app;
  prisma = ctx.prisma;
  tenant = await createTenant(app, 'keys');
  ws = tenant.workspace.id;
  cookies = tenant.user.cookies;
}, 60_000);

beforeEach(async () => {
  // Rate limits are fixed windows in Postgres; clearing the counters keeps each
  // test's budget its own.
  await prisma.asSystem((tx) => tx.rateLimitCounter.deleteMany({}));
});

afterAll(async () => {
  await ctx?.close();
  restoreEnv('API_KEY_RATE_LIMIT_ENABLED', previousRateLimitEnabled);
  restoreEnv('API_KEY_RATE_LIMIT_SECRET_PER_MINUTE', previousSecretLimit);
  restoreEnv('API_KEY_RATE_LIMIT_PUBLISHABLE_PER_MINUTE', previousPublishableLimit);
});

const api = () => request(app.getHttpServer());

async function createKey(body: Record<string, unknown>) {
  return api()
    .post(`/admin/v1/workspaces/${ws}/api-keys`)
    .set('Cookie', cookies)
    .send(body)
    .expect(201)
    .then((response) => response.body.data);
}

describe('API keys', () => {
  it('creates a secret key, shows the plaintext once, and authenticates /v1/me', async () => {
    const created = await createKey({
      name: 'Server key',
      type: 'secret',
      environment: 'live',
      scopes: ['content.read', 'media.read'],
    });

    expect(created.key).toMatch(/^sk_live_[0-9A-Za-z]+$/);
    expect(created.last_four).toBe(created.key.slice(-4));

    const stored = await prisma.asSystem((tx) =>
      tx.apiKey.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(stored.keyHash).not.toContain(created.key);

    const list = await api()
      .get(`/admin/v1/workspaces/${ws}/api-keys`)
      .set('Cookie', cookies)
      .expect(200);

    const listed = list.body.data.find((key: { id: string }) => key.id === created.id);
    expect(listed.key).toBeUndefined();
    expect(listed).toMatchObject({
      name: 'Server key',
      type: 'secret',
      environment: 'live',
      status: 'active',
      scopes: ['content.read', 'media.read'],
    });

    const me = await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200);

    expect(me.body.data).toMatchObject({
      api_key: {
        id: created.id,
        name: 'Server key',
        type: 'secret',
        environment: 'live',
        scopes: ['content.read', 'media.read'],
      },
      workspace: {
        id: ws,
        organisation_id: tenant.org.id,
        status: 'active',
      },
    });
  });

  it('rejects server-only scopes on publishable keys', async () => {
    const response = await api()
      .post(`/admin/v1/workspaces/${ws}/api-keys`)
      .set('Cookie', cookies)
      .send({
        name: 'Browser bad',
        type: 'publishable',
        scopes: ['subscriber.read'],
        allowed_origins: ['https://example.test'],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable');
  });

  it('enforces publishable-key origin allowlists', async () => {
    const created = await createKey({
      name: 'Browser key',
      type: 'publishable',
      environment: 'test',
      scopes: ['content.read'],
      allowed_origins: ['https://good.example.test'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .set('Origin', 'https://evil.example.test')
      .expect(403)
      .expect((response) => {
        expect(response.body.error.code).toBe('origin_not_allowed');
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .set('Origin', 'https://good.example.test')
      .expect(200);
  });

  it('stops accepting a key immediately after revocation', async () => {
    const created = await createKey({
      name: 'Temporary server key',
      type: 'secret',
      scopes: ['content.read'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200);

    await api()
      .post(`/admin/v1/workspaces/${ws}/api-keys/${created.id}/revoke`)
      .set('Cookie', cookies)
      .send({ reason: 'test cleanup' })
      .expect(200)
      .expect((response) => {
        expect(response.body.data.status).toBe('revoked');
        expect(response.body.data.revoked_at).not.toBeNull();
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(401)
      .expect((response) => {
        expect(response.body.error.code).toBe('key_revoked');
      });
  });

  it('resolves key auth from the database on every request', async () => {
    const created = await createKey({
      name: 'Uncached key',
      type: 'secret',
      scopes: ['content.read'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.api_key.name).toBe('Uncached key');
      });

    await prisma.asSystem((tx) =>
      tx.apiKey.update({
        where: { id: created.id },
        data: { name: 'Database name changed' },
      }),
    );

    // There is no cache in front of key auth, so a change is visible on the very
    // next request. This is what lets §12.1 promise that revoking a key stops it
    // authenticating immediately rather than at the end of some TTL.
    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.api_key.name).toBe('Database name changed');
      });
  });

  it('updates API key settings and applies them immediately', async () => {
    const created = await createKey({
      name: 'Original cached key',
      type: 'secret',
      scopes: ['content.read'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.api_key.name).toBe('Original cached key');
      });

    await api()
      .patch(`/admin/v1/workspaces/${ws}/api-keys/${created.id}`)
      .set('Cookie', cookies)
      .send({ name: 'Updated cached key', rate_limit_per_minute: 2 })
      .expect(200)
      .expect((response) => {
        expect(response.body.data.name).toBe('Updated cached key');
        expect(response.body.data.rate_limit_per_minute).toBe(2);
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.api_key.name).toBe('Updated cached key');
        expect(response.body.data.limits.requests_per_minute).toBe(2);
      });
  });

  it('rotates a key immediately and returns the replacement plaintext once', async () => {
    const created = await createKey({
      name: 'Rotated server key',
      type: 'secret',
      scopes: ['content.read'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200);

    const rotated = await api()
      .post(`/admin/v1/workspaces/${ws}/api-keys/${created.id}/rotate`)
      .set('Cookie', cookies)
      .send({ grace_period: 'immediate', name: 'Rotated replacement key' })
      .expect(200)
      .then((response) => response.body.data);

    expect(rotated.previous).toMatchObject({
      id: created.id,
      status: 'revoked',
      rotated_to_id: rotated.replacement.id,
    });
    expect(rotated.replacement).toMatchObject({
      name: 'Rotated replacement key',
      type: 'secret',
      rotated_from_id: created.id,
    });
    expect(rotated.replacement.key).toMatch(/^sk_live_[0-9A-Za-z]+$/);

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(401)
      .expect((response) => {
        expect(response.body.error.code).toBe('key_revoked');
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${rotated.replacement.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.api_key.id).toBe(rotated.replacement.id);
      });
  });

  it('enforces per-key rate limits', async () => {
    const created = await createKey({
      name: 'Limited server key',
      type: 'secret',
      scopes: ['content.read'],
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.headers['x-ratelimit-limit']).toBe('2');
        expect(response.headers['x-ratelimit-remaining']).toBe('1');
        expect(response.headers['x-ratelimit-reset']).toBeDefined();
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(200)
      .expect((response) => {
        expect(response.headers['x-ratelimit-limit']).toBe('2');
        expect(response.headers['x-ratelimit-remaining']).toBe('0');
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(429)
      .expect((response) => {
        expect(response.headers['x-ratelimit-limit']).toBe('2');
        expect(response.headers['x-ratelimit-remaining']).toBe('0');
        expect(response.body.error.code).toBe('rate_limit_exceeded');
      });
  });

  it('uses per-key rate-limit overrides and records request logs', async () => {
    const created = await createKey({
      name: 'Logged limited key',
      type: 'secret',
      scopes: ['content.read'],
      rate_limit_per_minute: 1,
    });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .set('User-Agent', 'api-key-log-test')
      .expect(200)
      .expect((response) => {
        expect(response.headers['x-ratelimit-limit']).toBe('1');
        expect(response.headers['x-ratelimit-remaining']).toBe('0');
      });

    await api()
      .get('/v1/me')
      .set('Authorization', `Bearer ${created.key}`)
      .set('User-Agent', 'api-key-log-test')
      .expect(429)
      .expect((response) => {
        expect(response.body.error.code).toBe('rate_limit_exceeded');
      });

    const logs = await waitForLogs(created.id, 2);
    expect(logs.map((log) => log.status_code)).toEqual([429, 200]);
    expect(logs[0]).toMatchObject({
      api_key_id: created.id,
      method: 'GET',
      path: '/v1/me',
      status_code: 429,
      error_code: 'rate_limit_exceeded',
      user_agent: 'api-key-log-test',
    });
    expect(logs[1]).toMatchObject({
      api_key_id: created.id,
      method: 'GET',
      path: '/v1/me',
      status_code: 200,
      error_code: null,
      user_agent: 'api-key-log-test',
    });

    const summary = await api()
      .get(`/admin/v1/workspaces/${ws}/api-logs/summary`)
      .query({
        since: new Date(Date.now() - 60_000).toISOString(),
        until: new Date(Date.now() + 60_000).toISOString(),
      })
      .set('Cookie', cookies)
      .expect(200);

    expect(summary.body.data.totals.requests).toBeGreaterThanOrEqual(2);
    expect(summary.body.data.totals.errors).toBeGreaterThanOrEqual(1);
    // Conventional status classes. This previously asserted '200xx'/'400xx',
    // which codified an arithmetic slip in the grouping SQL rather than a
    // decision — no reader expects a status class to be five characters long.
    expect(summary.body.data.by_status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status_class: '2xx' }),
        expect.objectContaining({ status_class: '4xx' }),
      ]),
    );
    expect(summary.body.data.top_paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/v1/me', requests: expect.any(Number) }),
      ]),
    );
    expect(summary.body.data.top_keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ api_key_id: created.id, api_key_name: 'Logged limited key' }),
      ]),
    );

    const stored = await prisma.asSystem((tx) =>
      tx.apiKey.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(stored.rateLimitPerMinute).toBe(1);
    expect(stored.usageCount).toBeGreaterThanOrEqual(2);
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it('returns the Delivery API auth errors from the Phase 2 table', async () => {
    await api()
      .get('/v1/me')
      .expect(401)
      .expect((response) => {
        expect(response.body.error.code).toBe('missing_api_key');
      });

    await api()
      .get('/v1/me')
      .set('Authorization', 'Bearer not-a-key')
      .expect(401)
      .expect((response) => {
        expect(response.body.error.code).toBe('invalid_api_key');
      });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitForLogs(keyId: string, count: number) {
  let last: any[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await api()
      .get(`/admin/v1/workspaces/${ws}/api-keys/${keyId}/request-logs`)
      .set('Cookie', cookies)
      .expect(200);
    last = response.body.data;
    if (last.length >= count) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}
