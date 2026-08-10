import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { invalid, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';
import type { ApiKeyAuthContext } from './api-keys.service';

export interface SubscriberInput {
  email: string;
  first_name?: string;
  last_name?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  list_api_ids?: string[];
  source?: string;
}

export interface SubscriberPatchInput {
  first_name?: string | null;
  last_name?: string | null;
  attributes?: Record<string, unknown>;
  tags?: string[];
  list_api_ids?: string[];
}

export interface FormSubmissionInput {
  email?: string;
  first_name?: string;
  last_name?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  payload?: Record<string, unknown>;
}

@Injectable()
export class DeliveryAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertSubscriber(key: ApiKeyAuthContext, input: SubscriberInput) {
    const email = normaliseEmail(input.email);
    await this.upsertSubscriberRecord(key.workspaceId, {
      ...input,
      email,
      source: input.source ?? 'delivery_api',
    });
    return this.getSubscriberByEmail(key, email);
  }

  async getSubscriberByEmail(key: ApiKeyAuthContext, emailValue: string) {
    const email = normaliseEmail(emailValue);
    const subscriber = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.subscriber.findFirst({
        where: { workspaceId: key.workspaceId, email, deletedAt: null },
        include: { memberships: { include: { list: true } } },
      }),
    );
    if (!subscriber) throw notFound('Subscriber', email);
    return this.toSubscriberDto(subscriber);
  }

  async updateSubscriber(key: ApiKeyAuthContext, emailValue: string, input: SubscriberPatchInput) {
    const email = normaliseEmail(emailValue);
    const existing = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.subscriber.findFirst({
        where: { workspaceId: key.workspaceId, email, deletedAt: null },
        select: { id: true, attributes: true },
      }),
    );
    if (!existing) throw notFound('Subscriber', email);

    await this.prisma.withWorkspaceScope(key.workspaceId, async (tx) => {
      const attributes =
        input.attributes === undefined
          ? undefined
          : mergeObjects(existing.attributes, input.attributes);

      await tx.subscriber.update({
        where: { id: existing.id },
        data: {
          ...(input.first_name !== undefined ? { firstName: input.first_name } : {}),
          ...(input.last_name !== undefined ? { lastName: input.last_name } : {}),
          ...(attributes !== undefined ? { attributes: jsonInput(attributes) } : {}),
          ...(input.tags !== undefined ? { tags: unique(input.tags.map(cleanToken)) } : {}),
        },
      });

      await this.replaceListMemberships(tx, key.workspaceId, existing.id, input.list_api_ids);
    });

    return this.getSubscriberByEmail(key, email);
  }

  async unsubscribe(key: ApiKeyAuthContext, emailValue: string) {
    const email = normaliseEmail(emailValue);
    const now = new Date();
    const subscriberId = await this.prisma.withWorkspaceScope(key.workspaceId, async (tx) => {
      const existing = await tx.subscriber.findFirst({
        where: { workspaceId: key.workspaceId, email, deletedAt: null },
        select: { id: true },
      });

      const subscriber = existing
        ? await tx.subscriber.update({
            where: { id: existing.id },
            data: { status: 'unsubscribed', unsubscribedAt: now },
          })
        : await tx.subscriber.create({
            data: {
              id: newId(),
              workspaceId: key.workspaceId,
              email,
              status: 'unsubscribed',
              unsubscribedAt: now,
              source: 'delivery_api_unsubscribe',
            },
          });

      await tx.subscriberListMembership.updateMany({
        where: { workspaceId: key.workspaceId, subscriberId: subscriber.id, unsubscribedAt: null },
        data: { unsubscribedAt: now },
      });

      return subscriber.id;
    });

    const subscriber = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.subscriber.findFirst({
        where: { id: subscriberId, workspaceId: key.workspaceId },
        include: { memberships: { include: { list: true } } },
      }),
    );
    return this.toSubscriberDto(subscriber!);
  }

  async listLists(key: ApiKeyAuthContext) {
    const lists = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.audienceList.findMany({
        where: { workspaceId: key.workspaceId, deletedAt: null },
        include: {
          _count: {
            select: { memberships: { where: { unsubscribedAt: null, subscriber: { deletedAt: null } } } },
          },
        },
        orderBy: { name: 'asc' },
      }),
    );

    return lists.map((list) => ({
      id: list.id,
      name: list.name,
      api_id: list.apiId,
      description: list.description,
      subscriber_count: list._count.memberships,
      created_at: list.createdAt.toISOString(),
      updated_at: list.updatedAt.toISOString(),
    }));
  }

  async getForm(key: ApiKeyAuthContext, apiId: string) {
    const form = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.form.findFirst({
        where: { workspaceId: key.workspaceId, apiId, deletedAt: null, isEnabled: true },
        include: { list: true },
      }),
    );

    if (!form) throw notFound('Form', apiId);
    return this.toFormDto(form);
  }

  async submitForm(
    key: ApiKeyAuthContext,
    apiId: string,
    input: FormSubmissionInput,
    request: { ip?: string | null; userAgent?: string | null; referrer?: string | null },
  ) {
    const form = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.form.findFirst({
        where: { workspaceId: key.workspaceId, apiId, deletedAt: null, isEnabled: true },
        include: { list: true },
      }),
    );
    if (!form) throw notFound('Form', apiId);

    const email = normaliseEmail(input.email ?? stringValue(input.payload?.email));
    const subscriber = await this.upsertSubscriberRecord(key.workspaceId, {
      email,
      first_name: input.first_name ?? stringValue(input.payload?.first_name),
      last_name: input.last_name ?? stringValue(input.payload?.last_name),
      attributes: input.attributes,
      tags: input.tags,
      list_api_ids: form.list ? [form.list.apiId] : undefined,
      source: `form:${form.apiId}`,
    });

    const submission = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.formSubmission.create({
        data: {
          id: newId(),
          workspaceId: key.workspaceId,
          formId: form.id,
          subscriberId: subscriber.id,
          email,
          payload: jsonInput(input.payload ?? {}),
          ip: request.ip ? normaliseIp(request.ip) : null,
          userAgent: request.userAgent ?? null,
          referrer: request.referrer ?? null,
        },
      }),
    );

    return {
      submission: {
        id: submission.id,
        form_id: submission.formId,
        subscriber_id: submission.subscriberId,
        created_at: submission.createdAt.toISOString(),
      },
      subscriber: await this.getSubscriberByEmail(key, email),
      message: form.successMessage,
    };
  }

  private async upsertSubscriberRecord(workspaceId: string, input: SubscriberInput) {
    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const existing = await tx.subscriber.findFirst({
        where: { workspaceId, email: input.email, deletedAt: null },
        select: { id: true, attributes: true },
      });
      const now = new Date();
      const tags = input.tags ? unique(input.tags.map(cleanToken)) : undefined;
      const attributes =
        input.attributes === undefined
          ? undefined
          : mergeObjects(existing?.attributes ?? {}, input.attributes);

      const subscriber = existing
        ? await tx.subscriber.update({
            where: { id: existing.id },
            data: {
              status: 'subscribed',
              unsubscribedAt: null,
              ...(input.first_name !== undefined ? { firstName: input.first_name } : {}),
              ...(input.last_name !== undefined ? { lastName: input.last_name } : {}),
              ...(attributes !== undefined ? { attributes: jsonInput(attributes) } : {}),
              ...(tags !== undefined ? { tags } : {}),
              ...(input.source !== undefined ? { source: input.source } : {}),
              consentAt: now,
            },
          })
        : await tx.subscriber.create({
            data: {
              id: newId(),
              workspaceId,
              email: input.email,
              firstName: input.first_name ?? null,
              lastName: input.last_name ?? null,
              attributes: jsonInput(input.attributes ?? {}),
              tags: tags ?? [],
              source: input.source ?? null,
              consentAt: now,
            },
          });

      await this.replaceListMemberships(tx, workspaceId, subscriber.id, input.list_api_ids);
      return subscriber;
    });
  }

  private async replaceListMemberships(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    subscriberId: string,
    listApiIds?: string[],
  ): Promise<void> {
    if (listApiIds === undefined) return;

    const apiIds = unique(listApiIds.map(cleanToken));
    const lists = apiIds.length
      ? await tx.audienceList.findMany({
          where: { workspaceId, apiId: { in: apiIds }, deletedAt: null },
          select: { id: true, apiId: true },
        })
      : [];

    if (lists.length !== apiIds.length) {
      const found = new Set(lists.map((list) => list.apiId));
      const missing = apiIds.filter((apiId) => !found.has(apiId));
      throw invalid('One or more lists do not exist.', `Unknown list API IDs: ${missing.join(', ')}.`);
    }

    const now = new Date();
    await tx.subscriberListMembership.updateMany({
      where: {
        workspaceId,
        subscriberId,
        ...(lists.length ? { listId: { notIn: lists.map((list) => list.id) } } : {}),
        unsubscribedAt: null,
      },
      data: { unsubscribedAt: now },
    });

    for (const list of lists) {
      await tx.subscriberListMembership.upsert({
        where: { subscriberId_listId: { subscriberId, listId: list.id } },
        create: { workspaceId, subscriberId, listId: list.id },
        update: { unsubscribedAt: null, subscribedAt: now },
      });
    }
  }

  private toSubscriberDto(subscriber: {
    id: string;
    email: string;
    status: string;
    firstName: string | null;
    lastName: string | null;
    attributes: unknown;
    tags: string[];
    source: string | null;
    consentAt: Date | null;
    unsubscribedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    memberships: Array<{
      unsubscribedAt: Date | null;
      list: { id: string; name: string; apiId: string; deletedAt: Date | null };
    }>;
  }) {
    return {
      id: subscriber.id,
      email: subscriber.email,
      status: subscriber.status,
      first_name: subscriber.firstName,
      last_name: subscriber.lastName,
      attributes: subscriber.attributes,
      tags: subscriber.tags,
      source: subscriber.source,
      consent_at: subscriber.consentAt?.toISOString() ?? null,
      unsubscribed_at: subscriber.unsubscribedAt?.toISOString() ?? null,
      lists: subscriber.memberships
        .filter((membership) => !membership.unsubscribedAt && !membership.list.deletedAt)
        .map((membership) => ({
          id: membership.list.id,
          name: membership.list.name,
          api_id: membership.list.apiId,
        })),
      created_at: subscriber.createdAt.toISOString(),
      updated_at: subscriber.updatedAt.toISOString(),
    };
  }

  private toFormDto(form: {
    id: string;
    name: string;
    apiId: string;
    description: string | null;
    schema: unknown;
    successMessage: string;
    updatedAt: Date;
    list: { id: string; name: string; apiId: string } | null;
  }) {
    return {
      id: form.id,
      name: form.name,
      api_id: form.apiId,
      description: form.description,
      schema: form.schema,
      success_message: form.successMessage,
      list: form.list
        ? { id: form.list.id, name: form.list.name, api_id: form.list.apiId }
        : null,
      updated_at: form.updatedAt.toISOString(),
    };
  }
}

function normaliseEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid('A valid email address is required.');
  }
  return email;
}

function cleanToken(value: string): string {
  return value.trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergeObjects(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...patch };
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normaliseIp(value: string): string {
  return value.replace(/^::ffff:/, '');
}
