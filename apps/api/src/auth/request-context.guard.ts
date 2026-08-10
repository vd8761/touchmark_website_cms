import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  effectiveWorkspaceRole,
  type OrgRole,
  type Permission,
  permissionsForWorkspaceRole,
  readOnlyPermissions,
  type WorkspaceRole,
} from '@cms/shared';

import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { IS_PUBLIC } from './permissions.decorator';
import { TokenService } from './token.service';

/**
 * §3.4 layer 1 — request context resolution.
 *
 * Runs before PermissionsGuard. Establishes who is asking, which workspace they
 * are asking about, and what that combination is allowed to do. Everything
 * downstream reads `request.ctx` and never re-derives any of it.
 */
@Injectable()
export class RequestContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    const token = extractAccessToken(request);
    if (!token) {
      // Public routes proceed with no context; protected ones are stopped by
      // PermissionsGuard, which owns the "not signed in" error.
      return true;
    }

    const claims = await this.tokens.verifyAccessToken(token).catch(() => null);
    if (!claims) {
      if (isPublic) return true;
      throw new AppError('session_expired', 'Your session has expired.', {
        detail: 'The access token is invalid or expired. Refresh it and retry.',
      });
    }

    // The session must still exist and be unrevoked. §6.4 requires a user
    // removed mid-session to lose access within 60 seconds, which a 15-minute
    // access token alone cannot deliver — so revocation is checked per request.
    if (await this.tokens.isSessionRevoked(claims.sid)) {
      if (isPublic) return true;
      throw new AppError('session_expired', 'Your session has been revoked.', {
        detail: 'Sign in again. This can happen after a password change or a role change.',
      });
    }

    request.ctx = await this.resolveContext(request, claims.sub);
    return true;
  }

  private async resolveContext(request: Request, userId: string): Promise<RequestContext> {
    // The workspace comes from the URL path or the X-Workspace-Id header, never
    // from the body (§3.4). A body field would let a caller re-target a write
    // at another tenant while passing every other check.
    const workspaceRef =
      (request.params?.workspaceId as string | undefined) ??
      (request.headers['x-workspace-id'] as string | undefined) ??
      null;

    const orgRef =
      (request.params?.orgId as string | undefined) ??
      (request.headers['x-org-id'] as string | undefined) ??
      null;

    let orgId: string | null = null;
    let orgRole: OrgRole | null = null;
    let workspaceId: string | null = null;
    let storedRole: WorkspaceRole | null = null;
    let workspaceArchived = false;

    if (workspaceRef) {
      const membership = await this.prisma.asSystem((tx) =>
        tx.workspace.findFirst({
          where: { id: workspaceRef, deletedAt: null },
          select: {
            id: true,
            status: true,
            organisationId: true,
            members: { where: { userId }, select: { role: true } },
            organisation: {
              select: { status: true, members: { where: { userId }, select: { role: true } } },
            },
          },
        }),
      );

      // No workspace, or one the user has no path to, is reported identically —
      // see the note on notFound() about not leaking tenant existence.
      if (!membership) throw new AppError('resource_not_found', 'Site not found.');

      orgId = membership.organisationId;
      orgRole = membership.organisation.members[0]?.role ?? null;
      storedRole = membership.members[0]?.role ?? null;

      if (!orgRole && !storedRole) {
        throw new AppError('resource_not_found', 'Site not found.');
      }

      if (membership.organisation.status === 'suspended') {
        throw new AppError('workspace_suspended', 'This organisation is suspended.');
      }

      workspaceArchived = membership.status === 'archived';
      workspaceId = membership.id;
    } else if (orgRef) {
      const membership = await this.prisma.asSystem((tx) =>
        tx.organisationMember.findFirst({
          where: { organisationId: orgRef, userId },
          select: { role: true, organisationId: true },
        }),
      );
      if (!membership) throw new AppError('resource_not_found', 'Organisation not found.');
      orgId = membership.organisationId;
      orgRole = membership.role;
    }

    const effective = effectiveWorkspaceRole(orgRole, storedRole);
    let granted: readonly Permission[] = effective ? permissionsForWorkspaceRole(effective) : [];

    // §6.3: "Archive: site becomes read-only." Rather than sprinkling status
    // checks through every handler, an archived workspace simply loses its
    // write permissions here — one place, impossible to forget. Unarchiving is
    // an org-level action and so is unaffected.
    if (workspaceArchived) {
      granted = readOnlyPermissions(granted);
    }

    const permissions: ReadonlySet<Permission> = new Set(granted);

    return new RequestContext(
      request.requestId ?? 'req_unknown',
      userId,
      orgId,
      workspaceId,
      orgRole,
      effective,
      permissions,
      request.ip ?? null,
      request.headers['user-agent'] ?? null,
      workspaceArchived,
    );
  }
}

function extractAccessToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  const cookie = (request as unknown as { cookies?: Record<string, string> }).cookies;
  return cookie?.access_token ?? null;
}
