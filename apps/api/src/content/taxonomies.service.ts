import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { toApiId } from './content-types.service';
import { slugify } from './entries.service';

/** Taxonomies and their terms (§5.2, §17.8). */
@Injectable()
export class TaxonomiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const taxonomies = await tx.taxonomy.findMany({
        where: { workspaceId, deletedAt: null },
        include: { _count: { select: { terms: true } } },
        orderBy: { name: 'asc' },
      });

      return taxonomies.map((taxonomy) => ({
        id: taxonomy.id,
        name: taxonomy.name,
        api_id: taxonomy.apiId,
        description: taxonomy.description,
        is_hierarchical: taxonomy.isHierarchical,
        applies_to: taxonomy.appliesTo,
        term_count: taxonomy._count.terms,
        created_at: taxonomy.createdAt.toISOString(),
      }));
    });
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    input: { name: string; api_id?: string; description?: string; is_hierarchical?: boolean; applies_to?: string[] },
  ) {
    const apiId = (input.api_id ?? toApiId(input.name)).trim();

    const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.taxonomy.count({ where: { workspaceId, apiId } }),
    );
    if (taken) {
      throw conflict(
        `A taxonomy with the API ID "${apiId}" already exists.`,
        'It appears in Delivery API URLs, so it has to be unique within the site.',
      );
    }

    const taxonomy = await this.prisma.asSystem(async (tx) => {
      const created = await tx.taxonomy.create({
        data: {
          id: newId(),
          workspaceId,
          name: input.name.trim(),
          apiId,
          description: input.description ?? null,
          isHierarchical: input.is_hierarchical ?? false,
          appliesTo: input.applies_to ?? [],
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'taxonomy.created',
        resourceType: 'taxonomy',
        resourceId: created.id,
        after: { name: created.name, api_id: apiId },
        requestId: ctx.requestId,
      });

      return created;
    });

    return {
      id: taxonomy.id,
      name: taxonomy.name,
      api_id: taxonomy.apiId,
      description: taxonomy.description,
      is_hierarchical: taxonomy.isHierarchical,
      applies_to: taxonomy.appliesTo,
      term_count: 0,
      created_at: taxonomy.createdAt.toISOString(),
    };
  }

  async remove(ctx: RequestContext, workspaceId: string, taxonomyId: string): Promise<void> {
    const taxonomy = await this.requireTaxonomy(workspaceId, taxonomyId);

    await this.prisma.asSystem(async (tx) => {
      await tx.taxonomy.update({ where: { id: taxonomy.id }, data: { deletedAt: new Date() } });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'taxonomy.deleted',
        resourceType: 'taxonomy',
        resourceId: taxonomy.id,
        before: { name: taxonomy.name },
        requestId: ctx.requestId,
      });
    });
  }

  // -- Terms -----------------------------------------------------------------

  /** Flat list for a flat taxonomy, nested tree for a hierarchical one (§17.8). */
  async listTerms(workspaceId: string, taxonomyRef: string) {
    const taxonomy = await this.requireTaxonomy(workspaceId, taxonomyRef);

    const terms = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.taxonomyTerm.findMany({
        where: { workspaceId, taxonomyId: taxonomy.id },
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
      children: [] as unknown[],
    }));

    if (!taxonomy.isHierarchical) return dtos;

    const byId = new Map(dtos.map((term) => [term.id, term]));
    const roots: typeof dtos = [];

    for (const term of dtos) {
      const parent = term.parent_id ? byId.get(term.parent_id) : null;
      if (parent) parent.children.push(term);
      else roots.push(term);
    }

    return roots;
  }

  async createTerm(
    ctx: RequestContext,
    workspaceId: string,
    taxonomyRef: string,
    input: { name: string; slug?: string; description?: string; parent_id?: string },
  ) {
    const taxonomy = await this.requireTaxonomy(workspaceId, taxonomyRef);

    if (input.parent_id) {
      if (!taxonomy.isHierarchical) {
        throw new AppError('unprocessable', `${taxonomy.name} is a flat taxonomy.`, {
          detail: 'Enable hierarchy on the taxonomy before nesting terms under one another.',
        });
      }
      const parent = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        tx.taxonomyTerm.count({
          where: { id: input.parent_id, workspaceId, taxonomyId: taxonomy.id },
        }),
      );
      // Scoped to this taxonomy: nesting a Category under a Tag would produce a
      // tree that no consumer can render sensibly.
      if (!parent) throw notFound('Parent term', input.parent_id);
    }

    const slug = await this.uniqueTermSlug(
      workspaceId,
      taxonomy.id,
      input.slug ?? slugify(input.name),
    );

    const term = await this.prisma.asSystem(async (tx) => {
      const created = await tx.taxonomyTerm.create({
        data: {
          id: newId(),
          workspaceId,
          taxonomyId: taxonomy.id,
          parentId: input.parent_id ?? null,
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'taxonomy_term.created',
        resourceType: 'taxonomy_term',
        resourceId: created.id,
        after: { name: created.name, slug, taxonomy: taxonomy.apiId },
        requestId: ctx.requestId,
      });

      return created;
    });

    return {
      id: term.id,
      taxonomy_id: term.taxonomyId,
      parent_id: term.parentId,
      name: term.name,
      slug: term.slug,
      description: term.description,
      position: term.position,
      entry_count: 0,
      children: [],
    };
  }

  async updateTerm(
    ctx: RequestContext,
    workspaceId: string,
    termId: string,
    patch: { name?: string; slug?: string; description?: string; position?: number },
  ) {
    const term = await this.requireTerm(workspaceId, termId);

    const slug =
      patch.slug !== undefined
        ? await this.uniqueTermSlug(workspaceId, term.taxonomyId, patch.slug, term.id)
        : undefined;

    const updated = await this.prisma.asSystem((tx) =>
      tx.taxonomyTerm.update({
        where: { id: termId },
        data: {
          name: patch.name?.trim() ?? undefined,
          slug,
          description: patch.description ?? undefined,
          position: patch.position ?? undefined,
        },
      }),
    );

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'taxonomy_term.updated',
      resourceType: 'taxonomy_term',
      resourceId: termId,
      before: { name: term.name, slug: term.slug },
      after: { name: updated.name, slug: updated.slug },
      requestId: ctx.requestId,
    });

    return {
      id: updated.id,
      taxonomy_id: updated.taxonomyId,
      parent_id: updated.parentId,
      name: updated.name,
      slug: updated.slug,
      description: updated.description,
      position: updated.position,
    };
  }

  async removeTerm(ctx: RequestContext, workspaceId: string, termId: string): Promise<void> {
    const term = await this.requireTerm(workspaceId, termId);

    const children = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.taxonomyTerm.count({ where: { workspaceId, parentId: termId } }),
    );

    // Cascading would silently delete a whole branch. Making the caller empty it
    // first keeps a mis-click from removing dozens of terms.
    if (children > 0) {
      throw new AppError('conflict', `"${term.name}" has ${children} child term(s).`, {
        detail: 'Move or delete them first, or merge this term into another.',
      });
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.taxonomyTerm.delete({ where: { id: termId } });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'taxonomy_term.deleted',
        resourceType: 'taxonomy_term',
        resourceId: termId,
        before: { name: term.name },
        requestId: ctx.requestId,
      });
    });
  }

  /**
   * §17.8: "Merge into… reassigns all entries and deletes the source term."
   * Useful after an import creates near-duplicates.
   */
  async mergeTerm(
    ctx: RequestContext,
    workspaceId: string,
    sourceId: string,
    targetId: string,
  ): Promise<{ entries_moved: number }> {
    const source = await this.requireTerm(workspaceId, sourceId);
    const target = await this.requireTerm(workspaceId, targetId);

    if (source.id === target.id) {
      throw new AppError('invalid_request', 'A term cannot be merged into itself.');
    }
    if (source.taxonomyId !== target.taxonomyId) {
      throw new AppError('unprocessable', 'Both terms must belong to the same taxonomy.');
    }

    const moved = await this.prisma.asSystem(async (tx) => {
      const links = await tx.entryTerm.findMany({ where: { termId: sourceId } });

      let count = 0;
      for (const link of links) {
        // An entry already carrying the target term would violate the composite
        // primary key, so the duplicate link is dropped rather than moved.
        const exists = await tx.entryTerm.count({
          where: { entryId: link.entryId, termId: targetId },
        });
        if (!exists) {
          await tx.entryTerm.create({
            data: { entryId: link.entryId, termId: targetId, workspaceId },
          });
          count++;
        }
      }

      await tx.entryTerm.deleteMany({ where: { termId: sourceId } });
      await tx.taxonomyTerm.updateMany({ where: { parentId: sourceId }, data: { parentId: targetId } });
      await tx.taxonomyTerm.delete({ where: { id: sourceId } });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'taxonomy_term.merged',
        resourceType: 'taxonomy_term',
        resourceId: targetId,
        before: { source: source.name },
        after: { target: target.name, entries_moved: count },
        requestId: ctx.requestId,
      });

      return count;
    });

    return { entries_moved: moved };
  }

  /** Replaces an entry's terms wholesale. Used by the entry editor's Organise tab. */
  async setEntryTerms(workspaceId: string, entryId: string, termIds: string[]): Promise<void> {
    if (termIds.length > 0) {
      const valid = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        tx.taxonomyTerm.count({ where: { workspaceId, id: { in: termIds } } }),
      );
      // Guards against terms from another workspace being attached — the ids
      // arrive from the client.
      if (valid !== new Set(termIds).size) {
        throw new AppError('invalid_request', 'One or more terms do not exist in this site.');
      }
    }

    await this.prisma.asSystem(async (tx) => {
      await tx.entryTerm.deleteMany({ where: { entryId } });
      for (const termId of new Set(termIds)) {
        await tx.entryTerm.create({ data: { entryId, termId, workspaceId } });
      }
    });
  }

  async entryTerms(workspaceId: string, entryId: string): Promise<string[]> {
    const links = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.entryTerm.findMany({ where: { workspaceId, entryId }, select: { termId: true } }),
    );
    return links.map((link) => link.termId);
  }

  // -- helpers ---------------------------------------------------------------

  private async requireTaxonomy(workspaceId: string, ref: string) {
    const taxonomy = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.taxonomy.findFirst({
        where: {
          workspaceId,
          deletedAt: null,
          ...(isUuid(ref) ? { id: ref } : { apiId: ref }),
        },
      }),
    );
    if (!taxonomy) throw notFound('Taxonomy', ref);
    return taxonomy;
  }

  private async requireTerm(workspaceId: string, termId: string) {
    const term = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.taxonomyTerm.findFirst({ where: { id: termId, workspaceId } }),
    );
    if (!term) throw notFound('Term', termId);
    return term;
  }

  private async uniqueTermSlug(
    workspaceId: string,
    taxonomyId: string,
    base: string,
    excludeId?: string,
  ): Promise<string> {
    const root = slugify(base) || 'term';

    for (let suffix = 0; suffix < 100; suffix++) {
      const slug = suffix === 0 ? root : `${root}-${suffix}`;
      const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        tx.taxonomyTerm.count({
          where: {
            workspaceId,
            taxonomyId,
            slug,
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
        }),
      );
      if (!taken) return slug;
    }

    return `${root}-${Date.now().toString(36)}`;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
