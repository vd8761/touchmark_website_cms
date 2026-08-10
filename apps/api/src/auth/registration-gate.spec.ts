import { AppError } from '../common/errors';
import { PlatformAdminsService } from '../common/platform-admins.service';
import { AuthService } from './auth.service';

/**
 * The bootstrap branch of AuthService.register.
 *
 * This is a unit test on purpose. Proving "registration is open while no
 * administrator exists" end to end would mean stripping every owner and admin
 * out of the database, and the e2e suites share one database and run in
 * parallel. The closed branch — the state the platform is in for all of its
 * real life — is covered end to end in test/auth-registration.e2e-spec.ts.
 */

interface Fixture {
  service: AuthService;
  issued: string[];
  audited: { action: string; actorId: string | null }[];
}

function build(adminCount: number, existingAdminUserIds: string[] = []): Fixture {
  const issued: string[] = [];
  const audited: { action: string; actorId: string | null }[] = [];

  const tx = {
    organisationMember: {
      count: async () => adminCount,
      findFirst: async ({ where }: { where: { userId: string } }) =>
        existingAdminUserIds.includes(where.userId) ? { id: 'member-1' } : null,
    },
    user: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: new Date(),
        emailVerifiedAt: null,
        avatarUrl: null,
        timezone: 'UTC',
        locale: 'en',
        mfaEnabled: false,
        status: 'active',
      }),
    },
    emailToken: { create: async () => ({}) },
  };

  const prisma = { asSystem: (cb: (t: typeof tx) => unknown) => cb(tx) };
  const admins = new PlatformAdminsService(prisma as never);
  const passwords = { assertAcceptable: async () => undefined, hash: async () => 'hashed' };
  const tokens = {
    issue: async (userId: string) => {
      issued.push(userId);
      return { accessToken: 'a', refreshToken: 'r' };
    },
  };
  const mail = { sendEmailVerification: async () => undefined };
  const audit = {
    record: async (entry: { action: string; actorId: string | null }) => {
      audited.push({ action: entry.action, actorId: entry.actorId });
    },
  };

  const service = new AuthService(
    prisma as never,
    passwords as never,
    tokens as never,
    mail as never,
    audit as never,
    admins,
  );

  return { service, issued, audited };
}

const input = { email: 'First.Admin@example.test', password: 'a-sufficiently-long-password' };

describe('registration gate', () => {
  it('allows an anonymous first account when no administrator exists', async () => {
    const { service, issued, audited } = build(0);

    const result = await service.register(input, {}, null);

    expect(result.user.email).toBe('first.admin@example.test');
    // The bootstrap account is signed straight in — there is nobody to invite it.
    expect(result.tokens).not.toBeNull();
    expect(issued).toHaveLength(1);
    expect(audited[0].action).toBe('user.registered');
  });

  it('closes to anonymous callers as soon as one administrator exists', async () => {
    const { service } = build(1);

    await expect(service.register(input, {}, null)).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('rejects a signed-in caller who is not an administrator', async () => {
    const { service } = build(1, ['someone-else']);

    await expect(
      service.register(input, {}, { userId: 'not-an-admin' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.register(input, {}, { userId: 'not-an-admin' }),
    ).rejects.toMatchObject({ code: 'insufficient_permission' });
  });

  it('allows an administrator, issues no session, and attributes the audit entry to them', async () => {
    const { service, issued, audited } = build(1, ['the-admin']);

    const result = await service.register(input, {}, { userId: 'the-admin' });

    expect(result.tokens).toBeNull();
    expect(issued).toHaveLength(0);
    expect(audited[0]).toEqual({ action: 'user.created', actorId: 'the-admin' });
  });
});
