-- Full-text search over content entries (Open Decision #4).
--
-- The searchable document is a STORED GENERATED column, not an expression
-- index, for two reasons.
--
-- 1. Row-level security. `ts_match_vq` — the function behind `@@` — is not
--    marked leakproof, and Postgres will not evaluate a non-leakproof qual
--    below an RLS security barrier. The application connects as `cms_app`, for
--    which every row of this table is behind such a barrier, so an expression
--    index could never be used as an index condition and the planner would fall
--    back to recomputing `to_tsvector` for every candidate row. Reading a stored
--    column instead makes that fallback cheap.
--
-- 2. There is one definition. A query against an expression index has to repeat
--    the expression character for character or silently lose the index; a
--    column cannot drift from itself.
--
-- `jsonb_to_tsvector(..., '["string"]')` restricts the document to string
-- *values*. Indexing `data::text` would also index field api_ids and JSON
-- punctuation, so searching "title" would match every entry ever written.
--
-- Every function is called with an explicit 'english'::regconfig: the
-- single-argument forms read default_text_search_config, which makes them
-- STABLE rather than IMMUTABLE, and a generated column requires IMMUTABLE.
ALTER TABLE content_entries
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(slug, ''))
    || jsonb_to_tsvector('english'::regconfig, data, '["string"]')
  ) STORED;

CREATE INDEX IF NOT EXISTS content_entries_search_idx
  ON content_entries USING GIN (search_vector);
