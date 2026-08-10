import { Injectable } from '@nestjs/common';
import { Prisma, type EntryStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { EventsService } from '../events/events.service';
import { authorize } from '../auth/authorize';
import { ContentTypesService } from './content-types.service';
import { CONTENT_SEARCH_VECTOR, toPrefixTsQuery } from './search-query';
import {
  type FieldDefinition,
  type FieldConfig,
  type FieldValidation,
  isEntryComplete,
  validateEntry,
} from './field-validation';

/** §5.2: soft edit lock, expiring after 10 minutes idle. */
const LOCK_TTL_MS = 10 * 60 * 1000;
/** Ceiling on the raw search pre-filter, so the id list can never blow up. */
const SEARCH_MATCH_LIMIT = 500;

/** A search whose terms all vanish (punctuation, stopwords) matches nothing. */
function emptyPage(limit: number) {
  return { items: [], meta: { total: 0, limit, has_more: false, next_cursor: null } };
}
/** §5.2: keep the last 50 versions per entry, plus every published version. */
const VERSION_RETENTION = 50;

@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly types: ContentTypesService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async list(
    workspaceId: string,
    typeRef: string,
    query: {
      status?: EntryStatus;
      locale?: string;
      search?: string;
      author_id?: string;
      limit?: number;
      cursor?: string;
      sort?: string;
    },
  ) {
    const type = await this.types.requireType(workspaceId, typeRef);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);

    const where: Prisma.ContentEntryWhereInput = {
      workspaceId,
      contentTypeId: type.id,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.locale ? { locale: query.locale } : {}),
      ...(query.author_id ? { authorId: query.author_id } : {}),
    };

    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      // Matching the field values, not just the slug.
      //
      // Prisma's typed `where` cannot express a tsquery match, so the search
      // runs as a raw pre-filter whose ids feed the normal query — which keeps
      // sorting, cursor pagination and the count working unchanged. Bounded,
      // because an unbounded IN list is its own problem.
      //
      // Unlike the Delivery search this covers drafts too: the editor needs to
      // find work in progress, which is most of what it is asked for.
      if (query.search) {
        const tsQuery = toPrefixTsQuery(query.search);
        if (!tsQuery) return emptyPage(limit);

        const matches = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
            FROM content_entries
           WHERE workspace_id = CAST(${workspaceId} AS uuid)
             AND content_type_id = CAST(${type.id} AS uuid)
             AND deleted_at IS NULL
             AND ${CONTENT_SEARCH_VECTOR} @@ to_tsquery('english'::regconfig, ${tsQuery})
           LIMIT ${SEARCH_MATCH_LIMIT}
        `);
        where.id = { in: matches.map((row) => row.id) };
      }

      const [rows, total] = await Promise.all([
        tx.contentEntry.findMany({
          where,
          orderBy: parseSort(query.sort),
          // Over-fetch by one to learn whether another page exists without a
          // second count query.
          take: limit + 1,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        }),
        tx.contentEntry.count({ where }),
      ]);

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;

      return {
        items: page.map((entry) => this.toDto(entry, type)),
        meta: {
          total,
          limit,
          has_more: hasMore,
          next_cursor: hasMore ? page[page.length - 1].id : null,
        },
      };
    });
  }

  async get(workspaceId: string, entryId: string) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);
    return this.toDto(entry, type);
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    typeRef: string,
    input: { slug?: string; locale?: string; data?: Record<string, unknown>; seo?: Record<string, unknown> },
  ) {
    const type = await this.types.requireType(workspaceId, typeRef);
    const fields = toFieldDefinitions(type.fields);

    // A single (e.g. Homepage) is exactly one entry by definition (§5.2).
    if (type.kind === 'single') {
      const existing = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        tx.contentEntry.count({ where: { workspaceId, contentTypeId: type.id, deletedAt: null } }),
      );
      if (existing > 0) {
        throw conflict(
          `${type.name} is a single and already has an entry.`,
          'Edit the existing entry instead, or change the type to a collection.',
        );
      }
    }

    const locale = input.locale ?? 'en';
    const result = validateEntry(fields, input.data ?? {}, { requireRequired: false });
    if (!result.valid) throw validationError(result.errors);

    const slug = type.hasSlug
      ? await this.uniqueSlug(workspaceId, type.id, locale, input.slug ?? deriveSlug(result.data, type.titleFieldId, type.fields))
      : null;

    const entry = await this.prisma.asSystem(async (tx) => {
      const created = await tx.contentEntry.create({
        data: {
          id: newId(),
          workspaceId,
          contentTypeId: type.id,
          slug,
          locale,
          translationGroupId: newId(),
          status: type.defaultStatus,
          data: result.data as Prisma.InputJsonValue,
          seo: (input.seo ?? {}) as Prisma.InputJsonValue,
          authorId: ctx.userId,
          lastEditedBy: ctx.userId,
          isIncomplete: !isEntryComplete(fields, result.data),
        },
      });

      await this.snapshot(tx, created, ctx.userId, 'Created');
      await this.syncMediaUsages(tx, workspaceId, created.id, fields, result.data);
      await this.events.emit(tx, 'content.created', { entry_id: created.id, type: type.apiId }, {
        workspaceId,
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.created',
        resourceType: 'content_entry',
        resourceId: created.id,
        after: { type: type.apiId, slug, locale },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return created;
    });

    return this.toDto(entry, type);
  }

  async update(
    ctx: RequestContext,
    workspaceId: string,
    entryId: string,
    input: {
      slug?: string;
      data?: Record<string, unknown>;
      seo?: Record<string, unknown>;
      change_note?: string;
      expected_version?: number;
    },
  ) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);
    const fields = toFieldDefinitions(type.fields);

    // Authors may only edit their own work (§3.3); the guard needs the record to
    // decide, which is why this is checked here rather than by the route.
    authorize(ctx, 'content.edit', { ownerId: entry.authorId, status: entry.status });

    this.assertNotLockedByAnother(ctx, entry);

    // Optimistic concurrency: two editors on the same entry would otherwise
    // silently overwrite each other, and the loser would never know.
    if (input.expected_version !== undefined && input.expected_version !== entry.currentVersion) {
      throw new AppError('conflict', 'Someone else has saved this entry since you opened it.', {
        detail:
          `You are editing version ${input.expected_version}, but the current version is ` +
          `${entry.currentVersion}. Reload to see their changes before saving.`,
      });
    }

    // Merged, not replaced: the editor sends only the fields it rendered, and a
    // field hidden behind a collapsed group must not be wiped by saving.
    const merged = { ...(entry.data as Record<string, unknown>), ...(input.data ?? {}) };
    const result = validateEntry(fields, merged, { requireRequired: false });
    if (!result.valid) throw validationError(result.errors);

    const slug = await this.resolveSlugOnUpdate(
      workspaceId,
      entry,
      type,
      result.data,
      input.slug,
    );

    const updated = await this.prisma.asSystem(async (tx) => {
      const next = await tx.contentEntry.update({
        where: { id: entry.id },
        data: {
          slug,
          data: result.data as Prisma.InputJsonValue,
          seo: (input.seo ?? (entry.seo as object)) as Prisma.InputJsonValue,
          lastEditedBy: ctx.userId,
          currentVersion: { increment: 1 },
          isIncomplete: !isEntryComplete(fields, result.data),
          // Editing an entry that was rejected in review moves it back to draft
          // so it is not stuck displaying a stale rejection.
          ...(entry.status === 'changes_requested' ? { status: 'draft' as EntryStatus } : {}),
        },
      });

      if (type.enableVersioning) {
        await this.snapshot(tx, next, ctx.userId, input.change_note);
        await this.pruneVersions(tx, next.id);
      }

      await this.syncMediaUsages(tx, workspaceId, next.id, fields, result.data);

      await this.events.emit(tx, 'content.updated', { entry_id: next.id, type: type.apiId }, {
        workspaceId,
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.updated',
        resourceType: 'content_entry',
        resourceId: next.id,
        before: { version: entry.currentVersion },
        after: { version: next.currentVersion, change_note: input.change_note },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return next;
    });

    return this.toDto(updated, type);
  }

  // -- Publish lifecycle -----------------------------------------------------

  async publish(
    ctx: RequestContext,
    workspaceId: string,
    entryId: string,
    options: { scheduled_at?: string; unpublish_at?: string } = {},
  ) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);
    const fields = toFieldDefinitions(type.fields);

    // Publishing demands the strict pass: every required field present and
    // well-formed (§7.1).
    const result = validateEntry(fields, entry.data as Record<string, unknown>, {
      requireRequired: true,
    });
    if (!result.valid) {
      throw new AppError('unprocessable', 'This entry is not ready to publish.', {
        detail: `${result.errors.length} field(s) need attention before it can go live.`,
        fields: result.errors,
      });
    }

    if (type.requireReview && entry.status !== 'in_review' && !ctx.has('content.review.approve')) {
      throw new AppError('unprocessable', `${type.name} entries must be reviewed before publishing.`, {
        detail: 'Submit this entry for review; an Editor or Site Admin can then publish it.',
      });
    }

    if (options.scheduled_at) {
      if (!type.enableScheduling) {
        throw new AppError('unprocessable', `Scheduling is disabled for ${type.name}.`);
      }
      const when = new Date(options.scheduled_at);
      if (Number.isNaN(when.getTime())) {
        throw new AppError('invalid_request', 'scheduled_at is not a valid date.');
      }
      if (when.getTime() <= Date.now()) {
        throw new AppError('invalid_request', 'That publish time is in the past.', {
          detail: 'Pick a future time, or publish now.',
        });
      }

      const scheduled = await this.prisma.asSystem(async (tx) => {
        const next = await tx.contentEntry.update({
          where: { id: entry.id },
          data: { status: 'scheduled', scheduledAt: when },
        });
        await this.events.emit(tx, 'content.scheduled', {
          entry_id: entry.id,
          type: type.apiId,
          scheduled_at: when.toISOString(),
        }, { workspaceId });
        await this.audit.recordIn(tx, {
          workspaceId,
          actorType: 'user',
          actorId: ctx.userId,
          action: 'content.scheduled',
          resourceType: 'content_entry',
          resourceId: entry.id,
          after: { scheduled_at: when.toISOString() },
          requestId: ctx.requestId,
        });
        return next;
      });

      return this.toDto(scheduled, type);
    }

    const published = await this.prisma.asSystem((tx) =>
      this.applyPublish(tx, entry.id, {
        workspaceId,
        typeApiId: type.apiId,
        actorId: ctx.userId,
        unpublishAt: options.unpublish_at ? new Date(options.unpublish_at) : null,
        requestId: ctx.requestId,
      }),
    );

    return this.toDto(published, type);
  }

  async unpublish(ctx: RequestContext, workspaceId: string, entryId: string) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);

    const updated = await this.prisma.asSystem(async (tx) => {
      const next = await tx.contentEntry.update({
        where: { id: entry.id },
        // publishedVersion is kept: it records what the public last saw, which
        // matters for the version history and for re-publishing.
        data: { status: 'draft', publishedAt: null, scheduledAt: null },
      });

      await this.events.emit(tx, 'content.unpublished', { entry_id: entry.id, type: type.apiId }, {
        workspaceId,
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.unpublished',
        resourceType: 'content_entry',
        resourceId: entry.id,
        before: { status: entry.status },
        requestId: ctx.requestId,
      });

      return next;
    });

    return this.toDto(updated, type);
  }

  async archive(ctx: RequestContext, workspaceId: string, entryId: string) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);

    const updated = await this.prisma.asSystem(async (tx) => {
      const next = await tx.contentEntry.update({
        where: { id: entry.id },
        data: { status: 'archived', publishedAt: null, scheduledAt: null },
      });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.archived',
        resourceType: 'content_entry',
        resourceId: entry.id,
        requestId: ctx.requestId,
      });
      return next;
    });

    return this.toDto(updated, type);
  }

  async remove(ctx: RequestContext, workspaceId: string, entryId: string): Promise<void> {
    const entry = await this.requireEntry(workspaceId, entryId);
    authorize(ctx, 'content.delete', { ownerId: entry.authorId, status: entry.status });

    await this.prisma.asSystem(async (tx) => {
      await tx.contentEntry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } });
      await this.events.emit(tx, 'content.deleted', { entry_id: entry.id }, { workspaceId });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.deleted',
        resourceType: 'content_entry',
        resourceId: entry.id,
        before: { slug: entry.slug, status: entry.status },
        requestId: ctx.requestId,
      });
    });
  }

  /**
   * Runs the scheduled publishes that are due (§4.6 `publish-scheduled-content`).
   * Called by the scheduler every minute, and safe to call concurrently.
   */
  async publishDue(now = new Date()): Promise<number> {
    const due = await this.prisma.asSystem((tx) =>
      tx.contentEntry.findMany({
        where: { status: 'scheduled', scheduledAt: { lte: now }, deletedAt: null },
        select: { id: true, workspaceId: true, contentType: { select: { apiId: true } } },
        take: 200,
      }),
    );

    let published = 0;
    for (const entry of due) {
      try {
        await this.prisma.asSystem((tx) =>
          this.applyPublish(tx, entry.id, {
            workspaceId: entry.workspaceId,
            typeApiId: entry.contentType.apiId,
            actorId: null,
            unpublishAt: null,
            requestId: null,
          }),
        );
        published++;
      } catch {
        // One entry failing must not stop the rest of the batch — a single
        // invalid entry would otherwise block every scheduled publish forever.
      }
    }

    return published;
  }

  /** Entries whose unpublish_at has passed (§5.2 optional expiry). */
  async unpublishExpired(now = new Date()): Promise<number> {
    const result = await this.prisma.asSystem((tx) =>
      tx.contentEntry.updateMany({
        where: { status: 'published', unpublishAt: { lte: now }, deletedAt: null },
        data: { status: 'draft', publishedAt: null, unpublishAt: null },
      }),
    );
    return result.count;
  }

  // -- Versions --------------------------------------------------------------

  async listVersions(workspaceId: string, entryId: string) {
    await this.requireEntry(workspaceId, entryId);

    const versions = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentVersion.findMany({
        where: { workspaceId, entryId },
        orderBy: { version: 'desc' },
        take: 100,
      }),
    );

    return versions.map((version) => ({
      id: version.id,
      version: version.version,
      status_at_save: version.statusAtSave,
      change_note: version.changeNote,
      was_published: version.wasPublished,
      created_by: version.createdBy,
      created_at: version.createdAt.toISOString(),
    }));
  }

  async restoreVersion(ctx: RequestContext, workspaceId: string, entryId: string, version: number) {
    const entry = await this.requireEntry(workspaceId, entryId);
    const type = await this.types.requireType(workspaceId, entry.contentTypeId);

    const snapshot = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentVersion.findFirst({ where: { workspaceId, entryId, version } }),
    );
    if (!snapshot) throw notFound('Version', String(version));

    const restored = await this.prisma.asSystem(async (tx) => {
      const next = await tx.contentEntry.update({
        where: { id: entry.id },
        data: {
          data: snapshot.data as Prisma.InputJsonValue,
          seo: snapshot.seo as Prisma.InputJsonValue,
          currentVersion: { increment: 1 },
          lastEditedBy: ctx.userId,
          isIncomplete: !isEntryComplete(
            toFieldDefinitions(type.fields),
            snapshot.data as Record<string, unknown>,
          ),
        },
      });

      // Restoring writes a new version rather than rewinding the counter, so
      // history stays append-only and the restore itself is auditable.
      await this.snapshot(tx, next, ctx.userId, `Restored from version ${version}`);

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'content.version_restored',
        resourceType: 'content_entry',
        resourceId: entry.id,
        after: { restored_from: version, new_version: next.currentVersion },
        requestId: ctx.requestId,
      });

      return next;
    });

    return this.toDto(restored, type);
  }

  // -- Locking ---------------------------------------------------------------

  async acquireLock(ctx: RequestContext, workspaceId: string, entryId: string) {
    const entry = await this.requireEntry(workspaceId, entryId);
    this.assertNotLockedByAnother(ctx, entry);

    await this.prisma.asSystem((tx) =>
      tx.contentEntry.update({
        where: { id: entry.id },
        data: { lockedBy: ctx.userId, lockedAt: new Date() },
      }),
    );

    return { locked_by: ctx.userId, expires_in_seconds: LOCK_TTL_MS / 1000 };
  }

  async releaseLock(ctx: RequestContext, workspaceId: string, entryId: string): Promise<void> {
    await this.requireEntry(workspaceId, entryId);
    await this.prisma.asSystem((tx) =>
      tx.contentEntry.updateMany({
        where: { id: entryId, lockedBy: ctx.userId },
        data: { lockedBy: null, lockedAt: null },
      }),
    );
  }

  // -- helpers ---------------------------------------------------------------

  private assertNotLockedByAnother(
    ctx: RequestContext,
    entry: { lockedBy: string | null; lockedAt: Date | null },
  ): void {
    if (!entry.lockedBy || entry.lockedBy === ctx.userId) return;

    // An expired lock is not a lock. Without this, someone closing their laptop
    // mid-edit would block the entry indefinitely.
    const age = Date.now() - (entry.lockedAt?.getTime() ?? 0);
    if (age > LOCK_TTL_MS) return;

    throw new AppError('conflict', 'Someone else is editing this entry.', {
      detail:
        `The lock expires ${Math.ceil((LOCK_TTL_MS - age) / 60000)} minute(s) after they stop ` +
        'editing. You can take over the lock if you need to.',
    });
  }

  private async applyPublish(
    tx: Prisma.TransactionClient,
    entryId: string,
    context: {
      workspaceId: string;
      typeApiId: string;
      actorId: string | null;
      unpublishAt: Date | null;
      requestId: string | null;
    },
  ) {
    const now = new Date();

    // The live version is whatever the working copy is at this moment, so it
    // has to be read before the update rather than derived from its result.
    const { currentVersion } = await tx.contentEntry.findUniqueOrThrow({
      where: { id: entryId },
      select: { currentVersion: true },
    });

    const published = await tx.contentEntry.update({
      where: { id: entryId },
      data: {
        status: 'published',
        publishedAt: now,
        scheduledAt: null,
        unpublishAt: context.unpublishAt,
        publishedVersion: currentVersion,
      },
    });

    // Mark the live snapshot so retention never prunes it (§5.2: "plus every
    // version that was ever published, forever").
    await tx.contentVersion.updateMany({
      where: { entryId, version: currentVersion },
      data: { wasPublished: true },
    });

    await this.events.emit(
      tx,
      'content.published',
      { entry_id: entryId, type: context.typeApiId, version: currentVersion },
      { workspaceId: context.workspaceId },
    );

    await this.audit.recordIn(tx, {
      workspaceId: context.workspaceId,
      actorType: context.actorId ? 'user' : 'system',
      actorId: context.actorId,
      action: 'content.published',
      resourceType: 'content_entry',
      resourceId: entryId,
      after: { version: currentVersion, published_at: now.toISOString() },
      requestId: context.requestId,
    });

    return published;
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    entry: { id: string; workspaceId: string; currentVersion: number; data: unknown; seo: unknown; status: EntryStatus },
    userId: string | null,
    changeNote?: string,
  ): Promise<void> {
    await tx.contentVersion.create({
      data: {
        id: newId(),
        workspaceId: entry.workspaceId,
        entryId: entry.id,
        version: entry.currentVersion,
        data: entry.data as Prisma.InputJsonValue,
        seo: entry.seo as Prisma.InputJsonValue,
        statusAtSave: entry.status,
        changeNote: changeNote ?? null,
        createdBy: userId,
      },
    });
  }

  private async pruneVersions(tx: Prisma.TransactionClient, entryId: string): Promise<void> {
    const keep = await tx.contentVersion.findMany({
      where: { entryId, wasPublished: false },
      orderBy: { version: 'desc' },
      select: { id: true },
      take: VERSION_RETENTION,
    });

    await tx.contentVersion.deleteMany({
      where: { entryId, wasPublished: false, id: { notIn: keep.map((v) => v.id) } },
    });
  }

  /**
   * Decides an entry's slug on update.
   *
   * An explicit slug always wins. Otherwise the slug is left alone — except for
   * the one case where leaving it alone is clearly wrong: an entry created
   * empty (the "New entry" button sends no data) gets the placeholder
   * `untitled`, and without this every such entry would end up as `untitled`,
   * `untitled-1`, `untitled-2`…
   *
   * Re-deriving is confined to entries that have **never been published**, so a
   * live URL is never silently changed underneath the site serving it — §17.5
   * treats changing a published slug as a deliberate act needing a redirect.
   */
  private async resolveSlugOnUpdate(
    workspaceId: string,
    entry: {
      id: string;
      slug: string | null;
      locale: string;
      publishedVersion: number | null;
      publishedAt: Date | null;
    },
    type: { id: string; hasSlug: boolean; titleFieldId: string | null; fields: { id: string; apiId: string }[] },
    data: Record<string, unknown>,
    explicitSlug?: string,
  ): Promise<string | null> {
    if (!type.hasSlug) return null;

    if (explicitSlug !== undefined) {
      return this.uniqueSlug(workspaceId, type.id, entry.locale, explicitSlug, entry.id);
    }

    const neverPublished = entry.publishedVersion === null && entry.publishedAt === null;
    const isPlaceholder = entry.slug === null || /^untitled(-\d+)?$/.test(entry.slug);

    if (!neverPublished || !isPlaceholder) return entry.slug;

    const derived = deriveSlug(data, type.titleFieldId, type.fields);
    if (derived === 'untitled') return entry.slug;

    return this.uniqueSlug(workspaceId, type.id, entry.locale, derived, entry.id);
  }

  /**
   * Rebuilds `media_usages` for an entry (§5.3: "Populated on entry save;
   * powers the 'used in 4 places' warning before deletion").
   *
   * Rebuilt wholesale rather than diffed: the entry's media fields are the
   * complete truth about what it references, and a diff would drift the moment
   * a field is deprecated or a value is edited outside the editor.
   */
  private async syncMediaUsages(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    entryId: string,
    fields: FieldDefinition[],
    data: Record<string, unknown>,
  ): Promise<void> {
    const references: { assetId: string; fieldApiId: string }[] = [];

    for (const field of fields) {
      const value = data[field.apiId];
      if (field.type === 'media' && typeof value === 'string') {
        references.push({ assetId: value, fieldApiId: field.apiId });
      } else if (field.type === 'media_list' && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') references.push({ assetId: item, fieldApiId: field.apiId });
        }
      }
    }

    await tx.mediaUsage.deleteMany({ where: { entryId } });
    if (references.length === 0) return;

    // Only assets that actually exist in this workspace are recorded. A stale or
    // cross-tenant id in the jsonb must not create a usage row pointing at
    // someone else's asset.
    const existing = await tx.mediaAsset.findMany({
      where: { workspaceId, id: { in: references.map((r) => r.assetId) }, deletedAt: null },
      select: { id: true },
    });
    const valid = new Set(existing.map((asset) => asset.id));

    const seen = new Set<string>();
    for (const reference of references) {
      const key = `${reference.assetId}:${reference.fieldApiId}`;
      if (!valid.has(reference.assetId) || seen.has(key)) continue;
      seen.add(key);

      await tx.mediaUsage.create({
        data: {
          id: newId(),
          workspaceId,
          assetId: reference.assetId,
          entryId,
          fieldApiId: reference.fieldApiId,
        },
      });
    }
  }

  private async requireEntry(workspaceId: string, entryId: string) {
    const entry = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findFirst({ where: { id: entryId, workspaceId, deletedAt: null } }),
    );
    if (!entry) throw notFound('Entry', entryId);
    return entry;
  }

  private async uniqueSlug(
    workspaceId: string,
    contentTypeId: string,
    locale: string,
    base: string,
    excludeId?: string,
  ): Promise<string> {
    const root = slugify(base) || 'untitled';

    for (let suffix = 0; suffix < 100; suffix++) {
      const slug = suffix === 0 ? root : `${root}-${suffix}`;
      const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        tx.contentEntry.count({
          where: {
            workspaceId,
            contentTypeId,
            slug,
            locale,
            deletedAt: null,
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
        }),
      );
      if (!taken) return slug;
    }

    return `${root}-${Date.now().toString(36)}`;
  }

  private toDto(
    entry: {
      id: string;
      contentTypeId: string;
      slug: string | null;
      locale: string;
      translationGroupId: string;
      status: EntryStatus;
      data: unknown;
      seo: unknown;
      publishedAt: Date | null;
      scheduledAt: Date | null;
      unpublishAt: Date | null;
      currentVersion: number;
      publishedVersion: number | null;
      isIncomplete: boolean;
      authorId: string | null;
      lastEditedBy: string | null;
      lockedBy: string | null;
      lockedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    type: { apiId: string; schemaVersion: number },
  ) {
    const lockActive =
      entry.lockedBy && entry.lockedAt && Date.now() - entry.lockedAt.getTime() < LOCK_TTL_MS;

    return {
      id: entry.id,
      type: type.apiId,
      slug: entry.slug,
      locale: entry.locale,
      translation_group_id: entry.translationGroupId,
      status: entry.status,
      data: entry.data,
      seo: entry.seo,
      published_at: entry.publishedAt?.toISOString() ?? null,
      scheduled_at: entry.scheduledAt?.toISOString() ?? null,
      unpublish_at: entry.unpublishAt?.toISOString() ?? null,
      current_version: entry.currentVersion,
      published_version: entry.publishedVersion,
      /// True when a required field was added after the last save (§7.1).
      is_incomplete: entry.isIncomplete,
      /// Set when the live version differs from the working copy.
      has_unpublished_changes:
        entry.status === 'published' && entry.publishedVersion !== entry.currentVersion,
      author_id: entry.authorId,
      last_edited_by: entry.lastEditedBy,
      locked_by: lockActive ? entry.lockedBy : null,
      schema_version: type.schemaVersion,
      created_at: entry.createdAt.toISOString(),
      updated_at: entry.updatedAt.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------

export function toFieldDefinitions(
  fields: {
    apiId: string;
    name: string;
    type: FieldDefinition['type'];
    required: boolean;
    uniqueValue: boolean;
    localised: boolean;
    validation: unknown;
    config: unknown;
    deprecatedAt: Date | null;
  }[],
): FieldDefinition[] {
  return fields.map((field) => ({
    apiId: field.apiId,
    name: field.name,
    type: field.type,
    required: field.required,
    uniqueValue: field.uniqueValue,
    localised: field.localised,
    validation: (field.validation ?? {}) as FieldValidation,
    config: (field.config ?? {}) as FieldConfig,
    deprecatedAt: field.deprecatedAt,
  }));
}

function validationError(errors: { field: string; code: string; message: string }[]): AppError {
  return new AppError('validation_failed', 'Some fields need attention.', {
    detail: `${errors.length} field(s) could not be saved as provided.`,
    fields: errors,
  });
}

function deriveSlug(
  data: Record<string, unknown>,
  titleFieldId: string | null,
  fields: { id: string; apiId: string }[],
): string {
  const titleField = fields.find((f) => f.id === titleFieldId) ?? fields[0];
  const value = titleField ? data[titleField.apiId] : undefined;
  return typeof value === 'string' && value.trim() ? value : 'untitled';
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseSort(sort?: string): Prisma.ContentEntryOrderByWithRelationInput[] {
  // §14.1: `?sort=-published_at,title`, leading `-` meaning descending.
  const allowed: Record<string, keyof Prisma.ContentEntryOrderByWithRelationInput> = {
    published_at: 'publishedAt',
    updated_at: 'updatedAt',
    created_at: 'createdAt',
    slug: 'slug',
    status: 'status',
  };

  const clauses = (sort ?? '-updated_at')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const desc = token.startsWith('-');
      const column = allowed[desc ? token.slice(1) : token];
      return column ? { [column]: desc ? 'desc' : 'asc' } : null;
    })
    .filter(Boolean) as Prisma.ContentEntryOrderByWithRelationInput[];

  // A stable tiebreaker, or cursor pagination can repeat or skip rows when two
  // entries share a sort value.
  return [...clauses, { id: 'desc' }];
}
