import type { OrgRole, Permission, WorkspaceRole } from '@cms/shared';

/**
 * The resolved request context of §3.4 layer 1.
 *
 * Constructed once per request by ContextInterceptor and never mutated
 * afterwards. `workspaceId` comes from the URL path or the X-Workspace-Id
 * header — never from a client-supplied body field, which is the whole point.
 */
export class RequestContext {
  constructor(
    readonly requestId: string,
    readonly userId: string,
    readonly orgId: string | null,
    readonly workspaceId: string | null,
    readonly orgRole: OrgRole | null,
    readonly effectiveRole: WorkspaceRole | null,
    readonly permissions: ReadonlySet<Permission>,
    readonly ip: string | null,
    readonly userAgent: string | null,
    /**
     * True when the workspace is archived. Write permissions have already been
     * stripped from `permissions`; this flag exists so the denial can say *why*
     * rather than blaming the user's role for something the site status caused.
     */
    readonly workspaceArchived: boolean = false,
  ) {}

  has(permission: Permission): boolean {
    return this.permissions.has(permission);
  }

  /**
   * The workspace this request is scoped to, or a thrown error. Repositories
   * call this rather than reading `workspaceId` directly, so a missing scope is
   * a loud failure instead of a query over every tenant.
   */
  requireWorkspaceId(): string {
    if (!this.workspaceId) {
      throw new Error(
        'RequestContext has no workspace scope. A workspace-scoped repository was ' +
          'called from a route that never resolved one — check that the route is ' +
          'under /workspaces/:workspaceId or sends X-Workspace-Id.',
      );
    }
    return this.workspaceId;
  }

  requireOrgId(): string {
    if (!this.orgId) {
      throw new Error('RequestContext has no organisation scope.');
    }
    return this.orgId;
  }
}

declare module 'express' {
  interface Request {
    ctx?: RequestContext;
    requestId?: string;
  }
}
