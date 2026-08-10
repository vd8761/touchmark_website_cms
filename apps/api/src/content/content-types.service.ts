import { Injectable } from '@nestjs/common';
import { Prisma, type FieldType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { isSafeTypeChange, safeTargetsFor } from './field-validation';

const API_ID = /^[a-z][a-z0-9_]*$/;

/**
 * The content type builder (§7.1).
 *
 * Most of this file is the schema-change safety table, because — as the spec
 * puts it — "Changes to a live schema are the most dangerous operation in a
 * CMS." Every rule here exists to stop a change that silently breaks a
 * customer's live website.
 */
@Injectable()
export class ContentTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const types = await tx.contentType.findMany({
        where: { workspaceId, deletedAt: null },
        include: {
          fields: { orderBy: { position: 'asc' } },
          _count: { select: { entries: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      return types.map((type) => this.toDto(type, type.fields, type._count.entries));
    });
  }

  async get(workspaceId: string, idOrApiId: string) {
    const type = await this.requireType(workspaceId, idOrApiId);
    return this.toDto(type, type.fields, undefined);
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    input: {
      name: string;
      api_id?: string;
      description?: string;
      kind?: 'collection' | 'single';
      icon?: string;
      is_localised?: boolean;
      enable_versioning?: boolean;
      enable_scheduling?: boolean;
      require_review?: boolean;
    },
  ) {
    const apiId = (input.api_id ?? toApiId(input.name)).trim();
    assertApiId(apiId, 'Content type');

    const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentType.count({ where: { workspaceId, apiId } }),
    );
    if (taken) {
      throw conflict(
        `A content type with the API ID "${apiId}" already exists.`,
        'API IDs are permanent and appear in every Delivery API URL, so they cannot be reused.',
      );
    }

    const type = await this.prisma.asSystem(async (tx) => {
      const created = await tx.contentType.create({
        data: {
          id: newId(),
          workspaceId,
          name: input.name.trim(),
          apiId,
          description: input.description ?? null,
          kind: input.kind ?? 'collection',
          icon: input.icon ?? null,
          // A single (e.g. Homepage) has exactly one entry and no listing, so a
          // slug would have nothing to disambiguate.
          hasSlug: (input.kind ?? 'collection') === 'collection',
          isLocalised: input.is_localised ?? false,
          enableVersioning: input.enable_versioning ?? true,
          enableScheduling: input.enable_scheduling ?? true,
          requireReview: input.require_review ?? false,
          createdBy: ctx.userId,
        },
        include: { fields: true },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_type.created',
        resourceType: 'content_type',
        resourceId: created.id,
        after: { name: created.name, api_id: created.apiId, kind: created.kind },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return this.toDto(type, [], 0);
  }

  async update(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    patch: Record<string, unknown>,
  ) {
    const before = await this.requireType(workspaceId, typeId);

    // §7.1: "Change API ID — No. Would break every consumer."
    if (patch.api_id && patch.api_id !== before.apiId) {
      throw new AppError('unprocessable', 'A content type’s API ID cannot be changed.', {
        detail:
          `Every site fetching /v1/content/${before.apiId} would break. Create a new type with ` +
          'the API ID you want and migrate the entries across.',
      });
    }

    const updated = await this.prisma.asSystem(async (tx) => {
      const type = await tx.contentType.update({
        where: { id: before.id },
        data: {
          name: (patch.name as string)?.trim() ?? undefined,
          description: (patch.description as string) ?? undefined,
          icon: (patch.icon as string) ?? undefined,
          isLocalised: (patch.is_localised as boolean) ?? undefined,
          enableVersioning: (patch.enable_versioning as boolean) ?? undefined,
          enableScheduling: (patch.enable_scheduling as boolean) ?? undefined,
          requireReview: (patch.require_review as boolean) ?? undefined,
          sortOrder: (patch.sort_order as number) ?? undefined,
          schemaVersion: { increment: 1 },
        },
        include: { fields: { orderBy: { position: 'asc' } } },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_type.updated',
        resourceType: 'content_type',
        resourceId: type.id,
        before: { name: before.name, require_review: before.requireReview },
        after: { name: type.name, require_review: type.requireReview },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return type;
    });

    return this.toDto(updated, updated.fields, undefined);
  }

  /**
   * §7.1: "Delete type — Blocked if entries exist unless 'delete all entries'
   * is explicitly confirmed by typing the type name."
   */
  async remove(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    options: { confirm_name?: string; delete_entries?: boolean },
  ): Promise<void> {
    const type = await this.requireType(workspaceId, typeId);

    const entryCount = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.count({ where: { workspaceId, contentTypeId: type.id, deletedAt: null } }),
    );

    if (entryCount > 0) {
      if (!options.delete_entries) {
        throw new AppError('conflict', `"${type.name}" still has ${entryCount} entries.`, {
          detail:
            'Deleting the type would delete them too. Confirm by passing delete_entries with the ' +
            'type name, or archive the entries first.',
        });
      }
      if (options.confirm_name?.trim() !== type.name) {
        throw new AppError('invalid_request', 'The name you typed does not match.', {
          detail: `Type "${type.name}" exactly to confirm deleting it and its ${entryCount} entries.`,
        });
      }
    }

    await this.prisma.asSystem(async (tx) => {
      const now = new Date();
      await tx.contentEntry.updateMany({
        where: { contentTypeId: type.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.contentType.update({ where: { id: type.id }, data: { deletedAt: now } });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_type.deleted',
        resourceType: 'content_type',
        resourceId: type.id,
        before: { name: type.name, api_id: type.apiId, entries: entryCount },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    });
  }

  // -- Fields ----------------------------------------------------------------

  async addField(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    input: {
      name: string;
      api_id?: string;
      type: FieldType;
      required?: boolean;
      unique_value?: boolean;
      localised?: boolean;
      default_value?: unknown;
      help_text?: string;
      validation?: Record<string, unknown>;
      config?: Record<string, unknown>;
      group?: string;
    },
  ) {
    const type = await this.requireType(workspaceId, typeId);
    const apiId = (input.api_id ?? toApiId(input.name)).trim();
    assertApiId(apiId, 'Field');

    if (type.fields.some((f) => f.apiId === apiId)) {
      throw conflict(`A field with the API ID "${apiId}" already exists on ${type.name}.`);
    }

    // §7.1: "Add required field — Yes, with warning. Existing entries become
    // 'incomplete'." Reported back so the UI can show the warning of §17.6.
    let markedIncomplete = 0;

    const field = await this.prisma.asSystem(async (tx) => {
      const created = await tx.contentField.create({
        data: {
          id: newId(),
          workspaceId,
          contentTypeId: type.id,
          name: input.name.trim(),
          apiId,
          type: input.type,
          position: type.fields.length,
          required: input.required ?? false,
          uniqueValue: input.unique_value ?? false,
          localised: input.localised ?? false,
          defaultValue: (input.default_value ?? undefined) as Prisma.InputJsonValue | undefined,
          helpText: input.help_text ?? null,
          validation: (input.validation ?? {}) as Prisma.InputJsonValue,
          config: (input.config ?? {}) as Prisma.InputJsonValue,
          group: input.group ?? null,
        },
      });

      if (input.required && input.default_value === undefined) {
        const result = await tx.contentEntry.updateMany({
          where: { contentTypeId: type.id, deletedAt: null },
          data: { isIncomplete: true },
        });
        markedIncomplete = result.count;
      }

      await tx.contentType.update({
        where: { id: type.id },
        data: { schemaVersion: { increment: 1 } },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_field.created',
        resourceType: 'content_field',
        resourceId: created.id,
        after: { api_id: apiId, type: input.type, required: input.required ?? false },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return { ...fieldDto(field), entries_marked_incomplete: markedIncomplete };
  }

  async updateField(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    fieldId: string,
    patch: Record<string, unknown>,
  ) {
    const type = await this.requireType(workspaceId, typeId);
    const before = type.fields.find((f) => f.id === fieldId);
    if (!before) throw notFound('Field', fieldId);

    // §7.1: "Change API ID — No."
    if (patch.api_id && patch.api_id !== before.apiId) {
      throw new AppError('unprocessable', 'A field’s API ID cannot be changed.', {
        detail:
          `Consumers reading data.${before.apiId} would silently start receiving undefined. ` +
          'Create a new field and migrate the values instead.',
      });
    }

    // §7.1: field type changes are allowed only for safe widenings.
    if (patch.type && patch.type !== before.type) {
      const target = patch.type as FieldType;
      if (!isSafeTypeChange(before.type, target)) {
        const safe = safeTargetsFor(before.type);
        throw new AppError('unprocessable', `Cannot change ${before.name} to ${target}.`, {
          detail: safe.length
            ? `Existing values would become invalid. From ${before.type} you can safely widen to: ${safe.join(', ')}.`
            : `Existing values would become invalid. Create a new field of type ${target} and migrate.`,
        });
      }
    }

    const updated = await this.prisma.asSystem(async (tx) => {
      const field = await tx.contentField.update({
        where: { id: fieldId },
        data: {
          name: (patch.name as string)?.trim() ?? undefined,
          type: (patch.type as FieldType) ?? undefined,
          required: (patch.required as boolean) ?? undefined,
          uniqueValue: (patch.unique_value as boolean) ?? undefined,
          localised: (patch.localised as boolean) ?? undefined,
          helpText: (patch.help_text as string) ?? undefined,
          defaultValue: (patch.default_value ?? undefined) as Prisma.InputJsonValue | undefined,
          validation: (patch.validation ?? undefined) as Prisma.InputJsonValue | undefined,
          config: (patch.config ?? undefined) as Prisma.InputJsonValue | undefined,
          group: (patch.group as string) ?? undefined,
        },
      });

      await tx.contentType.update({
        where: { id: type.id },
        data: { schemaVersion: { increment: 1 } },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_field.updated',
        resourceType: 'content_field',
        resourceId: fieldId,
        before: { name: before.name, type: before.type, required: before.required },
        after: { name: field.name, type: field.type, required: field.required },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return field;
    });

    return fieldDto(updated);
  }

  /**
   * The pre-delete impact check of §7.1 and §17.6: "24 of 142 entries have a
   * value in this field."
   */
  async fieldImpact(workspaceId: string, typeId: string, fieldId: string) {
    const type = await this.requireType(workspaceId, typeId);
    const field = type.fields.find((f) => f.id === fieldId);
    if (!field) throw notFound('Field', fieldId);

    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const total = await tx.contentEntry.count({
        where: { workspaceId, contentTypeId: type.id, deletedAt: null },
      });

      // Counted in SQL rather than by loading every entry: a type with 100k
      // entries must not pull them all into memory to answer this.
      const [row] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count
        FROM content_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND content_type_id = ${type.id}::uuid
          AND deleted_at IS NULL
          AND data ? ${field.apiId}
          AND data -> ${field.apiId} <> 'null'::jsonb
      `;

      return {
        field_api_id: field.apiId,
        entries_with_value: Number(row?.count ?? 0),
        entries_total: total,
        recommendation: 'deprecate',
      };
    });
  }

  /**
   * §7.1: "Delete field — Yes, two-step. Field is first 'deprecated' (hidden
   * from the editor, still served by the API) for a configurable period; only
   * then hard-deleted."
   */
  async deprecateField(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    fieldId: string,
  ) {
    const type = await this.requireType(workspaceId, typeId);
    if (!type.fields.some((f) => f.id === fieldId)) throw notFound('Field', fieldId);

    const field = await this.prisma.asSystem(async (tx) => {
      const updated = await tx.contentField.update({
        where: { id: fieldId },
        data: { deprecatedAt: new Date(), required: false },
      });
      await tx.contentType.update({
        where: { id: type.id },
        data: { schemaVersion: { increment: 1 } },
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_field.deprecated',
        resourceType: 'content_field',
        resourceId: fieldId,
        after: { api_id: updated.apiId },
        requestId: ctx.requestId,
      });
      return updated;
    });

    return fieldDto(field);
  }

  async deleteField(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    fieldId: string,
    options: { force?: boolean },
  ): Promise<void> {
    const type = await this.requireType(workspaceId, typeId);
    const field = type.fields.find((f) => f.id === fieldId);
    if (!field) throw notFound('Field', fieldId);

    // Hard-deleting a field that consumers still read is the change most likely
    // to break a live site, so it requires going through deprecation first —
    // or an explicit override.
    if (!field.deprecatedAt && !options.force) {
      const impact = await this.fieldImpact(workspaceId, typeId, fieldId);
      throw new AppError('conflict', `"${field.name}" has not been deprecated yet.`, {
        detail:
          `${impact.entries_with_value} of ${impact.entries_total} entries have a value in this ` +
          'field, and sites may still be reading it. Deprecate it first — it stays in API ' +
          'responses while consumers migrate — or pass force to delete it now.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.contentField.delete({ where: { id: fieldId } });
      await tx.contentType.update({
        where: { id: type.id },
        data: { schemaVersion: { increment: 1 } },
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content_field.deleted',
        resourceType: 'content_field',
        resourceId: fieldId,
        before: { api_id: field.apiId, type: field.type },
        requestId: ctx.requestId,
      });
    });
  }

  async reorderFields(
    ctx: RequestContext,
    workspaceId: string,
    typeId: string,
    orderedIds: string[],
  ): Promise<void> {
    const type = await this.requireType(workspaceId, typeId);
    const known = new Set(type.fields.map((f) => f.id));

    if (orderedIds.length !== known.size || orderedIds.some((id) => !known.has(id))) {
      throw new AppError('invalid_request', 'The field order must list every field exactly once.', {
        detail: `Expected ${known.size} field ids, received ${orderedIds.length}.`,
      });
    }

    await this.prisma.asSystem(async (tx) => {
      for (const [position, id] of orderedIds.entries()) {
        await tx.contentField.update({ where: { id }, data: { position } });
      }
      await tx.contentType.update({
        where: { id: type.id },
        data: { schemaVersion: { increment: 1 } },
      });
    });

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'content_type.fields_reordered',
      resourceType: 'content_type',
      resourceId: type.id,
      requestId: ctx.requestId,
    });
  }

  // -- helpers ---------------------------------------------------------------

  /** Accepts either the uuid or the api_id, since both appear in URLs. */
  async requireType(workspaceId: string, idOrApiId: string) {
    const type = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentType.findFirst({
        where: {
          workspaceId,
          deletedAt: null,
          ...(isUuid(idOrApiId) ? { id: idOrApiId } : { apiId: idOrApiId }),
        },
        include: { fields: { orderBy: { position: 'asc' } } },
      }),
    );

    if (!type) throw notFound('Content type', idOrApiId);
    return type;
  }

  private toDto(
    type: {
      id: string;
      name: string;
      apiId: string;
      description: string | null;
      kind: string;
      icon: string | null;
      hasSlug: boolean;
      isLocalised: boolean;
      enableVersioning: boolean;
      enableScheduling: boolean;
      requireReview: boolean;
      sortOrder: number;
      schemaVersion: number;
      createdAt: Date;
    },
    fields: Parameters<typeof fieldDto>[0][],
    entryCount: number | undefined,
  ) {
    return {
      id: type.id,
      name: type.name,
      api_id: type.apiId,
      description: type.description,
      kind: type.kind,
      icon: type.icon,
      has_slug: type.hasSlug,
      is_localised: type.isLocalised,
      enable_versioning: type.enableVersioning,
      enable_scheduling: type.enableScheduling,
      require_review: type.requireReview,
      sort_order: type.sortOrder,
      schema_version: type.schemaVersion,
      entry_count: entryCount,
      fields: fields.map(fieldDto),
      created_at: type.createdAt.toISOString(),
    };
  }
}

export function fieldDto(field: {
  id: string;
  name: string;
  apiId: string;
  type: string;
  position: number;
  required: boolean;
  uniqueValue: boolean;
  localised: boolean;
  defaultValue: unknown;
  helpText: string | null;
  validation: unknown;
  config: unknown;
  group: string | null;
  deprecatedAt: Date | null;
}) {
  return {
    id: field.id,
    name: field.name,
    api_id: field.apiId,
    type: field.type,
    position: field.position,
    required: field.required,
    unique_value: field.uniqueValue,
    localised: field.localised,
    default_value: field.defaultValue,
    help_text: field.helpText,
    validation: field.validation,
    config: field.config,
    group: field.group,
    deprecated: field.deprecatedAt !== null,
  };
}

/** Appendix B: content type API IDs are singular snake_case. */
export function toApiId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1')
    .slice(0, 50);
}

function assertApiId(apiId: string, label: string): void {
  if (!API_ID.test(apiId)) {
    throw new AppError('validation_failed', `That ${label.toLowerCase()} API ID is not valid.`, {
      detail:
        'Use lowercase letters, numbers and underscores, starting with a letter — for example ' +
        '`blog_post`. It appears in API URLs and cannot be changed later.',
      fields: [{ field: 'api_id', code: 'pattern', message: 'Use snake_case, starting with a letter.' }],
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
