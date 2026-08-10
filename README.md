# Multi-Site CMS & Audience Platform

A multi-tenant, headless-first Content Management and Audience platform. One deployment serves
many organisations; each organisation manages many websites ("sites" in the UI, `workspaces` in
code, the database and the API).

Built from `CMS_Platform_Design_Spec.md` v1.0. **Phases 0 and 1 are complete**, plus
organisation-level Resend email configuration, the Postgres-backed job queue, and the
Phase 2 backend Delivery API/developer-platform contract: API keys, published content reads,
search, subscriber/list/form endpoints, preview tokens, request-log summaries, webhooks and split
Admin/Delivery OpenAPI documents.

> **[docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)** is the authoritative status document: what
> this is, what works today, and a detailed breakdown of everything that remains, phase by phase.
> The summary below is the short version.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run db:up
```

```bash
npm run build --workspace @cms/shared && npm run db:migrate --workspace @cms/api && npm run db:rls --workspace @cms/api && npm run db:seed --workspace @cms/api
```

Then run the API and the admin portal in two terminals:

```bash
npm run dev --workspace @cms/api
```

```bash
npm run dev --workspace @cms/admin
```

- Admin portal — http://localhost:5173
- API — http://localhost:4000
- API reference (Swagger) — http://localhost:4000/docs
- Mailhog (system email in development) — http://localhost:8025

Seeded accounts, one per role, all with the password `development-password-1`:

| Email | Organisation role | Site role |
|---|---|---|
| `owner@example.test` | Owner | *inherits Site Admin* |
| `admin@example.test` | Admin | *inherits Site Admin* |
| `editor@example.test` | Member | Editor |
| `author@example.test` | Member | Author |
| `marketer@example.test` | Member | Marketer |
| `analyst@example.test` | Member | Analyst |

> **Postgres runs on host port 5433, not 5432.** A locally installed Postgres on 5432 is common,
> and the clash surfaces as a confusing authentication failure against the wrong server. Override
> with `POSTGRES_HOST_PORT` if 5433 is also taken.

---

## Layout

```
packages/shared/     Permissions, roles, error codes, public ids, wire types.
                     Imported by both the API and the portal, so the rules are
                     defined once and enforced/displayed from the same source.
apps/api/            NestJS Admin API, Prisma schema, RLS policies, tests.
apps/admin/          React + Vite admin portal.
```

---

## The three layers of tenant isolation

Workspace isolation is the load-bearing property of this architecture (§4.4), and the spec is
blunt about the cost of retrofitting it. It is enforced three times over, deliberately:

**1. Request context** (`src/auth/request-context.guard.ts`) — the workspace is resolved from the
URL path or the `X-Workspace-Id` header, **never** from a request body field. A body field could
re-target a write at another tenant while passing every other check.

**2. The `authorize()` guard** (`src/auth/authorize.ts`) — one policy function, called before every
handler, reading role→permission sets from `packages/shared/src/permissions.ts`. Nothing else in
the codebase decides what a role can do.

**3. Row-level security** (`apps/api/prisma/rls.sql`) — the database filters rows by
`app.workspace_id`, set per transaction. The application connects as `cms_app`, an unprivileged
role that is **not** the table owner and has `NOBYPASSRLS`, so the policies actually apply to it.
If the application ever forgets a `WHERE` clause, the database still returns nothing.

On top of these, `TenantRepository` makes an unscoped query inexpressible: the only access a
subclass gets is `scoped(workspaceId, …)`, which both opens the RLS transaction and injects the
workspace filter.

### The isolation suite is a merge blocker

`apps/api/test/tenant-isolation.e2e-spec.ts` builds two complete, unrelated tenants and asserts
neither can reach the other — over HTTP, through the repository, and at the database. It also
**enumerates the application's registered routes and fails if a workspace-scoped route has no
isolation test**, so adding an endpoint without a test breaks CI rather than quietly widening the
surface.

```bash
npm run test:isolation
```

Do not add `continue-on-error` to that CI step.

---

## Design decisions worth knowing

These either follow the spec's recommendations or deviate from it for a stated reason.

| Decision | Choice |
|---|---|
| Backend | **NestJS + TypeScript** (Open Decision #1) — shared types between API, SDK and portal |
| Email provider | **Resend**, configured per organisation rather than per platform (§5.5 deviation — see `docs/architecture.md`). An organisation holds several configurations; each site picks one and sets its from-address |
| Rich text | **Structured JSON** (Open Decision #3) — HTML would lock consumers into a rendering model |
| Background jobs | A `jobs` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`. There is no broker: Postgres is the only datastore this platform needs |
| Public ids | UUID v7 stored; `ce_01J8XQ…` prefixed base62 **encoded** at the API boundary. Reconciles §5 (UUID PKs) with Appendix B (prefixed ids) with no second column to keep in sync |
| Access-token claims | The token carries `{ sub, sid, jti }` only — **not** role or permissions. The spec's §6.1 sketch includes them, but baking a role into a 15-minute token means a role change takes 15 minutes to apply, contradicting §6.4's 60-second requirement. Roles are resolved per request instead |
| Archived sites | Write permissions are stripped when the context is built, in one place, rather than checked in every handler. Denials report `workspace_archived`, not a role problem the user cannot fix |
| Cross-tenant 404s | A workspace the caller cannot see returns **404, not 403**. A 403 confirms the resource exists, which is itself a cross-tenant disclosure |
| Audit log | Append-only enforced by the database: `UPDATE` and `DELETE` are revoked from `cms_app`, so even a compromised application cannot rewrite history. Secrets are redacted before rows are written |
| Media storage | Pluggable driver behind one interface. Local disk by default so development needs no cloud account; S3-compatible when `S3_BUCKET` is set. Uploads go direct to storage — a 200MB video streamed through Node would occupy a request worker for the whole transfer |
| Image metadata | Dimensions parsed from file headers, dependency-free. sharp/ImageMagick is a native binary pulled in to read a handful of bytes, and is only genuinely needed for variant generation, which belongs on the job queue |
| System email | Separate from the (future) campaign pipeline, so a campaign backlog can never delay a password reset and an unsubscribe can never suppress one |
| OpenAPI | Generated from code from the first endpoint (§19). `@RequirePermission` emits `x-required-permission` into the document, so the docs are derived from the enforcement and cannot drift from it |

---

## Status

### Phase 0 — Foundations ✅

Per §19, the exit criterion is: *"you can sign up, create an org and a site, invite someone, and
switch between sites."* All of it works.

- Monorepo, CI, Docker Compose environment, Prisma migrations, base entity conventions
- Auth: register, login, refresh, logout, password reset, email verification, sessions
  - argon2id, breach-checked passwords via k-anonymity, per-email and per-IP rate limits with
    exponential lockout, refresh-token rotation with **reuse-triggered family revocation**
- Organisations, members, invitations with per-site grants, ownership transfer, last-owner guard
- Workspaces: create, update, archive/restore, 30-day soft delete with typed confirmation
- Roles and the complete §3.3 permission matrix, including computed org-admin inheritance
- The `authorize()` guard, the tenant-scoped base repository, RLS policies
- **The tenant-isolation suite**, wired into CI as a merge blocker
- Audit logging and the transactional outbox for domain events
- Admin portal: app shell, workspace switcher (⌘\, search, recents, route preservation),
  onboarding, site settings with danger zone, members, audit log, design-system primitives and
  the six cross-cutting UI states of §17.18

**Verified:** 235 tests pass (223 API, 12 shared). API and portal typecheck and build clean.
Exercised against a real Postgres and the **live Resend API** — login, role denial, org-admin
inheritance, archive read-only, refresh-token theft detection, cookie flags, schema-change
guardrails, the draft-versus-publish validation split, versioning retention, scheduling, and a
real signed file upload through the presigned-URL flow.

The isolation suite covers **76 workspace-scoped routes** (every one the app registers), and
row-level security is enabled and forced on **27 of 27** tables carrying `workspace_id`.

### Phase 1 — Content core ✅

Exit criterion per §19: *"a team can model and publish real content."* That works end to end.

- **Content type builder** — runtime schemas, 22 field types, the full §7.1 schema-change safety
  table: immutable API IDs, safe-widening-only type changes, two-step field deletion with an
  impact check, required-field warnings, `schema_version` bumped on every change
- **Entries** — draft/publish validation split, merge-not-replace updates, optimistic concurrency,
  soft edit locks, slug generation
- **Versioning** — a snapshot per save, restore-as-new-version, retention of the last 50 plus
  every version ever published
- **Publish lifecycle** — publish, unpublish, archive, schedule, auto-expiry, and the
  queue-backed `publish-scheduled-content` scheduler
- **Taxonomies** — flat and hierarchical, nested-tree responses, term merge that re-parents
  children, guards against deleting a branch by mis-click
- **Menus** — up to three levels, atomic whole-tree replace (never observed half-rebuilt),
  entry and term references verified against the site before saving
- **Media library** — direct-to-storage uploads via presigned URLs, so file bytes never pass
  through the API. Pluggable driver: S3-compatible (AWS/R2/MinIO) when `S3_BUCKET` is set, local
  disk otherwise so `npm run dev` needs no cloud account. Uploads are verified on completion —
  real size, magic-byte type check, image dimensions — and usage is tracked so "used in 4 places"
  appears **before** deletion, not as a broken image afterwards
- **Admin UI** — content type builder, content list, schema-driven entry editor with version
  history, media library with a picker wired into media fields, taxonomy term manager, and a menu
  builder with a live API preview; the sidebar lists content types dynamically

### Email — organisation-level Resend ✅

Not in Phase 1 of the spec, but built here on request and it changes the §5.5 model:

- Organisations hold **several** email configurations (per brand, region, or environment)
- API keys verified against Resend on entry, **encrypted at rest** (AES-256-GCM, rotatable
  key ids), never returned by any endpoint
- **Per-configuration webhooks** at `/webhooks/email/:configId` with Svix signature verification,
  timestamp replay protection, and rotation-tolerant multi-signature checking
- Each site selects a configuration from a dropdown and sets its preferred from-address; addresses
  are validated against the domains **Resend reports as verified**, not taken on trust

### Not yet built

Most product/UI work for Phases 3–7 — audience management screens, campaign sending, automations
and analytics. Phase 2's backend contract now exists: API key create/list/update/rotate/revoke,
Postgres-backed per-key and subscriber-write/IP rate limits, request
logs and summaries, `GET /v1/me`, content type reads, published entry reads, search, taxonomies,
menus, media, subscribers, lists, forms, preview tokens and outbound webhooks.
The portal shows the later routes and says so rather than presenting empty shells.

Three Phase 1 refinements remain, each marked in code:
- **Rich text** stores and validates a structured document (Open Decision #3), but the editor
  writes that JSON directly. A block editor is substantial UI in its own right; the stored shape
  will not change when it lands.
- **Relation fields** take entry ids directly. The Delivery search endpoint now exists; the admin
  picker UI still needs to consume it. Media fields — the far more common case — have a real picker.
- **Image variants and blurhash** (§4.6 `media-transform`) are not generated. The queue
  foundation now exists; the media-transform processor and image pipeline still land with Phase 2.

Two items are deliberately stubbed and marked in code:
- **Starter content models** are recorded on the `workspace.created` event but not provisioned.
  Now that content types exist, this is a small piece of work.
- **MFA** has schema and a login challenge path; TOTP enrolment lands with the security work.

---

## Commands

| Command | What it does |
|---|---|
| `npm run db:up` / `db:down` | Start / stop Postgres and Mailhog |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:rls` | Apply the row-level security policies — **run after every migration** |
| `npm run db:seed` | Seed the development organisation, sites and users |
| `npm test` | Every test in the monorepo |
| `npm run test:isolation` | The tenant-isolation suite alone |
| `npm run openapi` | Emit `openapi-admin.json`, failing on undocumented endpoints |

---

## Adding a tenant-owned table (Phase 1 onwards)

Four steps. The first three have automated guards; skipping any of them fails CI.

1. Add the model with `workspaceId` `NOT NULL`, first in every composite index, and
   workspace-scoped uniqueness (`@@unique([workspaceId, slug])`, never `@@unique([slug])`).
2. Add the table name to the policy loop in `apps/api/prisma/rls.sql`. A table carrying
   `workspace_id` without RLS fails both the script's own verification block and the isolation
   suite.
3. Add the model name to `TenantModelName` in `src/common/tenant-repository.ts`.
4. Add every new workspace-scoped route to `WORKSPACE_SCOPED_ROUTES` in the isolation suite. The
   coverage test fails if you do not.
