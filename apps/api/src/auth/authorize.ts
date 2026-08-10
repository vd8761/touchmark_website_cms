import {
  OWNERSHIP_FALLBACKS,
  type OrgPermission,
  type Permission,
  permissionsForOrgRole,
} from '@cms/shared';

import { AppError } from '../common/errors';
import { RequestContext } from '../common/request-context';

/**
 * The single policy check of §3.4 layer 2. Every handler passes through this
 * before it runs; there is no other place that decides whether an action is
 * allowed.
 *
 * Fails closed (§1.2): an unknown action, a missing context, a null role — all
 * deny.
 */

export interface Resource {
  /** Owner of the record, for `.own`-scoped permissions. */
  ownerId?: string | null;
  /** Some `.own` permissions are narrower still — Authors may delete only *draft* own content. */
  status?: string | null;
  type?: string;
  id?: string;
}

export function authorize(
  ctx: RequestContext | undefined,
  action: Permission,
  resource?: Resource,
): void {
  if (!ctx) {
    throw new AppError('session_expired', 'Not authenticated.');
  }

  // Direct grant.
  if (ctx.has(action)) return;

  // The role may hold only the ownership-scoped variant of this permission —
  // an Author holding `content.edit.own` when `content.edit` was requested.
  const ownScoped = OWNERSHIP_FALLBACKS[action];
  if (ownScoped && ctx.has(ownScoped) && isOwner(ctx, resource)) {
    if (ownScoped === 'content.delete.own_draft' && resource?.status !== 'draft') {
      throw denied(
        action,
        `Authors may only delete their own entries while those entries are still drafts. ` +
          `This entry is '${resource?.status ?? 'unknown'}'.`,
      );
    }
    return;
  }

  // An archived site has had its write permissions stripped in the context, so
  // a denial here would otherwise be reported as a role problem — which the
  // user cannot fix, because it is not the real cause.
  if (ctx.workspaceArchived) {
    throw new AppError('workspace_archived', 'This site is archived and read-only.', {
      detail:
        `'${action}' is not available while the site is archived. Restore the site from ` +
        'organisation settings to make changes again.',
    });
  }

  throw denied(
    action,
    `Your role in this site does not include '${action}'. ` +
      `Ask a Site Admin to grant a role that does.`,
  );
}

export function authorizeOrg(ctx: RequestContext | undefined, action: OrgPermission): void {
  if (!ctx || !ctx.orgRole) {
    throw new AppError('session_expired', 'Not authenticated for this organisation.');
  }
  if (!permissionsForOrgRole(ctx.orgRole).includes(action)) {
    throw denied(
      action,
      `Organisation role '${ctx.orgRole}' does not include '${action}'.`,
    );
  }
}

/** Non-throwing form, for shaping responses (hiding a button, filtering a menu). */
export function can(ctx: RequestContext | undefined, action: Permission, resource?: Resource): boolean {
  try {
    authorize(ctx, action, resource);
    return true;
  } catch {
    return false;
  }
}

function isOwner(ctx: RequestContext, resource?: Resource): boolean {
  // An ownership-scoped permission with no resource to compare against is a
  // programming error, not a grant. Deny.
  if (!resource || !resource.ownerId) return false;
  return resource.ownerId === ctx.userId;
}

function denied(action: string, detail: string): AppError {
  return new AppError('insufficient_permission', 'You do not have permission to do this.', {
    detail: `Requires '${action}'. ${detail}`,
  });
}
