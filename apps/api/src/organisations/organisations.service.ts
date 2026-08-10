import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OrganisationDto, OrganisationMemberDto, OrgRole, WorkspaceRole } from '@cms/shared';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { MailService } from '../common/mail.service';
import { PlatformAdminsService } from '../common/platform-admins.service';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { EventsService } from '../events/events.service';
import { hash, TokenService } from '../auth/token.service';
import { SLUG_PATTERN } from './dto/organisation.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // §6.4: invites expire after 7 days
const RESEND_COOLDOWN_MS = 60 * 60 * 1000; // §6.4: resend rate-limited to once per hour

@Injectable()
export class OrganisationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly mail: MailService,
    private readonly tokens: TokenService,
    private readonly admins: PlatformAdminsService,
  ) {}

  // -- Organisations ---------------------------------------------------------

  /**
   * Creates an organisation; the caller becomes its first Owner.
   *
   * Gated the same way registration is, and for the same reason: this endpoint
   * hands out Owner, so leaving it open would let any account an administrator
   * created turn itself into an administrator, and the registration gate would
   * be decorative. After bootstrap, people arrive in an organisation by
   * invitation.
   */
  async create(ctx: RequestContext, input: { name: string; slug?: string }): Promise<OrganisationDto> {
    await this.admins.assertMayBootstrapOrAdminister(
      { userId: ctx.userId },
      {
        closed: 'You cannot create an organisation.',
        closedDetail: 'Sign in first.',
        forbidden: 'You cannot create an organisation.',
        forbiddenDetail:
          'This platform already has an administrator. Ask one to invite you to an ' +
          'existing organisation.',
      },
    );

    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name));

    const org = await this.prisma.asSystem(async (tx) => {
      const created = await tx.organisation.create({
        data: { id: newId(), name: input.name.trim(), slug },
      });

      // The creator is the first Owner. §3.1: "At least one always exists."
      await tx.organisationMember.create({
        data: {
          id: newId(),
          organisationId: created.id,
          userId: ctx.userId,
          role: 'owner',
        },
      });

      await this.events.emit(tx, 'organisation.created', { name: created.name, slug }, { orgId: created.id });
      await this.audit.recordIn(tx, {
        organisationId: created.id,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'organisation.created',
        resourceType: 'organisation',
        resourceId: created.id,
        after: { name: created.name, slug },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return toOrgDto(org, 'owner');
  }

  async update(
    ctx: RequestContext,
    orgId: string,
    patch: { name?: string; logo_url?: string; billing_email?: string },
  ): Promise<OrganisationDto> {
    const before = await this.prisma.asSystem((tx) =>
      tx.organisation.findUnique({ where: { id: orgId } }),
    );
    if (!before) throw notFound('Organisation', orgId);

    const org = await this.prisma.asSystem(async (tx) => {
      const updated = await tx.organisation.update({
        where: { id: orgId },
        data: {
          name: patch.name?.trim() ?? undefined,
          logoUrl: patch.logo_url ?? undefined,
          billingEmail: patch.billing_email ?? undefined,
        },
      });

      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'organisation.updated',
        resourceType: 'organisation',
        resourceId: orgId,
        before: { name: before.name, logoUrl: before.logoUrl, billingEmail: before.billingEmail },
        after: { name: updated.name, logoUrl: updated.logoUrl, billingEmail: updated.billingEmail },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return updated;
    });

    return toOrgDto(org, ctx.orgRole ?? 'member');
  }

  // -- Members ---------------------------------------------------------------

  async listMembers(orgId: string): Promise<OrganisationMemberDto[]> {
    return this.prisma.asSystem(async (tx) => {
      const members = await tx.organisationMember.findMany({
        where: { organisationId: orgId },
        include: { user: true },
        orderBy: { joinedAt: 'asc' },
      });

      const workspaceRoles = await tx.workspaceMember.findMany({
        where: {
          workspace: { organisationId: orgId, deletedAt: null },
          userId: { in: members.map((m) => m.userId) },
        },
        include: { workspace: { select: { id: true, name: true } } },
      });

      const pending = await tx.invitation.findMany({
        where: { organisationId: orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });

      const active: OrganisationMemberDto[] = members.map((m) => ({
        id: m.id,
        user: {
          id: m.user.id,
          email: m.user.email,
          full_name: m.user.fullName,
          avatar_url: m.user.avatarUrl,
        },
        role: m.role,
        status: 'active',
        joined_at: m.joinedAt.toISOString(),
        last_active_at: m.lastActiveAt?.toISOString() ?? null,
        workspaces: workspaceRoles
          .filter((w) => w.userId === m.userId)
          .map((w) => ({ id: w.workspace.id, name: w.workspace.name, role: w.role })),
      }));

      // §17.17 shows invited-but-not-yet-joined people in the same table, so
      // they are returned from the same endpoint rather than a second call.
      const invited: OrganisationMemberDto[] = pending.map((i) => ({
        id: i.id,
        user: { id: i.id, email: i.email, full_name: null, avatar_url: null },
        role: i.orgRole,
        status: 'invited',
        joined_at: null,
        last_active_at: null,
        workspaces: [],
      }));

      return [...active, ...invited];
    });
  }

  async invite(
    ctx: RequestContext,
    orgId: string,
    input: { email: string; org_role: OrgRole; workspace_grants?: { workspace_id: string; role: WorkspaceRole }[] },
  ) {
    const email = input.email.trim().toLowerCase();

    // Only Owners may create Owners — otherwise an Admin could escalate itself
    // by inviting a second account as Owner.
    if (input.org_role === 'owner' && ctx.orgRole !== 'owner') {
      throw new AppError('insufficient_permission', 'Only an Owner can invite another Owner.', {
        detail: 'Ask an existing Owner to send this invitation, or invite them as Admin instead.',
      });
    }

    const grants = input.workspace_grants ?? [];
    if (grants.length) {
      const valid = await this.prisma.asSystem((tx) =>
        tx.workspace.count({
          where: { organisationId: orgId, deletedAt: null, id: { in: grants.map((g) => g.workspace_id) } },
        }),
      );
      if (valid !== grants.length) {
        throw new AppError('invalid_request', 'One of the sites in this invitation does not exist.', {
          detail: 'Every workspace_grants entry must reference a site in this organisation.',
        });
      }
    }

    const existing = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findFirst({
        where: { organisationId: orgId, user: { email } },
        select: { id: true },
      }),
    );
    if (existing) throw conflict('That person is already a member of this organisation.');

    const token = randomBytes(32).toString('base64url');

    const invitation = await this.prisma.asSystem(async (tx) => {
      // Re-inviting replaces the outstanding invitation rather than stacking
      // a second live token for the same address.
      await tx.invitation.updateMany({
        where: { organisationId: orgId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const created = await tx.invitation.create({
        data: {
          id: newId(),
          organisationId: orgId,
          email,
          orgRole: input.org_role,
          workspaceGrants: grants as unknown as Prisma.InputJsonValue,
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          invitedBy: ctx.userId,
        },
        include: { organisation: { select: { name: true } }, inviter: { select: { fullName: true } } },
      });

      await this.events.emit(tx, 'member.invited', { email, org_role: input.org_role }, { orgId });
      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'member.invited',
        resourceType: 'invitation',
        resourceId: created.id,
        after: { email, org_role: input.org_role, workspace_grants: grants },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    await this.mail.sendInvitation(email, token, {
      orgName: invitation.organisation.name,
      inviterName: invitation.inviter?.fullName ?? null,
    });

    return toInvitationDto(invitation);
  }

  async resendInvitation(ctx: RequestContext, orgId: string, invitationId: string) {
    const invitation = await this.prisma.asSystem((tx) =>
      tx.invitation.findFirst({
        where: { id: invitationId, organisationId: orgId },
        include: { organisation: { select: { name: true } }, inviter: { select: { fullName: true } } },
      }),
    );

    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      throw notFound('Invitation', invitationId);
    }

    if (Date.now() - invitation.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - invitation.lastSentAt.getTime())) / 60000,
      );
      throw new AppError('rate_limit_exceeded', 'This invitation was sent recently.', {
        detail: `Invitations can be resent once per hour. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`,
      });
    }

    // A resend issues a fresh token; the previous link stops working, so a
    // forwarded old email cannot be used by someone else.
    const token = randomBytes(32).toString('base64url');
    await this.prisma.asSystem((tx) =>
      tx.invitation.update({
        where: { id: invitationId },
        data: {
          tokenHash: hash(token),
          lastSentAt: new Date(),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      }),
    );

    await this.mail.sendInvitation(invitation.email, token, {
      orgName: invitation.organisation.name,
      inviterName: invitation.inviter?.fullName ?? null,
    });

    await this.audit.record({
      organisationId: orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'member.invitation_resent',
      resourceType: 'invitation',
      resourceId: invitationId,
      requestId: ctx.requestId,
    });
  }

  async revokeInvitation(ctx: RequestContext, orgId: string, invitationId: string): Promise<void> {
    const result = await this.prisma.asSystem((tx) =>
      tx.invitation.updateMany({
        where: { id: invitationId, organisationId: orgId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    if (result.count === 0) throw notFound('Invitation', invitationId);

    await this.audit.record({
      organisationId: orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'member.invitation_revoked',
      resourceType: 'invitation',
      resourceId: invitationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * Accepting an invitation creates the org membership and every per-site grant
   * that was attached to it (§6.4). The caller must already be signed in — the
   * portal routes an unknown email to signup first, then back here.
   */
  async acceptInvitation(ctx: RequestContext, token: string): Promise<{ organisation_id: string }> {
    const invitation = await this.prisma.asSystem((tx) =>
      tx.invitation.findUnique({ where: { tokenHash: hash(token) } }),
    );

    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      throw new AppError('invalid_request', 'This invitation is no longer valid.', {
        detail: 'Invitations expire after 7 days and can be accepted once. Ask for a new one.',
      });
    }

    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { email: true } }),
    );

    // The invitation is bound to an address. Accepting it while signed in as
    // someone else would silently grant access to the wrong account.
    if (user?.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new AppError('insufficient_permission', 'This invitation was sent to a different address.', {
        detail: `Sign in as ${invitation.email} to accept it.`,
      });
    }

    const grants = (invitation.workspaceGrants as unknown as { workspace_id: string; role: WorkspaceRole }[]) ?? [];

    await this.prisma.asSystem(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      await tx.organisationMember.upsert({
        where: {
          organisationId_userId: { organisationId: invitation.organisationId, userId: ctx.userId },
        },
        create: {
          id: newId(),
          organisationId: invitation.organisationId,
          userId: ctx.userId,
          role: invitation.orgRole,
          invitedBy: invitation.invitedBy,
        },
        update: { role: invitation.orgRole },
      });

      for (const grant of grants) {
        // Skip grants for sites deleted between invitation and acceptance
        // rather than failing the whole acceptance.
        const exists = await tx.workspace.count({
          where: { id: grant.workspace_id, organisationId: invitation.organisationId, deletedAt: null },
        });
        if (!exists) continue;

        await tx.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: grant.workspace_id, userId: ctx.userId } },
          create: {
            id: newId(),
            workspaceId: grant.workspace_id,
            userId: ctx.userId,
            role: grant.role,
            addedBy: invitation.invitedBy,
          },
          update: { role: grant.role },
        });
      }

      await this.events.emit(
        tx,
        'member.joined',
        { user_id: ctx.userId, org_role: invitation.orgRole },
        { orgId: invitation.organisationId },
      );

      await this.audit.recordIn(tx, {
        organisationId: invitation.organisationId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'member.joined',
        resourceType: 'organisation_member',
        resourceId: ctx.userId,
        after: { org_role: invitation.orgRole, workspace_grants: grants },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    return { organisation_id: invitation.organisationId };
  }

  async changeMemberRole(
    ctx: RequestContext,
    orgId: string,
    userId: string,
    role: OrgRole,
  ): Promise<void> {
    const member = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findFirst({ where: { organisationId: orgId, userId } }),
    );
    if (!member) throw notFound('Member', userId);

    if (role === 'owner' && ctx.orgRole !== 'owner') {
      throw new AppError('insufficient_permission', 'Only an Owner can promote someone to Owner.');
    }

    // §6.4: "the last Owner cannot be removed or demoted."
    if (member.role === 'owner' && role !== 'owner') {
      await this.assertNotLastOwner(orgId, userId);
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.organisationMember.update({ where: { id: member.id }, data: { role } });
      await this.events.emit(tx, 'member.role_changed', { user_id: userId, from: member.role, to: role }, { orgId });
      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'member.role_changed',
        resourceType: 'organisation_member',
        resourceId: userId,
        before: { role: member.role },
        after: { role },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    // A role change alters what every in-flight token is allowed to do. Roles
    // are resolved per request rather than from the token, so nothing needs
    // revoking — but the user's cached shell data is now stale, and §6.1
    // requires notifying them.
  }

  async removeMember(ctx: RequestContext, orgId: string, userId: string): Promise<void> {
    const member = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findFirst({ where: { organisationId: orgId, userId } }),
    );
    if (!member) throw notFound('Member', userId);

    if (member.role === 'owner') await this.assertNotLastOwner(orgId, userId);

    await this.prisma.asSystem(async (tx) => {
      // §6.4: "Removing a user from the org cascades to remove all their site
      // memberships." Leaving them behind would let the user keep working in a
      // site after losing org access.
      await tx.workspaceMember.deleteMany({
        where: { userId, workspace: { organisationId: orgId } },
      });
      await tx.organisationMember.delete({ where: { id: member.id } });

      await this.events.emit(tx, 'member.removed', { user_id: userId }, { orgId });
      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'member.removed',
        resourceType: 'organisation_member',
        resourceId: userId,
        before: { role: member.role },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });

    // §6.4: "A user removed mid-session has their sessions revoked within 60
    // seconds." Revoking immediately is strictly better than the requirement.
    await this.tokens.revokeAllForUser(userId, 'removed_from_organisation');
  }

  async transferOwnership(ctx: RequestContext, orgId: string, newOwnerId: string): Promise<void> {
    const target = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findFirst({ where: { organisationId: orgId, userId: newOwnerId } }),
    );
    if (!target) {
      throw new AppError('invalid_request', 'That person is not a member of this organisation.', {
        detail: 'Invite them first, then transfer ownership.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.organisationMember.update({ where: { id: target.id }, data: { role: 'owner' } });
      // The previous owner is demoted to admin, not removed — losing access to
      // your own organisation by transferring it would be a nasty surprise.
      await tx.organisationMember.updateMany({
        where: { organisationId: orgId, userId: ctx.userId },
        data: { role: 'admin' },
      });

      await this.events.emit(
        tx,
        'organisation.ownership_transferred',
        { from: ctx.userId, to: newOwnerId },
        { orgId },
      );
      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'organisation.ownership_transferred',
        resourceType: 'organisation',
        resourceId: orgId,
        before: { owner: ctx.userId },
        after: { owner: newOwnerId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async assertNotLastOwner(orgId: string, userId: string): Promise<void> {
    const otherOwners = await this.prisma.asSystem((tx) =>
      tx.organisationMember.count({
        where: { organisationId: orgId, role: 'owner', userId: { not: userId } },
      }),
    );
    if (otherOwners === 0) {
      throw new AppError('unprocessable', 'This is the only Owner of the organisation.', {
        detail:
          'Every organisation must have at least one Owner. Promote someone else to Owner first, ' +
          'or transfer ownership.',
      });
    }
  }

  private async uniqueSlug(base: string): Promise<string> {
    const candidate = slugify(base);
    if (!SLUG_PATTERN.test(candidate)) {
      throw new AppError('validation_failed', 'That name cannot be turned into a URL slug.', {
        detail: 'Provide a slug explicitly using lowercase letters, numbers and hyphens.',
      });
    }

    for (let suffix = 0; suffix < 100; suffix++) {
      const slug = suffix === 0 ? candidate : `${candidate}-${suffix}`;
      const taken = await this.prisma.asSystem((tx) =>
        tx.organisation.count({ where: { slug } }),
      );
      if (!taken) return slug;
    }
    return `${candidate}-${Date.now().toString(36)}`;
  }
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toOrgDto(
  org: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    plan: 'free' | 'starter' | 'growth' | 'enterprise';
    status: 'active' | 'past_due' | 'suspended';
    createdAt: Date;
  },
  role: OrgRole,
): OrganisationDto {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logo_url: org.logoUrl,
    plan: org.plan,
    status: org.status,
    role,
    created_at: org.createdAt.toISOString(),
  };
}

function toInvitationDto(invitation: {
  id: string;
  email: string;
  orgRole: OrgRole;
  workspaceGrants: unknown;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  inviter: { fullName: string | null } | null;
  invitedBy: string | null;
}) {
  return {
    id: invitation.id,
    email: invitation.email,
    org_role: invitation.orgRole,
    workspace_grants: invitation.workspaceGrants as { workspace_id: string; role: WorkspaceRole }[],
    expires_at: invitation.expiresAt.toISOString(),
    accepted_at: invitation.acceptedAt?.toISOString() ?? null,
    invited_by: invitation.invitedBy
      ? { id: invitation.invitedBy, full_name: invitation.inviter?.fullName ?? null }
      : null,
    created_at: invitation.createdAt.toISOString(),
  };
}
