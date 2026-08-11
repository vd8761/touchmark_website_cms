import { Injectable } from '@nestjs/common';
import type { WorkspaceDto, WorkspaceMemberDto, WorkspaceRole } from '@cms/shared';

import { AuditService } from '../audit/audit.service';
import { AppError, notFound } from '../common/errors';
import { MailService } from '../common/mail.service';
import { resolveOrganisationMember } from '../common/member-lookup';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { EventsService } from '../events/events.service';
import { slugify } from '../organisations/organisations.service';
import type { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';

const PURGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // §6.3: 30-day soft-delete window

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly mail: MailService,
  ) {}

  async list(ctx: RequestContext, orgId: string): Promise<WorkspaceDto[]> {
    const isOrgAdmin = ctx.orgRole === 'owner' || ctx.orgRole === 'admin';

    const workspaces = await this.prisma.asSystem((tx) =>
      tx.workspace.findMany({
        where: {
          organisationId: orgId,
          deletedAt: null,
          // §3.3: org Owners and Admins see every site; everyone else sees only
          // the sites they hold a membership row for.
          ...(isOrgAdmin ? {} : { members: { some: { userId: ctx.userId } } }),
        },
        include: { members: { where: { userId: ctx.userId }, select: { role: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return workspaces.map((w) =>
      toWorkspaceDto(w, w.members[0]?.role ?? (isOrgAdmin ? 'site_admin' : null)),
    );
  }

  async create(ctx: RequestContext, orgId: string, input: CreateWorkspaceDto): Promise<WorkspaceDto> {
    const slug = await this.uniqueSlug(orgId, input.slug ?? slugify(input.name));

    const workspace = await this.prisma.asSystem(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          id: newId(),
          organisationId: orgId,
          name: input.name.trim(),
          slug,
          primaryUrl: input.primary_url ?? null,
          timezone: input.timezone ?? 'UTC',
          defaultLocale: input.default_locale ?? 'en',
          locales: [input.default_locale ?? 'en'],
          colour: input.colour ?? '#4F46E5',
          createdBy: ctx.userId,
          ownerId: ctx.userId,
          settings: defaultSettings(),
        },
      });

      // §6.3: "add creator as Site Admin". Redundant for an org Owner, who
      // already inherits the role — but the row keeps the site working if their
      // org role is later reduced.
      await tx.workspaceMember.create({
        data: {
          id: newId(),
          workspaceId: created.id,
          userId: ctx.userId,
          role: 'site_admin',
          addedBy: ctx.userId,
        },
      });

      await this.events.emit(
        tx,
        'workspace.created',
        { name: created.name, slug, starter_model: input.starter_model ?? 'blank' },
        { workspaceId: created.id, orgId },
      );

      await this.audit.recordIn(tx, {
        organisationId: orgId,
        workspaceId: created.id,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.created',
        resourceType: 'workspace',
        resourceId: created.id,
        after: { name: created.name, slug, timezone: created.timezone },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    // Starter-model provisioning (content types, sample entries, a default menu,
    // a Newsletter list and form, a pk_test key) needs the content, audience and
    // developer modules, which arrive in Phases 1–3. The chosen model is
    // recorded on the workspace.created event so provisioning can be replayed
    // for sites created before those phases land.

    return toWorkspaceDto(workspace, 'site_admin');
  }

  async get(ctx: RequestContext, workspaceId: string): Promise<WorkspaceDto> {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        include: { members: { where: { userId: ctx.userId }, select: { role: true } } },
      }),
    );
    if (!workspace) throw notFound('Site', workspaceId);
    return toWorkspaceDto(workspace, ctx.effectiveRole);
  }

  async update(ctx: RequestContext, workspaceId: string, patch: UpdateWorkspaceDto): Promise<WorkspaceDto> {
    const before = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } }),
    );
    if (!before) throw notFound('Site', workspaceId);

    if (patch.locales && patch.default_locale && !patch.locales.includes(patch.default_locale)) {
      throw new AppError('unprocessable', 'The default locale must be one of the enabled locales.');
    }

    // Removing a locale that entries already use would orphan those values.
    // With no content tables yet this is a no-op, but the guard belongs with the
    // setting it protects rather than being retrofitted in Phase 1.
    if (patch.locales && !patch.locales.includes(patch.default_locale ?? before.defaultLocale)) {
      throw new AppError('unprocessable', 'You cannot remove the site’s default locale.', {
        detail: `Change the default locale away from '${before.defaultLocale}' first.`,
      });
    }

    const updated = await this.prisma.asSystem(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          name: patch.name?.trim() ?? undefined,
          description: patch.description ?? undefined,
          colour: patch.colour ?? undefined,
          primaryUrl: patch.primary_url ?? undefined,
          timezone: patch.timezone ?? undefined,
          defaultLocale: patch.default_locale ?? undefined,
          locales: patch.locales ?? undefined,
        },
      });

      await this.audit.recordIn(tx, {
        organisationId: before.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.updated',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: {
          name: before.name,
          timezone: before.timezone,
          defaultLocale: before.defaultLocale,
          locales: before.locales,
        },
        after: {
          name: workspace.name,
          timezone: workspace.timezone,
          defaultLocale: workspace.defaultLocale,
          locales: workspace.locales,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return workspace;
    });

    return toWorkspaceDto(updated, ctx.effectiveRole);
  }

  /** §6.3 archive: read-only, keys stop working, content retained, reversible. */
  async archive(ctx: RequestContext, workspaceId: string): Promise<void> {
    const workspace = await this.requireActive(workspaceId);

    await this.prisma.asSystem(async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { status: 'archived' } });
      await this.events.emit(tx, 'workspace.archived', { name: workspace.name }, {
        workspaceId,
        orgId: workspace.organisationId,
      });
      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.archived',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: { status: 'active' },
        after: { status: 'archived' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    await this.notifyOwners(workspace.organisationId, ctx, workspace.name, 'archived');
  }

  async restore(ctx: RequestContext, workspaceId: string): Promise<void> {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({ where: { id: workspaceId } }),
    );
    if (!workspace) throw notFound('Site', workspaceId);

    await this.prisma.asSystem(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { status: 'active', deletedAt: null, purgeAfter: null },
      });
      await this.events.emit(tx, 'workspace.restored', { name: workspace.name }, {
        workspaceId,
        orgId: workspace.organisationId,
      });
      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.restored',
        resourceType: 'workspace',
        resourceId: workspaceId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  /**
   * §6.3 delete: requires typing the site name, requires Site Admin AND org
   * Admin, and enters a 30-day soft-delete window before the purge job removes
   * the rows and the object-storage prefix.
   */
  async scheduleDeletion(ctx: RequestContext, workspaceId: string, confirmName: string): Promise<void> {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } }),
    );
    if (!workspace) throw notFound('Site', workspaceId);

    if (ctx.orgRole !== 'owner' && ctx.orgRole !== 'admin') {
      throw new AppError('insufficient_permission', 'Deleting a site needs an organisation Admin.', {
        detail:
          'Site Admin alone is not enough. Ask an organisation Owner or Admin to perform the deletion.',
      });
    }

    if (confirmName.trim() !== workspace.name) {
      throw new AppError('invalid_request', 'The name you typed does not match.', {
        detail: `Type "${workspace.name}" exactly to confirm.`,
      });
    }

    const purgeAfter = new Date(Date.now() + PURGE_WINDOW_MS);

    await this.prisma.asSystem(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { status: 'archived', deletedAt: new Date(), purgeAfter },
      });
      await this.events.emit(
        tx,
        'workspace.deletion_scheduled',
        { name: workspace.name, purge_after: purgeAfter.toISOString() },
        { workspaceId, orgId: workspace.organisationId },
      );
      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.deletion_scheduled',
        resourceType: 'workspace',
        resourceId: workspaceId,
        after: { purge_after: purgeAfter.toISOString() },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    await this.notifyOwners(workspace.organisationId, ctx, workspace.name, 'deleted');
  }

  /**
   * Hands one site to another organisation member, named by email (§6.3).
   *
   * Distinct from the organisation transfer above: this moves a single site and
   * never touches organisation roles. The target is granted Site Admin (created
   * if they had no membership row), and the outgoing owner is demoted to Editor
   * — they keep working in the site but no longer administer it, which is the
   * site-level analogue of Owner → Admin.
   *
   * Restricted to the current owner and organisation Owners/Admins. A second
   * Site Admin holds `workspace.ownership.transfer` through their role, but
   * letting them hand the site away from under its owner would make the
   * ownership record meaningless.
   */
  async transferOwnership(
    ctx: RequestContext,
    workspaceId: string,
    input: { email?: string; user_id?: string; confirm_name?: string },
  ): Promise<{ user_id: string; email: string }> {
    const workspace = await this.requireActive(workspaceId);
    const isOrgAdmin = ctx.orgRole === 'owner' || ctx.orgRole === 'admin';

    if (!isOrgAdmin && workspace.ownerId && workspace.ownerId !== ctx.userId) {
      throw new AppError('insufficient_permission', 'Only the site owner can transfer this site.', {
        detail:
          'Site Admin is not enough to give the site away. Ask the current owner, or an ' +
          'organisation Owner or Admin, to perform the transfer.',
      });
    }

    if (input.confirm_name !== undefined && input.confirm_name.trim() !== workspace.name) {
      throw new AppError('invalid_request', 'The name you typed does not match.', {
        detail: `Type "${workspace.name}" exactly to confirm.`,
      });
    }

    const target = await resolveOrganisationMember(this.prisma, workspace.organisationId, input);

    if (target.userId === workspace.ownerId) {
      throw new AppError('invalid_request', 'That person already owns this site.', {
        detail: 'Enter the email address of the person you want to hand it to.',
      });
    }

    const previousOwnerId = workspace.ownerId;
    const previousOwner = previousOwnerId
      ? await this.prisma.asSystem((tx) =>
          tx.user.findUnique({ where: { id: previousOwnerId }, select: { email: true } }),
        )
      : null;
    const actor = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } }),
    );

    await this.prisma.asSystem(async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: target.userId } });

      // The new owner must be able to administer what they now own, whether or
      // not they already had a role here.
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId: target.userId } },
        create: {
          id: newId(),
          workspaceId,
          userId: target.userId,
          role: 'site_admin',
          addedBy: ctx.userId,
        },
        update: { role: 'site_admin' },
      });

      // Demote the outgoing owner where they hold a stored role. An org
      // Owner/Admin with no row keeps implicit Site Admin regardless (§3.3) —
      // that is their organisation role talking, not site ownership.
      if (previousOwnerId) {
        await tx.workspaceMember.updateMany({
          where: { workspaceId, userId: previousOwnerId, role: 'site_admin' },
          data: { role: 'editor' },
        });
      }

      await this.events.emit(
        tx,
        'workspace.ownership_transferred',
        { from: previousOwnerId, to: target.userId },
        { workspaceId, orgId: workspace.organisationId },
      );

      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.ownership_transferred',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: { owner: previousOwnerId },
        after: { owner: target.userId, owner_email: target.email },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    await this.mail.sendOwnershipTransferred({
      scope: 'site',
      name: workspace.name,
      newOwnerEmail: target.email,
      previousOwnerEmail: previousOwner?.email ?? null,
      actorName: actor?.fullName ?? null,
    });

    return { user_id: target.userId, email: target.email };
  }

  // -- Members ---------------------------------------------------------------

  async listMembers(ctx: RequestContext, workspaceId: string): Promise<WorkspaceMemberDto[]> {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirstOrThrow({
        where: { id: workspaceId, deletedAt: null },
        select: { organisationId: true, ownerId: true },
      }),
    );

    return this.prisma.asSystem(async (tx) => {
      const stored = await tx.workspaceMember.findMany({
        where: { workspaceId },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      });

      // Org Owners and Admins hold Site Admin without a row (§3.3). The members
      // screen has to show them, otherwise it reads as if nobody can administer
      // the site.
      const inherited = await tx.organisationMember.findMany({
        where: {
          organisationId: workspace.organisationId,
          role: { in: ['owner', 'admin'] },
          userId: { notIn: stored.map((m) => m.userId) },
        },
        include: { user: true },
      });

      return [
        ...stored.map((m) => ({
          id: m.id,
          user: {
            id: m.user.id,
            email: m.user.email,
            full_name: m.user.fullName,
            avatar_url: m.user.avatarUrl,
          },
          role: m.role,
          inherited: false,
          is_owner: m.userId === workspace.ownerId,
          added_at: m.createdAt.toISOString(),
        })),
        ...inherited.map((m) => ({
          id: m.id,
          user: {
            id: m.user.id,
            email: m.user.email,
            full_name: m.user.fullName,
            avatar_url: m.user.avatarUrl,
          },
          role: 'site_admin' as WorkspaceRole,
          inherited: true,
          is_owner: m.userId === workspace.ownerId,
          added_at: m.joinedAt.toISOString(),
        })),
      ];
    });
  }

  async addMember(
    ctx: RequestContext,
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    const workspace = await this.requireActive(workspaceId);

    // A site membership only makes sense for someone already in the org —
    // otherwise removing them from the org later would leave an orphan grant.
    const inOrg = await this.prisma.asSystem((tx) =>
      tx.organisationMember.count({ where: { organisationId: workspace.organisationId, userId } }),
    );
    if (!inOrg) {
      throw new AppError('invalid_request', 'That person is not in this organisation yet.', {
        detail: 'Invite them to the organisation first — you can grant this site role in the same invitation.',
      });
    }

    // The owner is the site's guaranteed administrator. Demoting them through
    // the members table would leave the site owned by someone who cannot
    // administer it; the way to change who administers it is a transfer.
    if (userId === workspace.ownerId && role !== 'site_admin') {
      throw new AppError('unprocessable', 'This person owns the site.', {
        detail: 'Transfer ownership to someone else first, then change their role.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { id: newId(), workspaceId, userId, role, addedBy: ctx.userId },
        update: { role },
      });

      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.member_added',
        resourceType: 'workspace_member',
        resourceId: userId,
        after: { role },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  async removeMember(ctx: RequestContext, workspaceId: string, userId: string): Promise<void> {
    const workspace = await this.requireActive(workspaceId);

    if (userId === workspace.ownerId) {
      throw new AppError('unprocessable', 'This person owns the site.', {
        detail: 'Transfer ownership to someone else first, then remove them.',
      });
    }

    const result = await this.prisma.asSystem((tx) =>
      tx.workspaceMember.deleteMany({ where: { workspaceId, userId } }),
    );
    if (result.count === 0) throw notFound('Site member', userId);

    await this.audit.record({
      organisationId: workspace.organisationId,
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'workspace.member_removed',
      resourceType: 'workspace_member',
      resourceId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async requireActive(workspaceId: string) {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } }),
    );
    if (!workspace) throw notFound('Site', workspaceId);
    return workspace;
  }

  private async notifyOwners(
    orgId: string,
    ctx: RequestContext,
    workspaceName: string,
    action: 'archived' | 'deleted',
  ): Promise<void> {
    const owners = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findMany({
        where: { organisationId: orgId, role: 'owner' },
        include: { user: { select: { email: true } } },
      }),
    );
    const actor = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true } }),
    );

    await this.mail.sendWorkspaceDeletionNotice(
      owners.map((o) => o.user.email),
      { workspaceName, action, actorName: actor?.fullName ?? null },
    );
  }

  private async uniqueSlug(orgId: string, base: string): Promise<string> {
    for (let suffix = 0; suffix < 100; suffix++) {
      const slug = suffix === 0 ? base : `${base}-${suffix}`;
      const taken = await this.prisma.asSystem((tx) =>
        tx.workspace.count({ where: { organisationId: orgId, slug } }),
      );
      if (!taken) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

/** The §6.5 settings groups, with the defaults a new site starts from. */
function defaultSettings() {
  return {
    localisation: { fallback_behaviour: 'fallback_to_default' },
    content: {
      default_entry_status: 'draft',
      require_review_before_publish: false,
      version_retention_count: 50,
      slug_pattern: '{title}',
      allow_duplicate_slugs_across_locales: true,
    },
    media: {
      max_upload_size_mb: 25,
      auto_generate_variants: true,
      variant_widths: [640, 1024, 1600, 2400],
      image_format_preference: 'webp',
    },
    audience: { default_double_opt_in: true, gdpr_retention_days: 1095 },
    email: { tracking: { opens: true, clicks: true, utm: true } },
    api: { default_rate_limit_per_min: 120, default_cache_ttl_seconds: 60, allow_preview_keys: true },
  };
}

function toWorkspaceDto(
  workspace: {
    id: string;
    organisationId: string;
    name: string;
    slug: string;
    description: string | null;
    iconUrl: string | null;
    colour: string;
    primaryUrl: string | null;
    timezone: string;
    defaultLocale: string;
    locales: string[];
    status: 'active' | 'archived';
    ownerId: string | null;
    createdAt: Date;
  },
  role: WorkspaceRole | null,
): WorkspaceDto {
  return {
    id: workspace.id,
    organisation_id: workspace.organisationId,
    name: workspace.name,
    slug: workspace.slug,
    description: workspace.description,
    icon_url: workspace.iconUrl,
    colour: workspace.colour,
    primary_url: workspace.primaryUrl,
    timezone: workspace.timezone,
    default_locale: workspace.defaultLocale,
    locales: workspace.locales,
    status: workspace.status,
    role,
    owner_id: workspace.ownerId,
    created_at: workspace.createdAt.toISOString(),
  };
}
