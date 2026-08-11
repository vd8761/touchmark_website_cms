/**
 * Permission constants and the role → permission mapping.
 *
 * Spec §3.3 (permission matrix) and §3.4 layer 2: "Roles map to permission sets
 * in one central file." This is that file. Nothing anywhere else in the codebase
 * may define a role's capabilities.
 *
 * Naming follows Appendix B: `resource.action`.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSIONS = [
  // Content
  'content.view',
  'content.create',
  'content.edit',
  'content.edit.own',
  'content.delete',
  'content.delete.own_draft',
  'content.publish',
  'content.review.approve',
  'content.review.request',
  'contenttype.manage',
  'taxonomy.manage',
  'taxonomy.view',
  'menu.manage',

  // Media
  'media.view',
  'media.upload',
  'media.delete',
  'media.delete.own',

  // Audience
  'subscriber.view',
  'subscriber.manage',
  'list.manage',
  'segment.manage',
  'form.view',
  'form.manage',

  // Email
  'campaign.view',
  'campaign.manage',
  'campaign.send',
  'automation.manage',
  'senderidentity.manage',

  // Developer platform
  'apikey.manage',
  'webhook.manage',
  'apilog.view',

  // Workspace administration
  'workspace.member.manage',
  'workspace.settings.edit',
  'workspace.delete',
  'workspace.ownership.transfer',
  'workspace.view',

  // Cross-cutting
  'analytics.view',
  'auditlog.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ORG_ROLES = ['owner', 'admin', 'billing', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const WORKSPACE_ROLES = [
  'site_admin',
  'editor',
  'author',
  'marketer',
  'analyst',
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Org-level permissions are deliberately a separate, tiny vocabulary. Org roles
 * do NOT grant workspace permissions directly — see `effectiveWorkspaceRole()`
 * for the one documented exception (§3.3 note).
 */
export const ORG_PERMISSIONS = [
  'org.view',
  'org.settings.edit',
  'org.member.manage',
  'org.billing.manage',
  'org.workspace.create',
  'org.delete',
  'org.ownership.transfer',
  'org.auditlog.view',
  // Provider credentials are organisation property: they carry the billing
  // relationship and the sending reputation for every site beneath them.
  'org.email.manage',
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly OrgPermission[]> = {
  owner: [
    'org.view',
    'org.settings.edit',
    'org.member.manage',
    'org.billing.manage',
    'org.workspace.create',
    'org.delete',
    'org.ownership.transfer',
    'org.auditlog.view',
    'org.email.manage',
  ],
  // Everything except deleting the org / transferring ownership (§3.1).
  admin: [
    'org.view',
    'org.settings.edit',
    'org.member.manage',
    'org.workspace.create',
    'org.auditlog.view',
    'org.email.manage',
  ],
  billing: ['org.view', 'org.billing.manage'],
  member: ['org.view'],
};

// ---------------------------------------------------------------------------
// Workspace role → permission sets (the §3.3 matrix, encoded)
// ---------------------------------------------------------------------------

const SITE_ADMIN: readonly Permission[] = PERMISSIONS.filter(
  // Site Admin holds everything; `.own`-suffixed variants are narrower forms
  // of permissions it already holds in full, so including them is noise.
  (p) => !p.endsWith('.own') && p !== 'content.delete.own_draft',
);

const EDITOR: readonly Permission[] = [
  'workspace.view',
  'content.view',
  'content.create',
  'content.edit',
  'content.delete',
  'content.publish',
  'content.review.approve',
  'content.review.request',
  'taxonomy.view',
  'taxonomy.manage',
  'menu.manage',
  'media.view',
  'media.upload',
  'media.delete',
  'subscriber.view',
  'subscriber.manage',
  'list.manage',
  'segment.manage',
  'form.view',
  'form.manage',
  'campaign.view',
  'campaign.manage',
  'campaign.send',
  'automation.manage',
  'apilog.view',
  'analytics.view',
  'auditlog.view',
];

const AUTHOR: readonly Permission[] = [
  'workspace.view',
  'content.view',
  'content.create',
  'content.edit.own',
  'content.delete.own_draft',
  'content.review.request',
  'taxonomy.view',
  'media.view',
  'media.upload',
  'media.delete.own',
  'subscriber.view',
  'analytics.view',
];

const MARKETER: readonly Permission[] = [
  'workspace.view',
  'content.view',
  'taxonomy.view',
  'media.view',
  'media.upload',
  'subscriber.view',
  'subscriber.manage',
  'list.manage',
  'segment.manage',
  'form.view',
  'form.manage',
  'campaign.view',
  'campaign.manage',
  'campaign.send',
  'automation.manage',
  'analytics.view',
];

const ANALYST: readonly Permission[] = [
  'workspace.view',
  'content.view',
  'taxonomy.view',
  'media.view',
  'subscriber.view',
  'form.view',
  'campaign.view',
  'apilog.view',
  'analytics.view',
  'auditlog.view',
];

const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  site_admin: SITE_ADMIN,
  editor: EDITOR,
  author: AUTHOR,
  marketer: MARKETER,
  analyst: ANALYST,
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function permissionsForWorkspaceRole(role: WorkspaceRole): readonly Permission[] {
  return WORKSPACE_ROLE_PERMISSIONS[role] ?? [];
}

export function permissionsForOrgRole(role: OrgRole): readonly OrgPermission[] {
  return ORG_ROLE_PERMISSIONS[role] ?? [];
}

/**
 * §3.3: "Org Owners and Org Admins implicitly hold Site Admin on every
 * workspace in the org. This is computed, not stored as a row."
 *
 * Returns the role to authorise with, or null if the user has no access.
 */
export function effectiveWorkspaceRole(
  orgRole: OrgRole | null,
  workspaceRole: WorkspaceRole | null,
): WorkspaceRole | null {
  if (orgRole === 'owner' || orgRole === 'admin') return 'site_admin';
  return workspaceRole;
}

/**
 * `.own`-scoped permissions cannot be decided from the role alone — the caller
 * must compare the resource's owner. This lists the pairs so the authorize()
 * guard knows when to demand an ownership check rather than silently allowing.
 */
export const OWNERSHIP_FALLBACKS: Partial<Record<Permission, Permission>> = {
  'content.edit': 'content.edit.own',
  'content.delete': 'content.delete.own_draft',
  'media.delete': 'media.delete.own',
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

const WRITE_VERBS = [
  'create',
  'edit',
  'delete',
  'manage',
  'publish',
  'send',
  'upload',
  'approve',
  'request',
  // Handing a site to someone else is a write, and an archived site must not
  // allow it — an archived site is read-only until it is restored.
  'transfer',
];

export function isWritePermission(permission: Permission): boolean {
  return WRITE_VERBS.some((verb) => permission.includes(verb));
}

/**
 * §6.3: "Archive: site becomes read-only."
 *
 * Rather than checking workspace status in every handler, an archived
 * workspace's context is built from this reduced set — one place, impossible to
 * forget. Lives here so the API's enforcement and the portal's affordances are
 * computed from the same function.
 */
export function readOnlyPermissions(permissions: readonly Permission[]): Permission[] {
  return permissions.filter((permission) => !isWritePermission(permission));
}
