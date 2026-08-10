import { Prisma } from '@prisma/client';

/**
 * The searchable document for a content entry.
 *
 * A stored generated column, defined once in
 * `migrations/20260810060000_content_search_vector` and maintained by Postgres.
 * Both the Delivery `/v1/search` endpoint and the admin entry list read it.
 *
 * It is a column rather than an expression index because the application
 * connects as `cms_app`, for which row-level security puts every row behind a
 * security barrier — and `ts_match_vq`, the function behind `@@`, is not
 * leakproof, so Postgres refuses to evaluate it below that barrier. An
 * expression index therefore could never serve as an index condition here, and
 * the planner would fall back to recomputing `to_tsvector` per row. Reading a
 * stored column makes that fallback cheap, and removes any chance of the query
 * and the index expression drifting apart.
 */
export const CONTENT_SEARCH_VECTOR = Prisma.sql`search_vector`;

/**
 * Turns what someone typed into a tsquery.
 *
 * Words are ANDed and the last one gets a `:*` prefix match, which is what
 * makes search-as-you-type work — "desig" finds "Designing" before the word is
 * finished. Stemming handles the other direction ("designing" finds "design").
 *
 * Input is reduced to letters and digits before it reaches `to_tsquery`, which
 * has a real grammar and raises a syntax error on stray `&`, `!` or `(`. Users
 * type apostrophes and hyphens constantly, and a 500 from a search box is not
 * an acceptable answer to that.
 *
 * Returns null when nothing usable survives — the caller should then return no
 * results rather than send an empty tsquery.
 */
export function toPrefixTsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return null;

  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `${token}:*` : token))
    .join(' & ');
}
