import { Prisma } from '@prisma/client';

import { PrismaService } from './prisma.service';

/**
 * The tenant-scoped base repository of §4.4 safeguard 3 and §3.4 layer 3:
 * "Every repository method takes workspace_id as a mandatory first argument.
 * A base repository enforces it; there is no method that can read a table
 * without it."
 *
 * Subclasses cannot reach the Prisma client directly — the only protected
 * member is `scoped()`, which both opens the RLS-bound transaction and injects
 * the workspace filter into the where clause. Forgetting the filter is
 * therefore not expressible, and if one ever is forgotten, RLS still catches it.
 */
export abstract class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The delegate name on PrismaClient for the tenant-owned table this
   * repository fronts, e.g. `'workspaceMember'`. Used to build the scoped
   * accessor and by the tenant-isolation suite to enumerate coverage.
   */
  protected abstract readonly model: TenantModelName;

  /**
   * Opens a workspace-scoped unit of work. `where` clauses passed to the
   * returned delegate are ANDed with `workspace_id = :workspaceId`.
   */
  protected async scoped<T>(
    workspaceId: string,
    work: (repo: ScopedDelegate, tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!workspaceId) {
      throw new Error(
        `${this.constructor.name} was called without a workspace id. Every tenant ` +
          'repository method takes workspace_id as its first argument (§3.4).',
      );
    }

    return this.prisma.withWorkspaceScope(workspaceId, (tx) => {
      const delegate = (tx as Record<string, unknown>)[this.model] as ScopedDelegate;
      return work(withWorkspaceFilter(delegate, workspaceId), tx);
    });
  }
}

/**
 * Tenant-owned Prisma models. Phase 1 onwards appends to this union as tables
 * are added; the isolation suite asserts every member is actually covered by a
 * test, so adding a table without a test fails CI.
 */
export type TenantModelName = 'workspaceMember' | 'auditLog' | 'apiKey' | 'apiRequestLog';

type WhereArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

interface ScopedDelegate {
  findMany(args?: WhereArgs): Promise<unknown[]>;
  findFirst(args?: WhereArgs): Promise<unknown>;
  count(args?: WhereArgs): Promise<number>;
  create(args: WhereArgs): Promise<unknown>;
  updateMany(args: WhereArgs): Promise<{ count: number }>;
  deleteMany(args?: WhereArgs): Promise<{ count: number }>;
}

const READ_METHODS = ['findMany', 'findFirst', 'count', 'updateMany', 'deleteMany'] as const;

function withWorkspaceFilter(delegate: ScopedDelegate, workspaceId: string): ScopedDelegate {
  const wrapped: Record<string, unknown> = {};

  for (const method of READ_METHODS) {
    wrapped[method] = (args: WhereArgs = {}) =>
      (delegate[method] as (a: WhereArgs) => Promise<unknown>)({
        ...args,
        where: { ...(args.where ?? {}), workspaceId },
      });
  }

  // Creates get the workspace stamped on rather than filtered — a repository
  // must not be able to write a row into a different tenant either.
  wrapped.create = (args: WhereArgs) =>
    delegate.create({
      ...args,
      data: { ...((args.data as Record<string, unknown>) ?? {}), workspaceId },
    });

  return wrapped as unknown as ScopedDelegate;
}
