import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
}

/**
 * Token issuance and rotation (§6.1).
 *
 * The access token is a short-lived JWT. The refresh token is opaque and stored
 * only as a hash — a database leak must not yield usable refresh tokens.
 *
 * The access token deliberately does NOT carry org_id, workspace_id, role or
 * permissions. The spec's §6.1 sketch includes them, but baking them into a
 * 15-minute token means a role change or a removal takes up to 15 minutes to
 * take effect, which contradicts §6.4's 60-second requirement. Roles are
 * resolved per request instead (see RequestContextGuard).
 */
@Injectable()
export class TokenService {
  private readonly revokedSessions = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async issue(
    userId: string,
    context: { userAgent?: string | null; ip?: string | null; familyId?: string },
  ): Promise<IssuedTokens> {
    const sessionId = newId();
    const familyId = context.familyId ?? sessionId;
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30);

    await this.prisma.asSystem((tx) =>
      tx.session.create({
        data: {
          id: sessionId,
          userId,
          familyId,
          refreshTokenHash: hash(refreshToken),
          userAgent: context.userAgent ?? null,
          ip: context.ip ?? null,
          expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
        },
      }),
    );

    const expiresIn = parseDuration(this.config.get('ACCESS_TOKEN_TTL') ?? '15m');
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, jti: newId() } satisfies AccessTokenClaims,
      { expiresIn },
    );

    return { accessToken, refreshToken, sessionId, expiresIn };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token);
  }

  /**
   * Rotates a refresh token. §6.1: "Reuse of a rotated refresh token revokes
   * the whole session family (detects theft)." A token that is presented twice
   * means one of the two holders is not the legitimate user, and there is no
   * way to tell which — so both lose access.
   */
  async rotate(
    refreshToken: string,
    context: { userAgent?: string | null; ip?: string | null },
  ): Promise<IssuedTokens> {
    const tokenHash = hash(refreshToken);

    const session = await this.prisma.asSystem((tx) =>
      tx.session.findUnique({
        where: { refreshTokenHash: tokenHash },
        select: {
          id: true,
          userId: true,
          familyId: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: { status: true } },
        },
      }),
    );

    if (!session) {
      throw new AppError('session_expired', 'This session is no longer valid.');
    }

    if (session.revokedAt) {
      await this.revokeFamily(session.familyId, 'refresh_token_reuse');
      throw new AppError('session_expired', 'This session has been revoked.', {
        detail:
          'A previously rotated refresh token was presented again, which usually means the ' +
          'token was stolen. Every session from that sign-in has been revoked. Sign in again.',
      });
    }

    if (session.expiresAt < new Date() || session.user.status !== 'active') {
      throw new AppError('session_expired', 'This session has expired.');
    }

    await this.prisma.asSystem((tx) =>
      tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated', lastUsedAt: new Date() },
      }),
    );
    this.markRevoked(session.id);

    return this.issue(session.userId, { ...context, familyId: session.familyId });
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.asSystem((tx) =>
      tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    this.markRevoked(sessionId);
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const sessions = await this.prisma.asSystem(async (tx) => {
      const rows = await tx.session.findMany({ where: { familyId }, select: { id: true } });
      await tx.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      return rows;
    });
    for (const s of sessions) this.markRevoked(s.id);
  }

  /** Revokes every session for a user — password change, MFA change, removal from the org. */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    const sessions = await this.prisma.asSystem(async (tx) => {
      const rows = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      return rows;
    });
    for (const s of sessions) this.markRevoked(s.id);
  }

  /**
   * Checked on every request so a revoked session stops working within seconds
   * rather than at token expiry (§6.4).
   *
   * **The map is a positive cache and only ever a positive cache.** It answers
   * "already known revoked" and nothing else; every other outcome falls through
   * to the database. That asymmetry is the whole design, and it is what makes
   * this correct on any number of instances: a session revoked on instance A
   * misses B's map, B queries, B sees `revoked_at`, and the request is refused
   * on its first attempt. There is no window during which another instance
   * serves a revoked session.
   *
   * The cost is a read per authenticated request when the session is valid. Do
   * not "optimise" that away with a negative cache — caching *validity* is
   * precisely what would create the staleness this design avoids, and it would
   * hand an attacker with a stolen access token a guaranteed grace period after
   * the victim revokes.
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    if (this.revokedSessions.has(sessionId)) return true;

    const session = await this.prisma.asSystem((tx) =>
      tx.session.findUnique({
        where: { id: sessionId },
        select: { revokedAt: true, expiresAt: true },
      }),
    );

    if (!session) return true;
    const revoked = session.revokedAt !== null || session.expiresAt < new Date();
    if (revoked) this.markRevoked(sessionId);
    return revoked;
  }

  private markRevoked(sessionId: string): void {
    this.revokedSessions.set(sessionId, Date.now());
    // Bound the map: entries older than the longest access-token lifetime can
    // no longer be presented, so remembering them serves no purpose.
    if (this.revokedSessions.size > 10_000) {
      const cutoff = Date.now() - 3_600_000;
      for (const [id, at] of this.revokedSessions) {
        if (at < cutoff) this.revokedSessions.delete(id);
      }
    }
  }
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 900;
  const amount = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * unit;
}
