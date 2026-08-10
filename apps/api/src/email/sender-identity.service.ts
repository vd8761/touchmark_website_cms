import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { isVerified, parseDomains } from './email-config.service';

/**
 * The workspace half of email configuration: pick one of the organisation's
 * configurations, then choose the from-addresses this site sends as.
 */
@Injectable()
export class SenderIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The dropdown contents for Site settings → Email. */
  async availableConfigurations(workspaceId: string) {
    const workspace = await this.requireWorkspace(workspaceId);

    const configs = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findMany({
        where: { organisationId: workspace.organisationId, deletedAt: null, status: { not: 'disabled' } },
        orderBy: { name: 'asc' },
      }),
    );

    return configs.map((config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      status: config.status,
      selected: config.id === workspace.emailConfigurationId,
      // The site can only send from these, so the picker shows them up front
      // rather than letting someone choose a configuration and then discover it
      // has no domain they can use.
      verified_domains: parseDomains(config.verifiedDomains).filter(isVerified).map((d) => d.name),
    }));
  }

  async selectConfiguration(
    ctx: RequestContext,
    workspaceId: string,
    configId: string | null,
  ): Promise<void> {
    const workspace = await this.requireWorkspace(workspaceId);

    if (configId) {
      // Scoped to this workspace's organisation: a site must not be able to
      // attach itself to another tenant's provider account.
      const config = await this.prisma.asSystem((tx) =>
        tx.emailConfiguration.findFirst({
          where: { id: configId, organisationId: workspace.organisationId, deletedAt: null },
          select: { id: true, status: true, name: true },
        }),
      );

      if (!config) throw notFound('Email configuration', configId);
      if (config.status === 'disabled') {
        throw new AppError('unprocessable', `"${config.name}" is disabled and cannot be selected.`);
      }
    }

    const changingConfig = workspace.emailConfigurationId !== configId;

    await this.prisma.asSystem(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          emailConfigurationId: configId,
          // Sender identities belong to the old account and mean nothing under
          // the new one, so the preferred address is cleared rather than left
          // pointing at an address this site can no longer send from.
          ...(changingConfig ? { defaultSenderIdentityId: null } : {}),
        },
      });

      if (changingConfig) {
        await tx.senderIdentity.deleteMany({ where: { workspaceId } });
      }

      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'workspace.email_configuration_changed',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: { email_configuration_id: workspace.emailConfigurationId },
        after: { email_configuration_id: configId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  async list(workspaceId: string) {
    const workspace = await this.requireWorkspace(workspaceId);

    const identities = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.senderIdentity.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
    );

    return identities.map((identity) => ({
      id: identity.id,
      from_name: identity.fromName,
      from_email: identity.fromEmail,
      reply_to_email: identity.replyToEmail,
      status: identity.status,
      status_detail: identity.statusDetail,
      is_default: identity.id === workspace.defaultSenderIdentityId,
      verified_at: identity.verifiedAt?.toISOString() ?? null,
      created_at: identity.createdAt.toISOString(),
    }));
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    input: { from_name: string; from_email: string; reply_to_email?: string; is_default?: boolean },
  ) {
    const workspace = await this.requireWorkspace(workspaceId);

    if (!workspace.emailConfigurationId) {
      throw new AppError('unprocessable', 'This site has no email configuration selected.', {
        detail:
          'Choose one in Site settings → Email first. Sender addresses are verified against the ' +
          'provider account behind that configuration.',
      });
    }

    const config = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findFirstOrThrow({
        where: { id: workspace.emailConfigurationId! },
        select: { id: true, name: true, verifiedDomains: true, status: true },
      }),
    );

    const email = input.from_email.trim().toLowerCase();
    const domain = email.split('@')[1];
    const verified = parseDomains(config.verifiedDomains).filter(isVerified);

    // Checked against the provider's own list rather than trusted. Sending from
    // an unverified domain is silently dropped or spam-foldered by receivers,
    // which is far harder to diagnose later than a rejection here.
    if (!verified.some((d) => d.name.toLowerCase() === domain)) {
      throw new AppError('unprocessable', `${domain} is not verified in "${config.name}".`, {
        detail: verified.length
          ? `That configuration can send from: ${verified.map((d) => d.name).join(', ')}. ` +
            `Add and verify ${domain} in Resend, then refresh the configuration.`
          : `"${config.name}" has no verified domains yet. Add one in Resend and verify its DNS ` +
            'records, then refresh the configuration in organisation settings.',
      });
    }

    const duplicate = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.senderIdentity.count({ where: { workspaceId, fromEmail: email } }),
    );
    if (duplicate) throw conflict('That from-address already exists for this site.');

    const identity = await this.prisma.asSystem(async (tx) => {
      const created = await tx.senderIdentity.create({
        data: {
          id: newId(),
          workspaceId,
          emailConfigurationId: config.id,
          fromName: input.from_name.trim(),
          fromEmail: email,
          replyToEmail: input.reply_to_email?.trim().toLowerCase() ?? null,
          // Domain verification is what Resend actually enforces, and it has
          // already passed — so the identity is usable immediately, with no
          // separate per-address confirmation email.
          status: 'verified',
          verifiedAt: new Date(),
          createdBy: ctx.userId,
        },
      });

      const existingCount = await tx.senderIdentity.count({ where: { workspaceId } });
      if (input.is_default || existingCount === 1) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { defaultSenderIdentityId: created.id },
        });
      }

      await this.audit.recordIn(tx, {
        organisationId: workspace.organisationId,
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'sender_identity.created',
        resourceType: 'sender_identity',
        resourceId: created.id,
        after: { from_name: created.fromName, from_email: created.fromEmail },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return {
      id: identity.id,
      from_name: identity.fromName,
      from_email: identity.fromEmail,
      reply_to_email: identity.replyToEmail,
      status: identity.status,
      is_default: input.is_default ?? false,
      verified_at: identity.verifiedAt?.toISOString() ?? null,
      created_at: identity.createdAt.toISOString(),
    };
  }

  async setDefault(ctx: RequestContext, workspaceId: string, identityId: string): Promise<void> {
    const exists = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.senderIdentity.count({ where: { id: identityId, workspaceId, status: 'verified' } }),
    );
    if (!exists) throw notFound('Sender identity', identityId);

    await this.prisma.asSystem((tx) =>
      tx.workspace.update({
        where: { id: workspaceId },
        data: { defaultSenderIdentityId: identityId },
      }),
    );

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'workspace.default_sender_changed',
      resourceType: 'sender_identity',
      resourceId: identityId,
      requestId: ctx.requestId,
    });
  }

  async remove(ctx: RequestContext, workspaceId: string, identityId: string): Promise<void> {
    const result = await this.prisma.asSystem(async (tx) => {
      const deleted = await tx.senderIdentity.deleteMany({ where: { id: identityId, workspaceId } });

      // Clearing the pointer keeps the workspace from referencing a row that no
      // longer exists.
      await tx.workspace.updateMany({
        where: { id: workspaceId, defaultSenderIdentityId: identityId },
        data: { defaultSenderIdentityId: null },
      });

      return deleted;
    });

    if (result.count === 0) throw notFound('Sender identity', identityId);

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'sender_identity.deleted',
      resourceType: 'sender_identity',
      resourceId: identityId,
      requestId: ctx.requestId,
    });
  }

  private async requireWorkspace(workspaceId: string) {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: {
          id: true,
          organisationId: true,
          emailConfigurationId: true,
          defaultSenderIdentityId: true,
        },
      }),
    );
    if (!workspace) throw notFound('Site', workspaceId);
    return workspace;
  }
}
