import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTenant, createTestApp, disableExternalChecks, registerUser, type TestApp } from './helpers';

disableExternalChecks();

/**
 * Registration is open only until the platform has its first owner or admin.
 *
 * The bootstrap branch is covered by a unit test rather than here: proving it
 * end to end would mean removing every administrator from the database, and the
 * e2e suites share one database and run in parallel. This file covers the state
 * the platform is in for the whole of its life after the first minute.
 */
let ctx: TestApp;
let app: INestApplication;
let admin: Awaited<ReturnType<typeof createTenant>>;
let outsider: Awaited<ReturnType<typeof registerUser>>;

const PASSWORD = 'a-sufficiently-long-test-password';

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  // Creating an org makes this user its owner, which closes registration.
  admin = await createTenant(app, 'reg-admin');
  outsider = await registerUser(app, 'reg-outsider');
});

afterAll(async () => {
  await ctx.close();
});

function newEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

describe('POST /admin/v1/auth/register once an administrator exists', () => {
  it('rejects an anonymous caller with 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/v1/auth/register')
      .send({ email: newEmail('anon'), password: PASSWORD })
      .expect(401);

    expect(response.body.error.code).toBe('session_expired');
  });

  it('rejects a signed-in user who is not an owner or admin with 403', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/v1/auth/register')
      .set('Cookie', outsider.cookies)
      .send({ email: newEmail('by-outsider'), password: PASSWORD })
      .expect(403);

    expect(response.body.error.code).toBe('insufficient_permission');
  });

  it('lets an owner create an account without signing it in', async () => {
    const email = newEmail('by-admin');

    const response = await request(app.getHttpServer())
      .post('/admin/v1/auth/register')
      .set('Cookie', admin.user.cookies)
      .send({ email, password: PASSWORD, full_name: 'Created By Admin' })
      .expect(201);

    expect(response.body.data.email).toBe(email);

    // The caller keeps their own session: issuing tokens for the new account
    // would replace the administrator's cookies in their browser.
    const setCookie = response.headers['set-cookie'] ?? [];
    expect(setCookie).toHaveLength(0);
  });

  it('creates an account that can then sign in itself', async () => {
    const email = newEmail('then-signs-in');

    await request(app.getHttpServer())
      .post('/admin/v1/auth/register')
      .set('Cookie', admin.user.cookies)
      .send({ email, password: PASSWORD })
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
  });

  it('still reports a duplicate address as a conflict', async () => {
    await request(app.getHttpServer())
      .post('/admin/v1/auth/register')
      .set('Cookie', admin.user.cookies)
      .send({ email: outsider.email, password: PASSWORD })
      .expect(409);
  });
});

/**
 * Creating an organisation makes the creator its Owner, so it carries the same
 * gate. Without this, an account an administrator created could simply make
 * itself an administrator and the registration gate would be decorative.
 */
describe('POST /admin/v1/orgs once an administrator exists', () => {
  it('rejects a signed-in user who is not already an owner or admin', async () => {
    const response = await request(app.getHttpServer())
      .post('/admin/v1/orgs')
      .set('Cookie', outsider.cookies)
      .send({ name: 'Escalation Inc' })
      .expect(403);

    expect(response.body.error.code).toBe('insufficient_permission');
  });

  it('allows an existing owner', async () => {
    await request(app.getHttpServer())
      .post('/admin/v1/orgs')
      .set('Cookie', admin.user.cookies)
      .send({ name: `Second Org ${Date.now()}` })
      .expect(201);
  });
});
