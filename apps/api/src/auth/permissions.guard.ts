import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { OrgPermission, Permission } from '@cms/shared';

import { AppError } from '../common/errors';
import { authorize, authorizeOrg } from './authorize';
import { IS_PUBLIC, REQUIRED_ORG_PERMISSION, REQUIRED_PERMISSION } from './permissions.decorator';

/**
 * Runs authorize() at the service boundary, before any handler (§3.4 layer 2).
 *
 * Registered globally, so a route with no @RequirePermission and no @Public is
 * authenticated-but-unauthorised by default rather than open by default. A
 * handler that needs no specific permission still needs a session.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const ctx = request.ctx;

    if (!ctx) {
      throw new AppError('session_expired', 'You are not signed in.', {
        detail: 'This endpoint requires a valid session. Sign in and retry.',
      });
    }

    const orgPermission = this.reflector.getAllAndOverride<OrgPermission>(
      REQUIRED_ORG_PERMISSION,
      targets,
    );
    if (orgPermission) authorizeOrg(ctx, orgPermission);

    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, targets);
    if (permission) authorize(ctx, permission);

    return true;
  }
}
