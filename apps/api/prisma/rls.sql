-- Row-Level Security backstop — spec §4.4 safeguard 4.
--
-- This is the *second* net. The first is the tenant-scoped base repository,
-- which makes an unscoped query inexpressible in application code. RLS exists
-- for the case where that net fails: a raw query, a new developer bypassing the
-- repository, a Prisma escape hatch. If the application forgets the WHERE
-- clause, the database still returns nothing.
--
-- Mechanism: every request opens a transaction that sets `app.workspace_id`
-- (see PrismaService.withWorkspaceScope). Policies compare each row's
-- workspace_id against that setting. Because the setting is transaction-local,
-- a pooled connection never leaks one request's scope into the next.
--
-- Applied by `npm run db:rls` after every migration, as the OWNER role.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- RLS does not apply to the table owner or to roles with BYPASSRLS. The
-- application therefore MUST NOT connect as the owner. This role is what
-- DATABASE_URL points at; DATABASE_ADMIN_URL keeps the owner for migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    CREATE ROLE cms_app LOGIN PASSWORD 'cms_app';
  END IF;
END
$$;

-- current_database(), not a hardcoded name: staging and production databases are
-- rarely called "cms", and a literal here would grant against a different
-- database that happens to exist rather than failing.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cms_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO cms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_app;

-- Belt and braces: make it impossible to grant this role a bypass by accident.
ALTER ROLE cms_app NOBYPASSRLS;

-- ---------------------------------------------------------------------------
-- Helper: the current request's workspace scope
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$;

-- System work (the scheduler, the outbox dispatcher, login before any workspace
-- exists) sets app.bypass_rls instead of a workspace id. This is deliberately a
-- session *setting* and not a role privilege, so it is visible in the query and
-- greppable in the code that sets it — see PrismaService.asSystem().
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), 'off') = 'on';
$$;

-- ---------------------------------------------------------------------------
-- Policies on tenant-owned tables
-- ---------------------------------------------------------------------------
-- Phase 1 onwards: add each new tenant table to this list. The tenant-isolation
-- suite fails if a table with a workspace_id column has no policy, so this
-- cannot be silently forgotten.

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
      'workspace_members', 'audit_logs', 'domain_events', 'sender_identities',
      'api_keys', 'api_request_logs',
      'subscribers', 'audience_lists', 'subscriber_list_memberships',
      'forms', 'form_submissions', 'preview_tokens',
      'webhook_endpoints', 'webhook_deliveries',
      'content_types', 'content_fields', 'content_entries', 'content_versions',
      'taxonomies', 'taxonomy_terms', 'entry_terms', 'menus', 'menu_items',
      'review_requests', 'media_folders', 'media_assets', 'media_usages'
    ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    -- Drop every policy this script creates, not just the common one, or a
    -- re-run fails on the first table that has a second policy.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_append ON %I', tenant_table);
  END LOOP;
END
$$;

-- workspace_members: readable and writable only within the current workspace.
CREATE POLICY tenant_isolation ON workspace_members
  USING (app_is_system() OR workspace_id = app_current_workspace())
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

-- audit_logs: append-only. SELECT and INSERT are granted; UPDATE and DELETE are
-- not, so §5.6's "never updated or deleted within the retention window" is a
-- database guarantee rather than a convention. Rows with a NULL workspace_id are
-- organisation-level entries and are only reachable from system context.
CREATE POLICY tenant_isolation ON audit_logs
  FOR SELECT
  USING (app_is_system() OR workspace_id = app_current_workspace());

CREATE POLICY tenant_append ON audit_logs
  FOR INSERT
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

REVOKE UPDATE, DELETE ON audit_logs FROM cms_app;

-- sender_identities: workspace-owned. The organisation's email *configuration*
-- deliberately is not — it is org-scoped property that several workspaces share,
-- and is reached only through org-scoped queries.
CREATE POLICY tenant_isolation ON sender_identities
  USING (app_is_system() OR workspace_id = app_current_workspace())
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

CREATE POLICY tenant_isolation ON api_keys
  USING (app_is_system() OR workspace_id = app_current_workspace())
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

CREATE POLICY tenant_isolation ON api_request_logs
  USING (app_is_system() OR workspace_id = app_current_workspace())
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

-- Content, taxonomy, menu and media tables all carry workspace_id and take the
-- identical policy. Generated in a loop rather than written out seventeen times,
-- so a new table cannot pick up a subtly different rule by copy-paste.
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'subscribers', 'audience_lists', 'subscriber_list_memberships',
    'forms', 'form_submissions', 'preview_tokens',
    'webhook_endpoints', 'webhook_deliveries',
    'content_types', 'content_fields', 'content_entries', 'content_versions',
    'taxonomies', 'taxonomy_terms', 'entry_terms', 'menus', 'menu_items',
    'review_requests', 'media_folders', 'media_assets', 'media_usages'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (app_is_system() OR workspace_id = app_current_workspace()) '
      'WITH CHECK (app_is_system() OR workspace_id = app_current_workspace())',
      tenant_table
    );
  END LOOP;
END
$$;

-- domain_events: same scoping. The dispatcher reads them as system.
CREATE POLICY tenant_isolation ON domain_events
  USING (app_is_system() OR workspace_id = app_current_workspace())
  WITH CHECK (app_is_system() OR workspace_id = app_current_workspace());

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- Fails loudly if a table carrying workspace_id was added without a policy.

DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ')
  INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables have a workspace_id column but no row-level security: %. Add them to prisma/rls.sql.',
      unprotected;
  END IF;
END
$$;
