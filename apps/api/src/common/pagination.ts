/**
 * The §14.1 cursor pagination contract, in one place.
 *
 * Entries already implemented this inline; audit logs and member lists were
 * capped at 50 rows with no way to reach row 51 at all — on an append-only
 * table that is a compliance problem rather than a convenience one, because
 * "show me what happened last Tuesday" has no answer.
 *
 * Cursors are opaque row ids rather than offsets. On a table that is written to
 * constantly, `OFFSET 50` re-reads a window that has since shifted, so a reader
 * paging backwards through an audit log would see rows twice and miss others.
 * A keyset cursor is stable under concurrent writes.
 */

export interface PageQuery {
  limit?: number | string;
  cursor?: string;
}

export interface PageMeta {
  total: number;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Clamps a caller-supplied limit. A bad value falls back rather than erroring. */
export function parseLimit(raw: number | string | undefined, fallback = DEFAULT_LIMIT): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.min(Math.trunc(value as number), MAX_LIMIT);
}

/**
 * Prisma arguments for one page.
 *
 * Takes `limit + 1` rows: the extra row is how `has_more` is answered without a
 * second query. `skip: 1` steps over the cursor row itself, which Prisma
 * includes by default.
 */
export function pageArgs(limit: number, cursor?: string) {
  return {
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

/**
 * Splits an over-fetched result into a page and its meta.
 *
 * `total` is the count of everything matching the filter, not the size of this
 * page — the previous implementations returned the latter under the same name,
 * which made "50" mean both "one page" and "fifty records in total".
 */
export function toPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  total: number,
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    meta: {
      total,
      limit,
      has_more: hasMore,
      next_cursor: hasMore ? items[items.length - 1].id : null,
    },
  };
}
