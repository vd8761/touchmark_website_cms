import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { toApiId } from './content-types.service';

/** Navigation menus (§5.2, §17.8). */
const MAX_DEPTH = 3; // §17.8: "drag to reorder and nest up to 3 levels"

export interface MenuItemInput {
  id?: string;
  label: string;
  link_type: 'entry' | 'url' | 'term' | 'none';
  entry_id?: string | null;
  term_id?: string | null;
  url?: string | null;
  target?: '_self' | '_blank';
  icon?: string | null;
  visible?: boolean;
  children?: MenuItemInput[];
}

@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const menus = await tx.menu.findMany({
        where: { workspaceId, deletedAt: null },
        include: { _count: { select: { items: true } } },
        orderBy: { name: 'asc' },
      });

      return menus.map((menu) => ({
        id: menu.id,
        name: menu.name,
        api_id: menu.apiId,
        locale: menu.locale,
        item_count: menu._count.items,
        created_at: menu.createdAt.toISOString(),
      }));
    });
  }

  /** One menu as the nested tree the Delivery API will serve (§17.8 preview). */
  async get(workspaceId: string, menuRef: string) {
    const menu = await this.requireMenu(workspaceId, menuRef);

    const items = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.menuItem.findMany({
        where: { workspaceId, menuId: menu.id },
        orderBy: [{ position: 'asc' }],
      }),
    );

    interface Node {
      id: string;
      label: string;
      link_type: string;
      entry_id: string | null;
      term_id: string | null;
      url: string | null;
      target: string;
      icon: string | null;
      visible: boolean;
      position: number;
      children: Node[];
    }

    const nodes = new Map<string, Node>();
    for (const item of items) {
      nodes.set(item.id, {
        id: item.id,
        label: item.label,
        link_type: item.linkType,
        entry_id: item.entryId,
        term_id: item.termId,
        url: item.url,
        target: item.target,
        icon: item.icon,
        visible: item.visible,
        position: item.position,
        children: [],
      });
    }

    const roots: Node[] = [];
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
    };
  }

  async create(
    ctx: RequestContext,
    workspaceId: string,
    input: { name: string; api_id?: string; locale?: string },
  ) {
    const apiId = (input.api_id ?? toApiId(input.name)).trim();

    const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.menu.count({ where: { workspaceId, apiId } }),
    );
    if (taken) throw conflict(`A menu with the API ID "${apiId}" already exists.`);

    const menu = await this.prisma.asSystem(async (tx) => {
      const created = await tx.menu.create({
        data: {
          id: newId(),
          workspaceId,
          name: input.name.trim(),
          apiId,
          locale: input.locale ?? null,
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'menu.created',
        resourceType: 'menu',
        resourceId: created.id,
        after: { name: created.name, api_id: apiId },
        requestId: ctx.requestId,
      });

      return created;
    });

    return { id: menu.id, name: menu.name, api_id: menu.apiId, locale: menu.locale, items: [] };
  }

  /**
   * Replaces a menu's items with the supplied tree.
   *
   * §17.8: "Unsaved changes are guarded; Save is explicit (menus are too easy to
   * break by autosave)." So this is one atomic replace rather than a stream of
   * per-item edits — the menu is never observed half-rebuilt.
   */
  async replaceItems(
    ctx: RequestContext,
    workspaceId: string,
    menuRef: string,
    items: MenuItemInput[],
  ) {
    const menu = await this.requireMenu(workspaceId, menuRef);

    assertDepth(items, 1);
    await this.assertReferencesExist(workspaceId, items);

    await this.prisma.asSystem(async (tx) => {
      await tx.menuItem.deleteMany({ where: { menuId: menu.id } });

      const insert = async (nodes: MenuItemInput[], parentId: string | null): Promise<void> => {
        for (const [position, node] of nodes.entries()) {
          const created = await tx.menuItem.create({
            data: {
              id: newId(),
              workspaceId,
              menuId: menu.id,
              parentId,
              label: node.label.trim(),
              linkType: node.link_type,
              entryId: node.link_type === 'entry' ? (node.entry_id ?? null) : null,
              termId: node.link_type === 'term' ? (node.term_id ?? null) : null,
              url: node.link_type === 'url' ? (node.url ?? null) : null,
              target: node.target ?? '_self',
              icon: node.icon ?? null,
              position,
              visible: node.visible ?? true,
            },
          });

          if (node.children?.length) await insert(node.children, created.id);
        }
      };

      await insert(items, null);

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'menu.updated',
        resourceType: 'menu',
        resourceId: menu.id,
        after: { item_count: countItems(items) },
        requestId: ctx.requestId,
      });
    });

    return this.get(workspaceId, menu.id);
  }

  async remove(ctx: RequestContext, workspaceId: string, menuRef: string): Promise<void> {
    const menu = await this.requireMenu(workspaceId, menuRef);

    await this.prisma.asSystem(async (tx) => {
      await tx.menu.update({ where: { id: menu.id }, data: { deletedAt: new Date() } });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'menu.deleted',
        resourceType: 'menu',
        resourceId: menu.id,
        before: { name: menu.name },
        requestId: ctx.requestId,
      });
    });
  }

  // -- helpers ---------------------------------------------------------------

  /**
   * Entry and term references are checked against *this* workspace before being
   * written. The ids come from the client, and a menu is one of the few places
   * that stores a bare foreign id without a database-level foreign key.
   */
  private async assertReferencesExist(workspaceId: string, items: MenuItemInput[]): Promise<void> {
    const entryIds = new Set<string>();
    const termIds = new Set<string>();

    const walk = (nodes: MenuItemInput[]): void => {
      for (const node of nodes) {
        if (node.link_type === 'entry' && node.entry_id) entryIds.add(node.entry_id);
        if (node.link_type === 'term' && node.term_id) termIds.add(node.term_id);
        if (node.link_type === 'url' && !node.url) {
          throw new AppError('invalid_request', `Menu item "${node.label}" has no URL.`);
        }
        if (node.children?.length) walk(node.children);
      }
    };
    walk(items);

    await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      if (entryIds.size) {
        const found = await tx.contentEntry.count({
          where: { workspaceId, id: { in: [...entryIds] }, deletedAt: null },
        });
        if (found !== entryIds.size) {
          throw new AppError('invalid_request', 'A menu item points at an entry that does not exist.');
        }
      }

      if (termIds.size) {
        const found = await tx.taxonomyTerm.count({
          where: { workspaceId, id: { in: [...termIds] } },
        });
        if (found !== termIds.size) {
          throw new AppError('invalid_request', 'A menu item points at a term that does not exist.');
        }
      }
    });
  }

  private async requireMenu(workspaceId: string, ref: string) {
    const menu = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.menu.findFirst({
        where: {
          workspaceId,
          deletedAt: null,
          ...(isUuid(ref) ? { id: ref } : { apiId: ref }),
        },
      }),
    );
    if (!menu) throw notFound('Menu', ref);
    return menu;
  }
}

function assertDepth(items: MenuItemInput[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new AppError('unprocessable', `Menus may nest at most ${MAX_DEPTH} levels deep.`, {
      detail: 'Deeper trees are hard to render and harder to navigate.',
    });
  }
  for (const item of items) {
    if (item.children?.length) assertDepth(item.children, depth + 1);
  }
}

function countItems(items: MenuItemInput[]): number {
  return items.reduce((total, item) => total + 1 + countItems(item.children ?? []), 0);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
