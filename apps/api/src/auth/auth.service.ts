import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { MeResponse, UserDto } from '@cms/shared';

import { AppError } from '../common/errors';
import { MailService } from '../common/mail.service';
import { PlatformAdminsService } from '../common/platform-admins.service';
import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { hash, IssuedTokens, TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';

interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000; // §6.1: 30-minute expiry

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** §6.1: 5 failed logins per email / 15 min, 20 per IP / 15 min. */
  private readonly byEmail = new RateLimiter(5, 15 * 60 * 1000);
  private readonly byIp = new RateLimiter(20, 15 * 60 * 1000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly admins: PlatformAdminsService,
  ) {}

  /**
   * Creates an account.
   *
   * Open registration exists only to bootstrap the platform. Once any
   * organisation has an owner or admin, this endpoint is theirs alone — see
   * assertMayRegister(). `actor` is the signed-in caller, if there is one; it
   * comes from the request context, never from the body.
   *
   * Tokens are issued only on the bootstrap path. When an administrator creates
   * an account for someone else, signing that account in would replace the
   * administrator's own session in their browser.
   */
  async register(
    input: { email: string; password: string; full_name?: string },
    client: ClientInfo,
    actor: { userId: string } | null = null,
  ): Promise<{ user: UserDto; tokens: IssuedTokens | null }> {
    const isBootstrap = await this.assertMayRegister(actor);

    const email = input.email.trim().toLowerCase();
    await this.passwords.assertAcceptable(input.password, { email });

    const existing = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email }, select: { id: true } }),
    );
    if (existing) {
      // Registration is one of the few places where leaking account existence
      // is unavoidable — the user must be told to sign in instead. The login
      // path does not leak it.
      throw new AppError('conflict', 'An account with this email already exists.', {
        detail: 'Sign in instead, or use “Forgot password” if you cannot remember it.',
      });
    }

    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.prisma.asSystem((tx) =>
      tx.user.create({
        data: {
          id: newId(),
          email,
          passwordHash,
          fullName: input.full_name?.trim() || null,
        },
      }),
    );

    await this.sendVerificationEmail(user.id, email);
    await this.audit.record({
      actorType: 'user',
      // An admin-created account is attributed to the admin, not to the account
      // itself — otherwise the log says the new user created themselves.
      actorId: actor?.userId ?? user.id,
      action: isBootstrap ? 'user.registered' : 'user.created',
      resourceType: 'user',
      resourceId: user.id,
      ip: client.ip,
      userAgent: client.userAgent,
      requestId: client.requestId,
    });

    const tokens = isBootstrap ? await this.tokens.issue(user.id, client) : null;
    return { user: toUserDto(user), tokens };
  }

  private assertMayRegister(actor: { userId: string } | null): Promise<boolean> {
    return this.admins.assertMayBootstrapOrAdminister(actor, {
      closed: 'Registration is closed.',
      closedDetail:
        'This platform already has an administrator, so accounts are created by ' +
        'administrators. Sign in first, or ask an administrator to invite you.',
      forbidden: 'You cannot create accounts.',
      forbiddenDetail: 'Only an organisation owner or admin can create an account.',
    });
  }

  async login(
    input: { email: string; password: string; mfa_code?: string },
    client: ClientInfo,
  ): Promise<{ user: UserDto; tokens: IssuedTokens }> {
    const email = input.email.trim().toLowerCase();

    this.byEmail.check(email, 'Too many sign-in attempts for this account.');
    this.byIp.check(client.ip ?? 'unknown', 'Too many sign-in attempts from this address.');

    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email } }),
    );

    // Verify against a dummy hash when the user does not exist, so the response
    // time does not reveal which emails have accounts.
    const valid = user?.passwordHash
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verify(DUMMY_HASH, input.password).then(() => false);

    if (!user || !valid) {
      this.byEmail.record(email);
      this.byIp.record(client.ip ?? 'unknown');
      throw new AppError('invalid_credentials', 'Incorrect email or password.');
    }

    if (user.status !== 'active') {
      throw new AppError('invalid_credentials', 'Incorrect email or password.');
    }

    if (user.mfaEnabled && !input.mfa_code) {
      throw new AppError('mfa_required', 'Enter your authentication code.', {
        detail: 'This account has two-factor authentication enabled.',
      });
    }

    this.byEmail.reset(email);

    await this.prisma.asSystem((tx) =>
      tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    );

    await this.audit.record({
      actorType: 'user',
      actorId: user.id,
      action: 'user.logged_in',
      resourceType: 'user',
      resourceId: user.id,
      ip: client.ip,
      userAgent: client.userAgent,
      requestId: client.requestId,
    });

    const tokens = await this.tokens.issue(user.id, client);
    return { user: toUserDto(user), tokens };
  }

  async refresh(refreshToken: string, client: ClientInfo): Promise<IssuedTokens> {
    return this.tokens.rotate(refreshToken, client);
  }

  async logout(sessionId: string): Promise<void> {
    await this.tokens.revokeSession(sessionId, 'logout');
  }

  /**
   * §6.1: reset tokens are single use, expire in 30 minutes, and are
   * invalidated on use or on password change.
   *
   * Always reports success, whether or not the address has an account —
   * otherwise this endpoint becomes an account-enumeration oracle.
   */
  async forgotPassword(rawEmail: string, client: ClientInfo): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email }, select: { id: true, status: true } }),
    );

    if (!user || user.status !== 'active') {
      this.logger.log(`Password reset requested for unknown address (${client.requestId})`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    await this.prisma.asSystem(async (tx) => {
      // Any earlier outstanding reset is consumed, so only the newest link works.
      await tx.emailToken.updateMany({
        where: { userId: user.id, purpose: 'password_reset', usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.emailToken.create({
        data: {
          id: newId(),
          userId: user.id,
          purpose: 'password_reset',
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      });
    });

    await this.mail.sendPasswordReset(email, token);
  }

  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    const record = await this.prisma.asSystem((tx) =>
      tx.emailToken.findUnique({
        where: { tokenHash: hash(token) },
        select: { id: true, userId: true, purpose: true, usedAt: true, expiresAt: true,
                  user: { select: { email: true } } },
      }),
    );

    if (!record || record.purpose !== 'password_reset' || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError('invalid_request', 'This reset link is no longer valid.', {
        detail: 'Reset links expire after 30 minutes and can be used once. Request a new one.',
      });
    }

    await this.passwords.assertAcceptable(password, { email: record.user.email });
    const passwordHash = await this.passwords.hash(password);

    await this.prisma.asSystem(async (tx) => {
      await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    });

    // A password reset is the standard response to a suspected compromise, so
    // every other session must end (§6.1).
    await this.tokens.revokeAllForUser(record.userId, 'password_reset');

    await this.audit.record({
      actorType: 'user',
      actorId: record.userId,
      action: 'user.password_reset',
      resourceType: 'user',
      resourceId: record.userId,
      ip: client.ip,
      userAgent: client.userAgent,
      requestId: client.requestId,
    });

    await this.mail.sendPasswordChanged(record.user.email);
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.asSystem((tx) =>
      tx.emailToken.findUnique({
        where: { tokenHash: hash(token) },
        select: { id: true, userId: true, purpose: true, usedAt: true, expiresAt: true },
      }),
    );

    if (!record || record.purpose !== 'email_verification' || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError('invalid_request', 'This verification link is no longer valid.', {
        detail: 'Request a new verification email from your profile settings.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      });
    });
  }

  async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.asSystem((tx) =>
      tx.emailToken.create({
        data: {
          id: newId(),
          userId,
          purpose: 'email_verification',
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
        },
      }),
    );
    await this.mail.sendEmailVerification(email, token);
  }

  /**
   * Everything the portal shell needs on boot: the user, their organisations,
   * and every workspace they can reach — including workspaces reached through
   * an org Owner/Admin role rather than a stored membership row (§3.3).
   */
  async me(userId: string): Promise<MeResponse> {
    return this.prisma.asSystem(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

      const orgMemberships = await tx.organisationMember.findMany({
        where: { userId },
        include: { organisation: true },
        orderBy: { joinedAt: 'asc' },
      });

      const adminOrgIds = orgMemberships
        .filter((m) => m.role === 'owner' || m.role === 'admin')
        .map((m) => m.organisationId);

      const workspaces = await tx.workspace.findMany({
        where: {
          deletedAt: null,
          OR: [{ organisationId: { in: adminOrgIds } }, { members: { some: { userId } } }],
        },
        include: { members: { where: { userId }, select: { role: true } } },
        orderBy: { createdAt: 'asc' },
      });

      const orgRoleById = new Map(orgMemberships.map((m) => [m.organisationId, m.role]));

      return {
        user: toUserDto(user),
        organisations: orgMemberships.map((m) => ({
          id: m.organisation.id,
          name: m.organisation.name,
          slug: m.organisation.slug,
          logo_url: m.organisation.logoUrl,
          plan: m.organisation.plan,
          status: m.organisation.status,
          role: m.role,
          created_at: m.organisation.createdAt.toISOString(),
        })),
        workspaces: workspaces.map((w) => ({
          id: w.id,
          organisation_id: w.organisationId,
          name: w.name,
          slug: w.slug,
          description: w.description,
          icon_url: w.iconUrl,
          colour: w.colour,
          primary_url: w.primaryUrl,
          timezone: w.timezone,
          default_locale: w.defaultLocale,
          locales: w.locales,
          status: w.status,
          role:
            w.members[0]?.role ??
            (orgRoleById.get(w.organisationId) === 'owner' ||
            orgRoleById.get(w.organisationId) === 'admin'
              ? 'site_admin'
              : null),
          created_at: w.createdAt.toISOString(),
        })),
      };
    });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.asSystem((tx) =>
      tx.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );

    return sessions.map((s) => ({
      id: s.id,
      user_agent: s.userAgent,
      ip: s.ip,
      current: s.id === currentSessionId,
      created_at: s.createdAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
    }));
  }
}

/** Cost-matched decoy so failed logins for unknown users take the same time. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNl';

type UserRow = {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  mfaEnabled: boolean;
  emailVerifiedAt: Date | null;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
};

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    avatar_url: user.avatarUrl,
    timezone: user.timezone,
    locale: user.locale,
    mfa_enabled: user.mfaEnabled,
    email_verified: user.emailVerifiedAt !== null,
    status: user.status,
    created_at: user.createdAt.toISOString(),
  };
}
