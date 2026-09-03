import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { invalid, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { CONTENT_SEARCH_VECTOR, toPrefixTsQuery } from '../content/search-query';
import { fieldDto } from '../content/content-types.service';
import { StorageService } from '../media/storage';
import type { ApiKeyAuthContext } from './api-keys.service';

@Injectable()
export class DeliveryContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async listContentTypes(key: ApiKeyAuthContext) {
    const types = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.contentType.findMany({
        where: { workspaceId: key.workspaceId, deletedAt: null },
        include: { fields: { orderBy: { position: 'asc' } } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    );

    return types.map((type) => this.toContentTypeDto(type, type.fields));
  }

  async getContentType(key: ApiKeyAuthContext, apiId: string) {
    const type = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.contentType.findFirst({
        where: { workspaceId: key.workspaceId, apiId, deletedAt: null },
        include: { fields: { orderBy: { position: 'asc' } } },
      }),
    );

    if (!type) throw notFound('Content type', apiId);
    return this.toContentTypeDto(type, type.fields);
  }

  async listEntries(
    key: ApiKeyAuthContext,
    typeApiId: string,
    query: DeliveryEntryQuery,
  ) {
    const type = await this.requireType(key, typeApiId);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const where = withEntryFilters(query.filters, publishedEntryWhere(key.workspaceId, {
      contentTypeId: type.id,
      ...(query.locale ? { locale: query.locale } : {}),
    }));

    const [rows, total] = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      Promise.all([
        tx.contentEntry.findMany({
          where,
          orderBy: parseSort(query.sort),
          take: limit + 1,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        }),
        tx.contentEntry.count({ where }),
      ]),
    );

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const items = await this.expand(
      key.workspaceId,
      page.map((entry) => this.toEntryDto(entry, type)),
      type.fields,
      query.expand,
    );

    return {
      items: items.map((entry) => projectFields(entry, query.fields)),
      meta: {
        total,
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  async getEntryBySlug(
    key: ApiKeyAuthContext,
    typeApiId: string,
    slug: string,
    query: { locale?: string; fields?: string; expand?: string; localeFallback?: boolean },
  ) {
    const type = await this.requireType(key, typeApiId);
    const entry = await this.findEntryBySlugWithFallback(key.workspaceId, type.id, slug, query.locale, query.localeFallback);

    if (!entry) throw notFound('Entry', slug);
    const [expanded] = await this.expand(
      key.workspaceId,
      [this.toEntryDto(entry, type)],
      type.fields,
      query.expand,
    );
    return projectFields(expanded, query.fields);
  }

  async getEntryById(
    key: ApiKeyAuthContext,
    id: string,
    query: { locale?: string; fields?: string; expand?: string; localeFallback?: boolean } = {},
  ) {
    const entry = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.contentEntry.findFirst({
        where: publishedEntryWhere(key.workspaceId, {
          id,
          ...(query.locale ? { locale: query.locale } : {}),
        }),
        include: { contentType: { include: { fields: true } } },
      }),
    );

    if (!entry) throw notFound('Entry', id);
    const [expanded] = await this.expand(
      key.workspaceId,
      [this.toEntryDto(entry, entry.contentType)],
      entry.contentType.fields,
      query.expand,
    );
    return projectFields(expanded, query.fields);
  }

  async search(
    key: ApiKeyAuthContext,
    query: { q?: string; type?: 'content' | 'media' | 'all'; limit?: number },
  ) {
    const q = query.q?.trim();
    if (!q) throw invalid('Search query is required.', 'Pass `q` with at least one character.');

    const limit = Math.min(Math.max(query.limit ?? 25, 1), 50);
    const type = query.type ?? 'all';
    const items: Array<Record<string, unknown>> = [];

    if (type === 'content' || type === 'all') {
      const rows = await this.searchEntryIds(key.workspaceId, q, limit);
      if (rows.length) {
        const entries = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
          tx.contentEntry.findMany({
            where: { workspaceId: key.workspaceId, id: { in: rows.map((row) => row.id) } },
            include: { contentType: true },
          }),
        );
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        for (const row of rows) {
          const entry = byId.get(row.id);
          if (entry) items.push({ kind: 'content', data: this.toEntryDto(entry, entry.contentType) });
        }
      }
    }

    if (items.length < limit && (type === 'media' || type === 'all')) {
      const media = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
        tx.mediaAsset.findMany({
          where: {
            workspaceId: key.workspaceId,
            deletedAt: null,
            uploadedAt: { not: null },
            OR: [
              { filename: { contains: q, mode: 'insensitive' } },
              { altText: { contains: q, mode: 'insensitive' } },
              { caption: { contains: q, mode: 'insensitive' } },
              { tags: { has: q } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit - items.length,
        }),
      );
      for (const asset of media) {
        items.push({ kind: 'media', data: await this.toMediaDto(asset) });
      }
    }

    return { items, meta: { total: items.length, limit } };
  }

  async listRelatedEntries(
    key: ApiKeyAuthContext,
    typeApiId: string,
    slug: string,
    query: DeliveryEntryQuery,
  ) {
    const type = await this.requireType(key, typeApiId);
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);

    const source = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.contentEntry.findFirst({
        where: withEntryFilters(query.filters, publishedEntryWhere(key.workspaceId, {
          contentTypeId: type.id,
          slug,
          ...(query.locale ? { locale: query.locale } : {}),
        })),
        select: { id: true },
      }),
    );
    if (!source) throw notFound('Entry', slug);

    const terms = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.entryTerm.findMany({
        where: { workspaceId: key.workspaceId, entryId: source.id },
        select: { termId: true },
      }),
    );
    const termIds = terms.map((term) => term.termId);
    if (!termIds.length) {
      return {
        items: [],
        meta: { total: 0, limit, has_more: false, next_cursor: null, source_id: source.id },
      };
    }

    const where = withEntryFilters(query.filters, publishedEntryWhere(key.workspaceId, {
      contentTypeId: type.id,
      id: { not: source.id },
      ...(query.locale ? { locale: query.locale } : {}),
      terms: { some: { workspaceId: key.workspaceId, termId: { in: termIds } } },
    }));

    const [rows, total] = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      Promise.all([
        tx.contentEntry.findMany({
          where,
          orderBy: parseSort(query.sort),
          take: limit + 1,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        }),
        tx.contentEntry.count({ where }),
      ]),
    );

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const items = await this.expand(
      key.workspaceId,
      page.map((entry) => this.toEntryDto(entry, type)),
      type.fields,
      query.expand,
    );

    return {
      items: items.map((entry) => projectFields(entry, query.fields)),
      meta: {
        total,
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1].id : null,
        source_id: source.id,
      },
    };
  }

  async listTaxonomies(key: ApiKeyAuthContext) {
    const taxonomies = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.taxonomy.findMany({
        where: { workspaceId: key.workspaceId, deletedAt: null },
        include: { _count: { select: { terms: true } } },
        orderBy: { name: 'asc' },
      }),
    );

    return taxonomies.map((taxonomy) => this.toTaxonomyDto(taxonomy, taxonomy._count.terms));
  }

  async listTaxonomyTerms(key: ApiKeyAuthContext, apiId: string) {
    const taxonomy = await this.requireTaxonomy(key, apiId);
    const terms = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.taxonomyTerm.findMany({
        where: { workspaceId: key.workspaceId, taxonomyId: taxonomy.id },
        include: { _count: { select: { entries: true } } },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
    );

    const dtos = terms.map((term) => ({
      id: term.id,
      taxonomy_id: term.taxonomyId,
      parent_id: term.parentId,
      name: term.name,
      slug: term.slug,
      description: term.description,
      position: term.position,
      entry_count: term._count.entries,
      children: [] as TaxonomyTermDto[],
    }));

    if (!taxonomy.isHierarchical) return { items: dtos, total: dtos.length };

    const byId = new Map(dtos.map((term) => [term.id, term]));
    const roots: TaxonomyTermDto[] = [];
    for (const term of dtos) {
      const parent = term.parent_id ? byId.get(term.parent_id) : null;
      if (parent) parent.children.push(term);
      else roots.push(term);
    }

    return { items: roots, total: dtos.length };
  }

  async listMenus(key: ApiKeyAuthContext) {
    const menus = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.menu.findMany({
        where: { workspaceId: key.workspaceId, deletedAt: null },
        include: { _count: { select: { items: true } } },
        orderBy: { name: 'asc' },
      }),
    );

    return menus.map((menu) => ({
      id: menu.id,
      name: menu.name,
      api_id: menu.apiId,
      locale: menu.locale,
      item_count: menu._count.items,
      created_at: menu.createdAt.toISOString(),
      updated_at: menu.updatedAt.toISOString(),
    }));
  }

  async getMenu(key: ApiKeyAuthContext, apiId: string, locale?: string) {
    const menu = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.menu.findFirst({
        where: {
          workspaceId: key.workspaceId,
          apiId,
          deletedAt: null,
          ...(locale ? { locale } : {}),
        },
        include: { items: { where: { visible: true }, orderBy: [{ position: 'asc' }] } },
      }),
    );
    if (!menu) throw notFound('Menu', apiId);

    const entryIds = unique(menu.items.map((item) => item.entryId).filter(isPresent));
    const termIds = unique(menu.items.map((item) => item.termId).filter(isPresent));

    const [entries, terms] = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      Promise.all([
        entryIds.length
          ? tx.contentEntry.findMany({
              where: publishedEntryWhere(key.workspaceId, { id: { in: entryIds } }),
              select: {
                id: true,
                slug: true,
                locale: true,
                contentType: { select: { apiId: true } },
              },
            })
          : Promise.resolve([]),
        termIds.length
          ? tx.taxonomyTerm.findMany({
              where: {
                workspaceId: key.workspaceId,
                id: { in: termIds },
                taxonomy: { deletedAt: null },
              },
              select: {
                id: true,
                name: true,
                slug: true,
                taxonomy: { select: { apiId: true, name: true } },
              },
            })
          : Promise.resolve([]),
      ]),
    );

    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const termsById = new Map(terms.map((term) => [term.id, term]));
    const items = menu.items.filter((item) => {
      if (item.linkType === 'entry') return !!item.entryId && entriesById.has(item.entryId);
      if (item.linkType === 'term') return !!item.termId && termsById.has(item.termId);
      return true;
    });

    const nodes = new Map<string, DeliveryMenuItemDto>();
    for (const item of items) {
      const entry = item.entryId ? entriesById.get(item.entryId) : undefined;
      const term = item.termId ? termsById.get(item.termId) : undefined;

      nodes.set(item.id, {
        id: item.id,
        label: item.label,
        link_type: item.linkType,
        entry_id: item.entryId,
        term_id: item.termId,
        url: item.url,
        resolved_url: resolveMenuUrl(item.linkType, item.url, entry, term),
        target: item.target,
        icon: item.icon,
        position: item.position,
        children: [],
        ...(entry
          ? {
              entry: {
                id: entry.id,
                type: entry.contentType.apiId,
                slug: entry.slug,
                locale: entry.locale,
              },
            }
          : {}),
        ...(term
          ? {
              term: {
                id: term.id,
                taxonomy: term.taxonomy.apiId,
                taxonomy_name: term.taxonomy.name,
                slug: term.slug,
                name: term.name,
              },
            }
          : {}),
      });
    }

    const roots: DeliveryMenuItemDto[] = [];
    for (const item of items) {
      const node = nodes.get(item.id)!;
      const parent = item.parentId ? nodes.get(item.parentId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    return {
      id: menu.id,
      name: menu.name,
      api_id: menu.apiId,
      locale: menu.locale,
      items: roots,
      updated_at: menu.updatedAt.toISOString(),
    };
  }

  async listMedia(
    key: ApiKeyAuthContext,
    query: { folder_id?: string; search?: string; type?: string; tag?: string; limit?: number; cursor?: string },
  ) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const where: Prisma.MediaAssetWhereInput = {
      workspaceId: key.workspaceId,
      deletedAt: null,
      uploadedAt: { not: null },
      ...(query.folder_id ? { folderId: query.folder_id } : {}),
      ...(query.search ? { filename: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.type ? { mimeType: { startsWith: query.type } } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
    };

    const [rows, total] = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      Promise.all([
        tx.mediaAsset.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        }),
        tx.mediaAsset.count({ where }),
      ]),
    );

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const items = await Promise.all(page.map((asset) => this.toMediaDto(asset)));

    return {
      items,
      meta: {
        total,
        limit,
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  async getMedia(key: ApiKeyAuthContext, id: string) {
    const asset = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.mediaAsset.findFirst({
        where: { id, workspaceId: key.workspaceId, deletedAt: null, uploadedAt: { not: null } },
      }),
    );
    if (!asset) throw notFound('Media asset', id);
    return this.toMediaDto(asset);
  }

  private async requireType(key: ApiKeyAuthContext, apiId: string) {
    const type = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.contentType.findFirst({
        where: { workspaceId: key.workspaceId, apiId, deletedAt: null },
        include: { fields: { orderBy: { position: 'asc' } } },
      }),
    );

    if (!type) throw notFound('Content type', apiId);
    return type;
  }

  /**
   * Replaces reference ids in `data` with the objects they point at (§14.1
   * `?expand=`).
   *
   * A relation field stores an id, so rendering a post with its author's name
   * costs a second request per entry — twenty for a listing page. Expansion
   * resolves the whole page in two queries regardless of its size: one for
   * entries, one for media assets.
   *
   * Three rules worth knowing:
   *
   * - **One level only.** An expanded entry keeps its own relations as ids.
   *   Recursion here is how one request becomes an unbounded fan-out, and a
   *   caller that needs the next level can ask for it.
   * - **Targets go through the same published filter as any other read.** A
   *   relation pointing at a draft resolves to `null`, never to unpublished
   *   content — expansion must not become a way around the publish gate.
   * - **An unresolvable reference is `null` for a single relation and simply
   *   absent from a list.** The alternative is failing the whole request
   *   because one entry references something that was deleted, which turns a
   *   content mistake into an outage on the customer's site.
   */
  private async expand<T extends { data: unknown }>(
    workspaceId: string,
    entries: T[],
    typeFields: Array<{ apiId: string; type: string }>,
    expand?: string,
  ): Promise<T[]> {
    const requested = (expand ?? '')
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean)
      // `data.` is how §14.1 writes these, and how `fields=` and `filter[]`
      // already address the same values; the bare form is accepted too.
      .map((path) => (path.startsWith('data.') ? path.slice('data.'.length) : path));

    if (!requested.length || !entries.length) return entries;

    const byApiId = new Map(typeFields.map((field) => [field.apiId, field.type]));
    const targets: Array<{ apiId: string; kind: 'entry' | 'media'; many: boolean }> = [];

    for (const apiId of unique(requested)) {
      const type = byApiId.get(apiId);
      if (!type) {
        throw invalid(
          `Cannot expand \`${apiId}\`: this content type has no such field.`,
          'Expand a relation or media field, e.g. `expand=data.author`.',
        );
      }
      if (type === 'relation_one') targets.push({ apiId, kind: 'entry', many: false });
      else if (type === 'relation_many') targets.push({ apiId, kind: 'entry', many: true });
      else if (type === 'media') targets.push({ apiId, kind: 'media', many: false });
      else if (type === 'media_list') targets.push({ apiId, kind: 'media', many: true });
      else {
        throw invalid(
          `Cannot expand \`${apiId}\`: it is a ${type} field, which holds no reference.`,
          'Only relation and media fields can be expanded.',
        );
      }
    }

    const entryIds = new Set<string>();
    const mediaIds = new Set<string>();
    for (const entry of entries) {
      const data = asRecord(entry.data);
      if (!data) continue;
      for (const target of targets) {
        const sink = target.kind === 'entry' ? entryIds : mediaIds;
        for (const id of referenceIds(data[target.apiId], target.many)) sink.add(id);
      }
    }

    const [relatedEntries, relatedMedia] = await Promise.all([
      this.resolveEntryTargets(workspaceId, [...entryIds]),
      this.resolveMediaTargets(workspaceId, [...mediaIds]),
    ]);

    return entries.map((entry) => {
      const data = asRecord(entry.data);
      if (!data) return entry;

      const next = { ...data };
      for (const target of targets) {
        const resolved = target.kind === 'entry' ? relatedEntries : relatedMedia;
        const ids = referenceIds(data[target.apiId], target.many);
        if (target.many) {
          next[target.apiId] = ids.map((id) => resolved.get(id)).filter(isPresent);
        } else {
          next[target.apiId] = ids.length ? (resolved.get(ids[0]) ?? null) : null;
        }
      }
      return { ...entry, data: next };
    });
  }

  private async resolveEntryTargets(workspaceId: string, ids: string[]) {
    if (!ids.length) return new Map<string, Record<string, unknown>>();

    const rows = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findMany({
        where: publishedEntryWhere(workspaceId, { id: { in: ids } }),
        include: { contentType: true },
      }),
    );

    return new Map(rows.map((row) => [row.id, this.toEntryDto(row, row.contentType)]));
  }

  private async resolveMediaTargets(workspaceId: string, ids: string[]) {
    if (!ids.length) return new Map<string, Record<string, unknown>>();

    const rows = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaAsset.findMany({
        where: {
          workspaceId,
          id: { in: ids },
          deletedAt: null,
          uploadedAt: { not: null },
        },
      }),
    );

    const dtos = await Promise.all(rows.map((row) => this.toMediaDto(row)));
    return new Map(rows.map((row, index) => [row.id, dtos[index]]));
  }

  private async requireTaxonomy(key: ApiKeyAuthContext, apiId: string) {
    const taxonomy = await this.prisma.withWorkspaceScope(key.workspaceId, (tx) =>
      tx.taxonomy.findFirst({
        where: { workspaceId: key.workspaceId, apiId, deletedAt: null },
      }),
    );

    if (!taxonomy) throw notFound('Taxonomy', apiId);
    return taxonomy;
  }

  private async findEntryBySlugWithFallback(
    workspaceId: string,
    contentTypeId: string,
    slug: string,
    locale?: string,
    localeFallback?: boolean,
  ) {
    const exact = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findFirst({
        where: publishedEntryWhere(workspaceId, {
          contentTypeId,
          slug,
          ...(locale ? { locale } : {}),
        }),
      }),
    );
    if (exact || !locale || localeFallback === false) return exact;

    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({
        where: { id: workspaceId },
        select: { defaultLocale: true },
      }),
    );
    const fallback = workspace?.defaultLocale;
    if (!fallback || fallback === locale) return exact;

    return this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findFirst({
        where: publishedEntryWhere(workspaceId, { contentTypeId, slug, locale: fallback }),
      }),
    );
  }

  /**
   * Ranked full-text search over published entries.
   *
   * Ordered by `ts_rank` first, so an entry whose title matches beats one that
   * mentions the word once in a paragraph — recency only breaks ties. The
   * previous implementation was a substring match ordered purely by date, which
   * put the least relevant recent entry above the best older one.
   */
  private async searchEntryIds(workspaceId: string, query: string, limit: number) {
    const tsQuery = toPrefixTsQuery(query);
    if (!tsQuery) return [];

    return this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id
          FROM content_entries
          WHERE workspace_id = CAST(${workspaceId} AS uuid)
            AND status = 'published'
            AND deleted_at IS NULL
            AND published_at IS NOT NULL
            AND (unpublish_at IS NULL OR unpublish_at > now())
            AND ${CONTENT_SEARCH_VECTOR} @@ to_tsquery('english'::regconfig, ${tsQuery})
          ORDER BY
            ts_rank(${CONTENT_SEARCH_VECTOR}, to_tsquery('english'::regconfig, ${tsQuery})) DESC,
            published_at DESC NULLS LAST,
            updated_at DESC,
            id DESC
          LIMIT ${limit}
        `,
      ),
    );
  }

  private toContentTypeDto(
    type: {
      id: string;
      name: string;
      apiId: string;
      description: string | null;
      kind: string;
      icon: string | null;
      hasSlug: boolean;
      isLocalised: boolean;
      schemaVersion: number;
      updatedAt: Date;
    },
    fields: Parameters<typeof fieldDto>[0][],
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
      schema_version: type.schemaVersion,
      fields: fields.map(fieldDto),
      updated_at: type.updatedAt.toISOString(),
    };
  }

  private toEntryDto(
    entry: {
      id: string;
      slug: string | null;
      locale: string;
      data: unknown;
      seo: unknown;
      publishedAt: Date | null;
      updatedAt: Date;
    },
    type: { apiId: string; schemaVersion: number },
  ) {
    let data = entry.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const startRaw = record.startdate ?? record.start_at;
      const endRaw = record.enddate ?? record.end_at;
      if (startRaw || endRaw) {
        const now = Date.now();
        const start = startRaw ? new Date(String(startRaw)).getTime() : null;
        const end = endRaw ? new Date(String(endRaw)).getTime() : null;
        let eventStatus: 'upcoming' | 'ongoing' | 'completed' = 'upcoming';
        if (end && now > end) {
          eventStatus = 'completed';
        } else if (start && now >= start && (!end || now <= end)) {
          eventStatus = 'ongoing';
        } else if (start && now < start) {
          eventStatus = 'upcoming';
        } else if (end && now <= end) {
          eventStatus = 'upcoming';
        }
        data = { ...record, event_status: eventStatus };
      }
    }

    return {
      id: entry.id,
      type: type.apiId,
      slug: entry.slug,
      locale: entry.locale,
      data,
      seo: entry.seo,
      published_at: entry.publishedAt?.toISOString() ?? null,
      updated_at: entry.updatedAt.toISOString(),
      schema_version: type.schemaVersion,
    };
  }

  private toTaxonomyDto(
    taxonomy: {
      id: string;
      name: string;
      apiId: string;
      description: string | null;
      isHierarchical: boolean;
      appliesTo: string[];
      createdAt: Date;
      updatedAt: Date;
    },
    termCount: number,
  ) {
    return {
      id: taxonomy.id,
      name: taxonomy.name,
      api_id: taxonomy.apiId,
      description: taxonomy.description,
      is_hierarchical: taxonomy.isHierarchical,
      applies_to: taxonomy.appliesTo,
      term_count: termCount,
      created_at: taxonomy.createdAt.toISOString(),
      updated_at: taxonomy.updatedAt.toISOString(),
    };
  }

  private async toMediaDto(asset: {
    id: string;
    filename: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: bigint;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    altText: string | null;
    altI18n: unknown;
    caption: string | null;
    credit: string | null;
    tags: string[];
    blurhash: string | null;
    variants: unknown;
    folderId: string | null;
    uploadedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: asset.id,
      filename: asset.filename,
      mime_type: asset.mimeType,
      size_bytes: Number(asset.sizeBytes),
      width: asset.width,
      height: asset.height,
      duration_ms: asset.durationMs,
      url: await this.storage.publicUrl(asset.storageKey),
      alt_text: asset.altText,
      alt_i18n: asset.altI18n,
      caption: asset.caption,
      credit: asset.credit,
      tags: asset.tags,
      blurhash: asset.blurhash,
      variants: asset.variants,
      folder_id: asset.folderId,
      uploaded_at: asset.uploadedAt?.toISOString() ?? null,
      created_at: asset.createdAt.toISOString(),
      updated_at: asset.updatedAt.toISOString(),
    };
  }
}

type TaxonomyTermDto = {
  id: string;
  taxonomy_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  entry_count: number;
  children: TaxonomyTermDto[];
};

type MenuEntryTarget = {
  id: string;
  slug: string | null;
  locale: string;
  contentType: { apiId: string };
};

type MenuTermTarget = {
  id: string;
  name: string;
  slug: string;
  taxonomy: { apiId: string; name: string };
};

type DeliveryMenuItemDto = {
  id: string;
  label: string;
  link_type: string;
  entry_id: string | null;
  term_id: string | null;
  url: string | null;
  resolved_url: string | null;
  target: string;
  icon: string | null;
  position: number;
  children: DeliveryMenuItemDto[];
  entry?: { id: string; type: string; slug: string | null; locale: string };
  term?: { id: string; taxonomy: string; taxonomy_name: string; slug: string; name: string };
};

export type DeliveryEntryFilters = {
  status?: string;
  slug?: string;
  locale?: string;
  published_at_gte?: string;
  published_at_lte?: string;
  updated_at_gte?: string;
  updated_at_lte?: string;
  data?: Record<string, string>;
};

export type DeliveryEntryQuery = {
  locale?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
  fields?: string;
  expand?: string;
  filters?: DeliveryEntryFilters;
  localeFallback?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The ids a reference field holds, in the order the author arranged them. */
function referenceIds(value: unknown, many: boolean): string[] {
  if (many) {
    return Array.isArray(value) ? unique(value.filter((id): id is string => typeof id === 'string')) : [];
  }
  return typeof value === 'string' && value ? [value] : [];
}

function publishedEntryWhere(
  workspaceId: string,
  extra: Prisma.ContentEntryWhereInput = {},
): Prisma.ContentEntryWhereInput {
  return {
    workspaceId,
    status: 'published',
    deletedAt: null,
    publishedAt: { not: null },
    OR: [{ unpublishAt: null }, { unpublishAt: { gt: new Date() } }],
    ...extra,
  };
}

function withEntryFilters(
  filters: DeliveryEntryFilters | undefined,
  where: Prisma.ContentEntryWhereInput,
): Prisma.ContentEntryWhereInput {
  if (!filters) return where;
  if (filters.status && filters.status !== 'published') return { ...where, id: { in: [] } };

  const and: Prisma.ContentEntryWhereInput[] = [];
  if (filters.slug) and.push({ slug: filters.slug });
  if (filters.locale) and.push({ locale: filters.locale });
  if (filters.published_at_gte) and.push({ publishedAt: { gte: new Date(filters.published_at_gte) } });
  if (filters.published_at_lte) and.push({ publishedAt: { lte: new Date(filters.published_at_lte) } });
  if (filters.updated_at_gte) and.push({ updatedAt: { gte: new Date(filters.updated_at_gte) } });
  if (filters.updated_at_lte) and.push({ updatedAt: { lte: new Date(filters.updated_at_lte) } });

  for (const [field, value] of Object.entries(filters.data ?? {})) {
    and.push({ data: { path: [field], equals: coerceFilterValue(value) } });
  }

  return and.length ? { ...where, AND: [...normaliseAnd(where.AND), ...and] } : where;
}

function normaliseAnd(
  value: Prisma.ContentEntryWhereInput['AND'],
): Prisma.ContentEntryWhereInput[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function coerceFilterValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function projectFields<T extends Record<string, unknown>>(dto: T, fields?: string): T {
  const paths = (fields ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  if (!paths.length) return dto;

  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) continue;
    const value = getPath(dto, parts);
    if (value !== undefined) setPath(projected, parts, value);
  }
  return projected as T;
}

function getPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
}

function parseSort(sort?: string): Prisma.ContentEntryOrderByWithRelationInput[] {
  const allowed: Record<string, keyof Prisma.ContentEntryOrderByWithRelationInput> = {
    published_at: 'publishedAt',
    updated_at: 'updatedAt',
    created_at: 'createdAt',
    slug: 'slug',
  };

  const clauses = (sort ?? '-published_at')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const desc = token.startsWith('-');
      const column = allowed[desc ? token.slice(1) : token];
      return column ? { [column]: desc ? 'desc' : 'asc' } : null;
    })
    .filter(Boolean) as Prisma.ContentEntryOrderByWithRelationInput[];

  return [...clauses, { id: 'desc' }];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveMenuUrl(
  linkType: string,
  url: string | null,
  entry?: MenuEntryTarget,
  term?: MenuTermTarget,
): string | null {
  if (linkType === 'url') return url;
  if (linkType === 'entry' && entry?.slug) return `/${entry.contentType.apiId}/${entry.slug}`;
  if (linkType === 'term' && term) return `/${term.taxonomy.apiId}/${term.slug}`;
  return null;
}
