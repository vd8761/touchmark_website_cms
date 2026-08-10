import { v7 as uuidv7 } from 'uuid';

/**
 * UUID v7 — time-sortable, so primary keys cluster by creation time and index
 * pages stay hot. Spec §5: "All tables use UUID v7 primary keys."
 *
 * Generated in the application rather than by Postgres because Postgres 16 has
 * no native v7 function; when the server gains one, this is the single place
 * that changes.
 */
export function newId(): string {
  return uuidv7();
}
