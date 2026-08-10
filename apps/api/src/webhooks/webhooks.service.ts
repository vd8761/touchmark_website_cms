import { createHmac, randomBytes } from 'node:crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { conflict, invalid, notFound } from '../common/errors';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { JOB_NAMES } from '../jobs/job-names';
import { JobQueueService } from '../jobs/job-queue.service';

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];
const MAX_ATTEMPTS = 8;
const AUTO_DISABLE_FAILURES = 15;

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerRecurring(JOB_NAMES.webhookDeliver, 60_000, async () => {
      await this.enqueuePendingDomainEvents();
      return this.dispatchPending();
    });
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.webhookEndpoint.findMany({
        where: { workspaceId, deletedAt: null },
        include: { _count: { select: { deliveries: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((row) => this.toEndpointDto(row, row._count.deliveries));
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    input: { name: string; url: string; events?: string[] },
  ) {
    const url = normaliseWebhookUrl(input.url);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const events = normaliseEvents(input.events);

    const created = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const row = await tx.webhookEndpoint.create({
        data: {
          id: newId(),
          workspaceId,
          name: input.name.trim(),
          url,
          events,
          secretCiphertext: this.crypto.encrypt(secret),
          secretLastFour: secret.slice(-4),
          createdBy: ctx.userId,
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'webhook.created',
        resourceType: 'webhook',
        resourceId: row.id,
        after: { name: row.name, url, events },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return row;
    });

    return {
      ...this.toEndpointDto(created, 0),
      signing_secret: secret,
      signing_secret_notice: 'Copy this secret now. It is not shown again.',
    };
  }

  async remove(ctx: RequestContext, workspaceId: string, webhookId: string): Promise<void> {
    const current = await this.requireEndpoint(workspaceId, webhookId);
    await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      await tx.webhookEndpoint.update({
        where: { id: current.id },
        data: { deletedAt: new Date(), status: 'disabled' },
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'webhook.deleted',
        resourceType: 'webhook',
        resourceId: current.id,
        before: { name: current.name, url: current.url },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  async listDeliveries(workspaceId: string, webhookId: string) {
    await this.requireEndpoint(workspaceId, webhookId);
    const rows = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.webhookDelivery.findMany({
        where: { workspaceId, webhookId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return rows.map((row) => this.toDeliveryDto(row));
  }

  async sendTest(ctx: RequestContext, workspaceId: string, webhookId: string) {
    const endpoint = await this.requireEndpoint(workspaceId, webhookId);
    if (endpoint.status !== 'active') throw conflict('That webhook is disabled.');

    const delivery = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.webhookDelivery.create({
        data: {
          id: newId(),
          workspaceId,
          webhookId,
          eventId: newId(),
          eventType: 'webhook.test',
          payload: { test: true, sent_by: ctx.userId } as Prisma.InputJsonValue,
          nextAttemptAt: new Date(),
        },
      }),
    );
    await this.jobs.enqueue(JOB_NAMES.webhookDeliver);
    return this.toDeliveryDto(delivery);
  }

  async replay(ctx: RequestContext, workspaceId: string, deliveryId: string) {
    const original = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.webhookDelivery.findFirst({
        where: { id: deliveryId, workspaceId },
        include: { webhook: true },
      }),
    );
    if (!original || original.webhook.deletedAt) throw notFound('Webhook delivery', deliveryId);
    if (original.webhook.status !== 'active') throw conflict('That webhook is disabled.');

    const replay = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const row = await tx.webhookDelivery.create({
        data: {
          id: newId(),
          workspaceId,
          webhookId: original.webhookId,
          eventId: original.eventId,
          eventType: original.eventType,
          payload: original.payload as Prisma.InputJsonValue,
          nextAttemptAt: new Date(),
        },
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'webhook.replayed',
        resourceType: 'webhook_delivery',
        resourceId: row.id,
        after: { original_delivery_id: original.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return row;
    });

    await this.jobs.enqueue(JOB_NAMES.webhookDeliver);
    return this.toDeliveryDto(replay);
  }

  async enqueuePendingDomainEvents(limit = 100): Promise<number> {
    return this.prisma.asSystem(async (tx) => {
      const events = await tx.domainEvent.findMany({
        where: { workspaceId: { not: null }, publishedAt: null },
        orderBy: { occurredAt: 'asc' },
        take: limit,
      });

      let queued = 0;
      for (const event of events) {
        if (!event.workspaceId) continue;
        const endpoints = await tx.webhookEndpoint.findMany({
          where: {
            workspaceId: event.workspaceId,
            deletedAt: null,
            status: 'active',
            OR: [{ events: { has: event.type } }, { events: { has: '*' } }],
          },
          select: { id: true },
        });

        for (const endpoint of endpoints) {
          await tx.webhookDelivery.create({
            data: {
              id: newId(),
              workspaceId: event.workspaceId,
              webhookId: endpoint.id,
              eventId: event.id,
              eventType: event.type,
              payload: event.payload as Prisma.InputJsonValue,
              nextAttemptAt: new Date(),
            },
          });
          queued += 1;
        }

        await tx.domainEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });
      }

      return queued;
    });
  }

  async dispatchPending(limit = 25): Promise<{ attempted: number; delivered: number }> {
    const deliveries = await this.prisma.asSystem((tx) =>
      tx.webhookDelivery.findMany({
        where: {
          status: 'pending',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
          webhook: { status: 'active', deletedAt: null },
        },
        include: { webhook: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    );

    let delivered = 0;
    for (const delivery of deliveries) {
      // One endpoint must never be able to stop every other endpoint. Anything
      // thrown before the per-delivery try/catch — a signing secret that no
      // longer decrypts is the realistic case, after ENCRYPTION_KEYS or the
      // JWT_SECRET it falls back to has changed — would otherwise escape this
      // loop and fail the recurring job, silently halting delivery platform-wide
      // for every workspace. Route it through the same failure path as an HTTP
      // error so it backs off and eventually disables that endpoint alone.
      try {
        if (await this.dispatchDelivery(delivery)) delivered += 1;
      } catch (error) {
        await this.markFailed(delivery, (error as Error).message).catch(() => undefined);
      }
    }

    return { attempted: deliveries.length, delivered };
  }

  private async dispatchDelivery(delivery: {
    id: string;
    workspaceId: string;
    eventId: string;
    eventType: string;
    payload: unknown;
    attempt: number;
    createdAt: Date;
    webhook: {
      id: string;
      url: string;
      secretCiphertext: string;
      consecutiveFailures: number;
    };
  }): Promise<boolean> {
    const secret = this.crypto.decrypt(delivery.webhook.secretCiphertext);
    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      created_at: delivery.createdAt.toISOString(),
      payload: delivery.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'cms-platform-webhooks/1.0',
      'X-Event-Id': delivery.eventId,
      'X-Event-Type': delivery.eventType,
      'X-Signature': `t=${timestamp},v1=${signature}`,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(delivery.webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = (await response.text()).slice(0, 4096);
      if (response.status >= 200 && response.status < 300) {
        await this.markDelivered(delivery, response.status, text);
        return true;
      }

      await this.markFailed(delivery, `HTTP ${response.status}`, response.status, text);
      return false;
    } catch (error) {
      await this.markFailed(delivery, (error as Error).message);
      return false;
    }
  }

  private async markDelivered(
    delivery: { id: string; workspaceId: string; webhook: { id: string } },
    status: number,
    responseBody: string,
  ): Promise<void> {
    await this.prisma.asSystem(async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          attempt: { increment: 1 },
          deliveredAt: new Date(),
          responseStatus: status,
          responseBody,
          error: null,
        },
      });
      await tx.webhookEndpoint.update({
        where: { id: delivery.webhook.id },
        data: { consecutiveFailures: 0, lastSuccessAt: new Date() },
      });
    });
  }

  private async markFailed(
    delivery: {
      id: string;
      attempt: number;
      webhook: { id: string; consecutiveFailures: number };
    },
    error: string,
    responseStatus?: number,
    responseBody?: string,
  ): Promise<void> {
    const nextAttempt = delivery.attempt + 1;
    const dead = nextAttempt >= MAX_ATTEMPTS;
    const nextFailureCount = delivery.webhook.consecutiveFailures + 1;
    const delay = RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RETRY_DELAYS_MS.length - 1)];

    await this.prisma.asSystem(async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: dead ? 'dead_lettered' : 'pending',
          attempt: nextAttempt,
          nextAttemptAt: dead ? null : new Date(Date.now() + delay),
          responseStatus: responseStatus ?? null,
          responseBody: responseBody ?? null,
          error,
        },
      });
      await tx.webhookEndpoint.update({
        where: { id: delivery.webhook.id },
        data: {
          consecutiveFailures: nextFailureCount,
          lastFailureAt: new Date(),
          ...(nextFailureCount >= AUTO_DISABLE_FAILURES ? { status: 'disabled' } : {}),
        },
      });
    });
  }

  private async requireEndpoint(workspaceId: string, webhookId: string) {
    const endpoint = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.webhookEndpoint.findFirst({
        where: { id: webhookId, workspaceId, deletedAt: null },
      }),
    );
    if (!endpoint) throw notFound('Webhook', webhookId);
    return endpoint;
  }

  private toEndpointDto(
    endpoint: {
      id: string;
      name: string;
      url: string;
      events: string[];
      secretLastFour: string;
      status: string;
      consecutiveFailures: number;
      lastSuccessAt: Date | null;
      lastFailureAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    deliveryCount?: number,
  ) {
    return {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      events: endpoint.events,
      signing_secret_last_four: endpoint.secretLastFour,
      status: endpoint.status,
      consecutive_failures: endpoint.consecutiveFailures,
      last_success_at: endpoint.lastSuccessAt?.toISOString() ?? null,
      last_failure_at: endpoint.lastFailureAt?.toISOString() ?? null,
      delivery_count: deliveryCount,
      created_at: endpoint.createdAt.toISOString(),
      updated_at: endpoint.updatedAt.toISOString(),
    };
  }

  private toDeliveryDto(delivery: {
    id: string;
    webhookId: string;
    eventId: string;
    eventType: string;
    payload: unknown;
    status: string;
    attempt: number;
    nextAttemptAt: Date | null;
    deliveredAt: Date | null;
    responseStatus: number | null;
    responseBody: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: delivery.id,
      webhook_id: delivery.webhookId,
      event_id: delivery.eventId,
      event_type: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      attempt: delivery.attempt,
      next_attempt_at: delivery.nextAttemptAt?.toISOString() ?? null,
      delivered_at: delivery.deliveredAt?.toISOString() ?? null,
      response_status: delivery.responseStatus,
      response_body: delivery.responseBody,
      error: delivery.error,
      created_at: delivery.createdAt.toISOString(),
      updated_at: delivery.updatedAt.toISOString(),
    };
  }
}

function normaliseWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid('Webhook URL must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw invalid('Webhook URL must use http or https.');
  }
  return url.toString();
}

function normaliseEvents(events?: string[]): string[] {
  const values = [...new Set((events?.length ? events : ['*']).map((event) => event.trim()))].filter(Boolean);
  if (!values.length) throw invalid('At least one event is required.');
  return values;
}
