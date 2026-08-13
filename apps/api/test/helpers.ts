import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/common/prisma.service';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma, close: () => app.close() };
}

/** A signed-in user with cookies ready to attach to subsequent requests. */
export interface TestUser {
  id: string;
  email: string;
  cookies: string[];
}

let counter = 0;

const TEST_PASSWORD = 'a-sufficiently-long-test-password';

/**
 * Provisions a user and signs them in.
 *
 * The row is created directly rather than through POST /auth/register, because
 * registration is deliberately *not* an open endpoint: it is available only
 * until the platform has its first owner or admin (see AuthService.register).
 * Driving fixtures through it would mean only the first user of a test run
 * could be created. The registration rule has its own dedicated coverage in
 * auth-registration.e2e-spec.ts; everything else needs a user, not a signup.
 */
export async function registerUser(app: INestApplication, label = 'user'): Promise<TestUser> {
  // The `e2e.` marker is what global teardown matches on. It must stay distinct
  // from the seed, which also uses example.test — deleting owner@example.test
  // because a test run finished would be a nasty surprise on a dev database.
  const email = `${label}-${Date.now()}-${counter++}@e2e.example.test`;
  const prisma = app.get(PrismaService);
  const passwordHash = await app.get(PasswordService).hash(TEST_PASSWORD);

  const user = await prisma.asSystem((tx) =>
    tx.user.create({
      data: {
        id: randomUUID(),
        email,
        passwordHash,
        fullName: label,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    }),
  );

  return { id: user.id, email, cookies: await signIn(app, email) };
}

/** Signs an existing account in and returns its session cookies. */
export async function signIn(app: INestApplication, email: string): Promise<string[]> {
  const response = await request(app.getHttpServer())
    .post('/admin/v1/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return extractCookies(response);
}

/**
 * Creates an organisation owned by `user`, directly.
 *
 * Like registerUser, this deliberately bypasses POST /admin/v1/orgs. That
 * endpoint hands out Owner and so carries the same bootstrap gate as
 * registration — only an administrator may call it once one exists — which
 * would let a test run build exactly one tenant. The gate itself is covered in
 * auth-registration.e2e-spec.ts.
 */
export async function createOrg(app: INestApplication, user: TestUser, name: string) {
  const prisma = app.get(PrismaService);
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter++}-${Date.now()}`;

  return prisma.asSystem(async (tx) => {
    const org = await tx.organisation.create({
      data: { id: randomUUID(), name, slug },
      select: { id: true, slug: true, name: true },
    });
    await tx.organisationMember.create({
      data: { id: randomUUID(), organisationId: org.id, userId: user.id, role: 'owner' },
    });
    return org;
  });
}

export async function createWorkspace(
  app: INestApplication,
  user: TestUser,
  orgId: string,
  name: string,
) {
  const response = await request(app.getHttpServer())
    .post(`/admin/v1/orgs/${orgId}/workspaces`)
    .set('Cookie', user.cookies)
    .send({ name })
    .expect(201);
  return response.body.data as { id: string; slug: string; name: string };
}

/**
 * A user, their org, a workspace, and real content inside it — one
 * self-contained tenant.
 *
 * The content matters: the isolation suite substitutes *these* ids into the
 * other tenant's requests, so a 404 proves the record was hidden rather than
 * merely absent. Probing with a random uuid would pass even if isolation were
 * completely broken.
 */
export async function createTenant(app: INestApplication, label: string) {
  const user = await registerUser(app, label);
  const org = await createOrg(app, user, `${label} Org`);
  const workspace = await createWorkspace(app, user, org.id, `${label} Site`);

  const contentType = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/content-types`)
    .set('Cookie', user.cookies)
    .send({ name: `${label} Article` })
    .expect(201)
    .then((r) => r.body.data as { id: string; api_id: string });

  const field = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/content-types/${contentType.id}/fields`)
    .set('Cookie', user.cookies)
    .send({ name: 'Title', type: 'text', required: true })
    .expect(201)
    .then((r) => r.body.data as { id: string; api_id: string });

  const entry = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/content/${contentType.id}`)
    .set('Cookie', user.cookies)
    .send({ data: { title: `${label} secret headline` } })
    .expect(201)
    .then((r) => r.body.data as { id: string; slug: string });

  const taxonomy = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/taxonomies`)
    .set('Cookie', user.cookies)
    .send({ name: `${label} Category`, is_hierarchical: true })
    .expect(201)
    .then((r) => r.body.data as { id: string; api_id: string });

  const term = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/taxonomies/${taxonomy.id}/terms`)
    .set('Cookie', user.cookies)
    .send({ name: `${label} secret term` })
    .expect(201)
    .then((r) => r.body.data as { id: string; slug: string });

  const menu = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/menus`)
    .set('Cookie', user.cookies)
    .send({ name: `${label} Nav` })
    .expect(201)
    .then((r) => r.body.data as { id: string; api_id: string });

  const folder = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/media/folders`)
    .set('Cookie', user.cookies)
    .send({ name: `${label} folder` })
    .expect(201)
    .then((r) => r.body.data as { id: string; path: string });

  // Reserved, not uploaded — enough for an id the other tenant must not reach.
  const asset = await request(app.getHttpServer())
    .post(`/admin/v1/workspaces/${workspace.id}/media/upload-url`)
    .set('Cookie', user.cookies)
    .send({ filename: `${label}-secret.png`, mime_type: 'image/png', size_bytes: 1024 })
    .expect(201)
    .then((r) => ({ id: (r.body.data as { asset_id: string }).asset_id }));

  return { user, org, workspace, contentType, field, entry, taxonomy, term, menu, folder, asset };
}

function extractCookies(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

/** Disables the outbound breach check so tests do not depend on the network. */
export function disableExternalChecks(): void {
  process.env.PASSWORD_PWNED_CHECK = 'false';
}
