import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { ResendApiError, ResendClient, type ResendDomain } from './resend.client';

@Injectable()
export class EmailConfigService {
  private readonly logger = new Logger(EmailConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // -- Organisation-level configurations -------------------------------------

  async list(orgId: string) {
    const configs = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findMany({
        where: { organisationId: orgId, deletedAt: null },
        include: { _count: { select: { workspaces: true, senderIdentities: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return configs.map((config) => this.toDto(config, config._count));
  }

  async create(
    ctx: RequestContext,
    orgId: string,
    input: { name: string; api_key: string },
  ) {
    const existing = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.count({
        where: { organisationId: orgId, name: input.name.trim(), deletedAt: null },
      }),
    );
    if (existing) conflictName(input.name);

    // Validate before storing. A configuration that was never usable should
    // never reach the site-level dropdown looking ready.
    const domains = await this.validateKey(input.api_key);

    const config = await this.prisma.asSystem(async (tx) => {
      const created = await tx.emailConfiguration.create({
        data: {
          id: newId(),
          organisationId: orgId,
          name: input.name.trim(),
          provider: 'resend',
          apiKeyCiphertext: this.crypto.encrypt(input.api_key),
          apiKeyLastFour: input.api_key.slice(-4),
          // Each configuration gets its own signing secret, so revoking one
          // does not disturb the others.
          webhookSecret: `whsec_${randomBytes(24).toString('base64')}`,
          status: 'active',
          verifiedDomains: domains as unknown as object,
          lastVerifiedAt: new Date(),
          createdBy: ctx.userId,
        },
        include: { _count: { select: { workspaces: true, senderIdentities: true } } },
      });

      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'email_configuration.created',
        resourceType: 'email_configuration',
        resourceId: created.id,
        // The key is redacted by AuditService, but it is not passed in at all.
        after: { name: created.name, provider: 'resend', last_four: created.apiKeyLastFour },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return this.toDto(config, config._count);
  }

  async update(
    ctx: RequestContext,
    orgId: string,
    configId: string,
    patch: { name?: string; api_key?: string; disabled?: boolean },
  ) {
    const before = await this.require(orgId, configId);

    let ciphertext: string | undefined;
    let lastFour: string | undefined;
    let domains: ResendDomain[] | undefined;

    if (patch.api_key) {
      domains = await this.validateKey(patch.api_key);
      ciphertext = this.crypto.encrypt(patch.api_key);
      lastFour = patch.api_key.slice(-4);
    }

    const updated = await this.prisma.asSystem(async (tx) => {
      const config = await tx.emailConfiguration.update({
        where: { id: configId },
        data: {
          name: patch.name?.trim() ?? undefined,
          apiKeyCiphertext: ciphertext,
          apiKeyLastFour: lastFour,
          verifiedDomains: domains ? (domains as unknown as object) : undefined,
          lastVerifiedAt: domains ? new Date() : undefined,
          status:
            patch.disabled === undefined
              ? domains
                ? 'active'
                : undefined
              : patch.disabled
                ? 'disabled'
                : 'active',
        },
        include: { _count: { select: { workspaces: true, senderIdentities: true } } },
      });

      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: patch.api_key ? 'email_configuration.key_rotated' : 'email_configuration.updated',
        resourceType: 'email_configuration',
        resourceId: configId,
        before: { name: before.name, status: before.status, last_four: before.apiKeyLastFour },
        after: { name: config.name, status: config.status, last_four: config.apiKeyLastFour },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return config;
    });

    return this.toDto(updated, updated._count);
  }

  async remove(ctx: RequestContext, orgId: string, configId: string): Promise<void> {
    const config = await this.require(orgId, configId);

    const attached = await this.prisma.asSystem((tx) =>
      tx.workspace.count({ where: { emailConfigurationId: configId, deletedAt: null } }),
    );

    // Deleting a configuration silently stops every site using it from sending.
    // Making the caller detach them first turns a surprise outage into a
    // deliberate decision.
    if (attached > 0) {
      throw new AppError('conflict', 'This configuration is still in use.', {
        detail:
          `${attached} site${attached === 1 ? '' : 's'} currently send through "${config.name}". ` +
          'Switch them to another configuration first, or detach them in Site settings → Email.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.emailConfiguration.update({
        where: { id: configId },
        data: { deletedAt: new Date(), status: 'disabled' },
      });

      await this.audit.recordIn(tx, {
        organisationId: orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'email_configuration.deleted',
        resourceType: 'email_configuration',
        resourceId: configId,
        before: { name: config.name },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  /** Re-checks the stored key against Resend and refreshes the cached domains. */
  async refresh(orgId: string, configId: string) {
    const config = await this.require(orgId, configId);

    try {
      const domains = await this.validateKey(this.crypto.decrypt(config.apiKeyCiphertext));

      const updated = await this.prisma.asSystem((tx) =>
        tx.emailConfiguration.update({
          where: { id: configId },
          data: {
            status: 'active',
            statusDetail: null,
            verifiedDomains: domains as unknown as object,
            lastVerifiedAt: new Date(),
          },
          include: { _count: { select: { workspaces: true, senderIdentities: true } } },
        }),
      );

      return this.toDto(updated, updated._count);
    } catch (error) {
      // A revoked key is recorded so the UI can explain why sending stopped,
      // rather than leaving the configuration looking healthy.
      if (error instanceof AppError && error.code === 'unprocessable') {
        const updated = await this.prisma.asSystem((tx) =>
          tx.emailConfiguration.update({
            where: { id: configId },
            data: { status: 'invalid', statusDetail: error.detail ?? error.message },
            include: { _count: { select: { workspaces: true, senderIdentities: true } } },
          }),
        );
        return this.toDto(updated, updated._count);
      }
      throw error;
    }
  }

  /** The decrypted client for a configuration. The only place keys are read. */
  async clientFor(configId: string): Promise<ResendClient> {
    const config = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findFirst({
        where: { id: configId, deletedAt: null },
        select: { apiKeyCiphertext: true, status: true, name: true },
      }),
    );

    if (!config) throw notFound('Email configuration', configId);
    if (config.status === 'disabled') {
      throw new AppError('unprocessable', `The email configuration "${config.name}" is disabled.`);
    }

    return new ResendClient(this.crypto.decrypt(config.apiKeyCiphertext));
  }

  // -- helpers ---------------------------------------------------------------

  private async validateKey(apiKey: string): Promise<ResendDomain[]> {
    try {
      return await new ResendClient(apiKey).listDomains();
    } catch (error) {
      if (error instanceof ResendApiError && error.isCredentialError) {
        throw new AppError('unprocessable', 'Resend rejected that API key.', {
          detail:
            'Check the key in your Resend dashboard under API Keys. It needs at least sending ' +
            'and domain-read access.',
        });
      }
      if (error instanceof ResendApiError && error.status === 503) {
        throw new AppError('service_unavailable', 'Could not reach Resend to verify the key.', {
          detail: 'Resend may be having an outage. Nothing was saved — try again shortly.',
        });
      }
      throw new AppError('unprocessable', 'Could not verify that API key with Resend.', {
        detail: (error as Error).message,
      });
    }
  }

  private async require(orgId: string, configId: string) {
    const config = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findFirst({
        where: { id: configId, organisationId: orgId, deletedAt: null },
      }),
    );
    if (!config) throw notFound('Email configuration', configId);
    return config;
  }

  /** Never includes the key or the webhook secret — see the webhook endpoint for those. */
  private toDto(
    config: {
      id: string;
      name: string;
      provider: string;
      apiKeyLastFour: string;
      status: string;
      statusDetail: string | null;
      verifiedDomains: unknown;
      lastVerifiedAt: Date | null;
      webhookLastEventAt: Date | null;
      webhookEventCount: number;
      createdAt: Date;
    },
    counts?: { workspaces: number; senderIdentities: number },
  ) {
    const domains = parseDomains(config.verifiedDomains);

    return {
      id: config.id,
      name: config.name,
      provider: config.provider,
      api_key_last_four: config.apiKeyLastFour,
      status: config.status,
      status_detail: config.statusDetail,
      domains: domains.map((d) => ({ name: d.name, status: d.status })),
      verified_domains: domains.filter(isVerified).map((d) => d.name),
      last_verified_at: config.lastVerifiedAt?.toISOString() ?? null,
      webhook_url: `/webhooks/email/${config.id}`,
      webhook_last_event_at: config.webhookLastEventAt?.toISOString() ?? null,
      webhook_event_count: config.webhookEventCount,
      sites_using: counts?.workspaces ?? 0,
      sender_identities: counts?.senderIdentities ?? 0,
      created_at: config.createdAt.toISOString(),
    };
  }
}

export function isVerified(domain: ResendDomain): boolean {
  return domain.status === 'verified';
}

/**
 * Reads the cached domain list out of the jsonb column.
 *
 * Prisma types jsonb as `JsonValue`, so this is the one place the narrowing
 * happens — and it tolerates a malformed value rather than throwing, because
 * the column is a *cache* of Resend's state. A bad cache should degrade to
 * "no verified domains" and be fixed by a refresh, not break the settings page.
 */
export function parseDomains(value: unknown): ResendDomain[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ResendDomain =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as ResendDomain).name === 'string' &&
      typeof (entry as ResendDomain).status === 'string',
  );
}

function conflictName(name: string): never {
  throw conflict(
    'An email configuration with that name already exists.',
    `"${name}" is already used in this organisation. Names appear in the site-level dropdown, ` +
      'so they need to be distinguishable.',
  );
}
