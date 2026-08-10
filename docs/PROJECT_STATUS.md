# Multi-Site CMS & Audience Platform — Project Status

**Last updated:** 7 August 2026
**Source specification:** `CMS_Platform_Design_Spec.md` v1.0
**Completed:** Phase 0 (Foundations), Phase 1 (Content core), organisation-level Resend email configuration, Postgres-backed job queue, and the Phase 2 backend Delivery API/developer-platform contract
**Next milestone:** Phase 3 — Audience product workflows, plus Phase 2 polish (SDK, playground and docs site)

This document is the single place that answers three questions: what this product is, what
actually works today, and what remains. The "what remains" section is deliberately exhaustive —
it is meant to be worked from, not skimmed.

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [How it is built](#2-how-it-is-built)
3. [Current status](#3-current-status)
4. [What remains — Phase 1 leftovers](#4-what-remains--phase-1-leftovers)
5. [What remains — Phase 2: Delivery API & developer platform](#5-what-remains--phase-2-delivery-api--developer-platform)
6. [What remains — Phase 3: Audience](#6-what-remains--phase-3-audience)
7. [What remains — Phase 4: Email sending](#7-what-remains--phase-4-email-sending)
8. [What remains — Phase 5: Automations & analytics](#8-what-remains--phase-5-automations--analytics)
9. [What remains — Phase 6: Documentation & polish](#9-what-remains--phase-6-documentation--polish)
10. [What remains — Phase 7: Scale & enterprise](#10-what-remains--phase-7-scale--enterprise)
11. [Cross-cutting infrastructure debt](#11-cross-cutting-infrastructure-debt)
12. [Known limitations in what is built](#12-known-limitations-in-what-is-built)
13. [Open decisions still outstanding](#13-open-decisions-still-outstanding)

---

## 1. What this is

A **multi-tenant, headless-first Content Management and Audience platform**. One deployment serves
many organisations; each organisation manages many websites.

It owns three things a marketing website needs and rarely has in one place:

1. **Content** — structured, versioned, scheduled, multilingual.
2. **Audience** — subscribers, lists, segments, form submissions.
3. **Email** — sender configuration, campaigns, automations, deliverability metrics.

It does **not** render the public website. The customer's site is built and hosted independently
(Next.js, Astro, WordPress, a mobile app — anything that can make an HTTP request) and consumes a
read API.

### The hierarchy

```
Organisation                      the tenant — billing, member directory, email provider accounts
   │
   ├── Workspace ("Site")         the isolation boundary — all content lives here
   │      ├── Content types & entries
   │      ├── Taxonomies, terms, menus
   │      ├── Media assets
   │      ├── Subscribers, lists, segments, forms      (backend foundation built; UI/workflows next)
   │      ├── Sender identities, campaigns, automations (partially built)
   │      ├── API keys                                  (built)
   │      ├── Webhooks                                  (built)
   │      └── Settings, audit log
   │
   └── Workspace ("Site B") …
```

**Terminology rule:** the entity is a **Workspace** in code, database and API; it is labelled
**"Site"** in the admin UI, because that is what it means to the user. `workspace_id` in the API,
"Site" in the sidebar. The two are never mixed within a surface.

### Two API planes

|  | **Admin API** | **Delivery API** |
|---|---|---|
| Consumer | The admin portal | The customer's website |
| Auth | User session (cookie/JWT) | API key |
| Scope | Management, all writes | Published content read, audience write |
| Base path | `/admin/v1/…` | `/v1/…` |
| Status | **Built** | **Built backend contract** — key auth, `/v1/me`, content/search/media/audience/forms/preview |

Keeping these separate is the single most important structural decision in the system: a leaked
website key can never touch org settings, billing, members, or another workspace.

### Personas

| Persona | Uses | Cares about |
|---|---|---|
| Org Owner | Billing, workspaces, members | Cost, control, who has access |
| Site Admin | One workspace end to end | Site health, publishing velocity |
| Editor / Author | Content only | Fast, distraction-free writing |
| Marketer | Audience + Email | List growth, open rates |
| Developer | API + docs | Clear contracts, good errors, fast onboarding |

### Explicitly out of scope (v1)

Public site rendering, theme engine, page builder, e-commerce, SMS/push channels, a native mobile
admin app, and a visual drag-and-drop website builder.

---

## 2. How it is built

### Stack

| Layer | Choice |
|---|---|
| API | NestJS + TypeScript (Open Decision #1) |
| Database | PostgreSQL 16, Prisma ORM |
| Admin portal | React + TypeScript + Vite, TanStack Query, Tailwind |
| Shared code | `@cms/shared` — permissions, error codes, public ids, wire types |
| Email provider | Resend, configured per organisation |
| Object storage | S3-compatible, or local disk in development |
| Background jobs | A `jobs` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`. No broker — see §11.1 |

### Repository layout

```
packages/shared/     Permissions, roles, error codes, public ids, wire types.
                     Imported by API and portal, so rules are defined once.
apps/api/            NestJS Admin API, Prisma schema, RLS policies, tests.
apps/admin/          React admin portal.
docs/                Architecture notes and this document.
```

### Tenant isolation — the load-bearing property

Enforced **four times**, deliberately. Each layer catches a different class of mistake:

| Layer | Catches | Where |
|---|---|---|
| Request context | A caller specifying their own scope via the request body | `src/auth/request-context.guard.ts` |
| `authorize()` | A handler reachable by the wrong role | `src/auth/authorize.ts` |
| `TenantRepository` | A repository method written without a workspace filter | `src/common/tenant-repository.ts` |
| Row-level security | Raw queries, ORM escape hatches, future developers | `prisma/rls.sql` |

RLS works only because the application connects as `cms_app` — a role that is **not** the table
owner and carries `NOBYPASSRLS`. If `DATABASE_URL` is ever pointed at the owner role, every policy
silently stops applying.

**The isolation suite is a CI merge blocker.** It builds two complete tenants, then asserts
neither can reach the other over HTTP, through the repository, and at the database. It also
enumerates the app's registered routes and **fails if a workspace-scoped route has no isolation
test** — so adding an endpoint without a test breaks the build.

---

## 3. Current status

### Verified metrics

| Metric | Value |
|---|---|
| Tests passing | **235** (223 API, 12 shared) |
| Registered routes | 132 total — 76 workspace-scoped, 17 org-scoped |
| Isolation coverage | 76 of 76 workspace-scoped routes |
| RLS coverage | 27 of 27 tables carrying `workspace_id` |
| Database tables | 36 public tables |
| Documented OpenAPI paths | 121 total — 99 Admin, 22 Delivery |
| Migrations | 6 |
| Source size | ~18,700 lines API, ~5,800 lines portal, ~3,200 lines tests |

Both apps typecheck and build clean. The full flow has been exercised against a real PostgreSQL
instance and the **live Resend API**. `npm run lint --if-present` is currently blocked because
neither app workspace has a resolvable `eslint` binary installed.

### Phase 0 — Foundations ✅

Spec exit criterion: *"you can sign up, create an org and a site, invite someone, and switch
between sites."*

- Monorepo, CI pipeline, Docker Compose environment, Prisma migrations
- **Auth** — register, login, refresh, logout, password reset, email verification, session list
  - argon2id hashing; passwords checked against breach corpora via k-anonymity
  - Rate limits: 5 failed logins per email / 15 min, 20 per IP, with exponential lockout
  - Refresh-token rotation with **reuse-triggered family revocation** (theft detection)
  - HttpOnly cookies; the refresh cookie is scoped to the refresh endpoint only
- **Closed registration** (a spec deviation) — `POST /admin/v1/auth/register` is open only while
  no organisation has an owner or admin. That first registration bootstraps the platform and is
  signed in immediately; every later one requires a signed-in owner or admin and does *not* issue
  a session, so the caller keeps their own. The gate counts administrators rather than users, so a
  half-finished signup cannot wedge the platform shut before an admin exists.
  `POST /admin/v1/orgs` carries the **same** gate, because creating an organisation makes the
  caller its Owner — without it, an account an admin created could promote itself and the
  registration gate would be decorative. Both live in `common/platform-admins.service.ts`.
  After bootstrap, people join an organisation by invitation.
- **Organisations** — CRUD, members, invitations with per-site grants, ownership transfer,
  last-Owner guard
- **Workspaces** — create, update, archive/restore, 30-day soft delete with typed confirmation
- **Roles** — the complete §3.3 permission matrix (37 workspace + 9 org permissions), including
  computed org-Owner/Admin inheritance of Site Admin
- **Audit log** — append-only, enforced by revoking UPDATE/DELETE from the app role
- **Domain events** — transactional outbox table
- **Portal** — app shell, workspace switcher (`⌘\`, search, recents, route preservation),
  onboarding, site settings with danger zone, members, audit log, design-system primitives, and
  the six cross-cutting UI states of §17.18

### Phase 1 — Content core ✅

Spec exit criterion: *"a team can model and publish real content."*

- **Content type builder** — runtime schemas, 22 field types, and the complete §7.1 schema-change
  safety table: immutable API IDs, safe-widening-only type changes, two-step field deletion with
  an impact check, required-field warnings, `schema_version` bumped on every change
- **Entries** — draft/publish validation split, merge-not-replace updates, optimistic concurrency,
  soft edit locks, slug generation
- **Versioning** — a snapshot per save, restore-as-new-version, retention of the last 50 plus
  every version ever published
- **Publish lifecycle** — publish, unpublish, archive, schedule, auto-expiry, and the
  queue-backed `publish-scheduled-content` sweep
- **Taxonomies** — flat and hierarchical, nested-tree responses, term merge that re-parents
  children
- **Menus** — three levels, atomic whole-tree replace, reference validation
- **Media** — direct-to-storage presigned uploads, post-upload verification (real size, magic-byte
  type check, dimensions), usage tracking, folders
- **Portal** — content type builder, content list, schema-driven entry editor with version
  history, media library with picker, taxonomy term manager, menu builder with live API preview

### Email configuration ✅ (ahead of schedule, and a spec deviation)

Built on request; it changes the §5.5 model. Organisations hold **several** Resend configurations;
each site picks one and sets a preferred from-address.

- API keys verified against Resend on entry, encrypted at rest (AES-256-GCM, rotatable key ids),
  never returned by any endpoint
- **Per-configuration webhooks** at `/webhooks/email/:configId`, Svix signature verification,
  timestamp replay protection, rotation-tolerant multi-signature checking
- From-addresses validated against the domains Resend reports as verified

**What this does *not* yet do:** actually send anything. The configuration is stored, verified and
addressable; the send pipeline is Phase 4.

### Background jobs ✅ (Postgres-backed)

Jobs are rows in the `jobs` table, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. There is no
broker and no Redis: Postgres is the only datastore this platform requires. `publish-scheduled-content`
is a recurring row rather than an in-process interval, so several API instances share one schedule;
tests still drive the sweep directly through `SchedulerService.tick()`.

The shared job layer defines the twelve spec job names. Three have processors —
`publish-scheduled-content`, `webhook-deliver` and `key-usage-flush`. The rest are Phase 2+ work.

### Phase 2 — Delivery API and developer platform backend ✅

- `api_keys` table with workspace-scoped RLS and isolation-suite coverage
- Admin endpoints to list, create, update, rotate and revoke keys under
  `/admin/v1/workspaces/:id/api-keys`
- Key format `pk_live_...`, `pk_test_...`, `sk_live_...`, `sk_test_...`; SHA-256 hash stored,
  plaintext returned exactly once
- Scope validation, publishable-key server-scope rejection, publishable origin allowlists,
  secret-key IP restrictions, optional expiry
- Delivery API key guard with specific errors for missing, invalid, revoked, expired, archived,
  suspended, origin/IP and scope failures
- No key-auth cache: every Delivery request resolves the key from the database, so revocation takes effect on the very next request
- Postgres fixed-window per-key rate limiting, 10-second burst windows, subscriber-write/form-submit
  per-IP overlays, per-key overrides and `X-RateLimit-*` response headers
- `api_request_logs` table, recent per-key request-log endpoint and aggregate summary endpoint
- `GET /v1/me`, authenticated by any valid API key, echoing workspace, scopes and limits
- Delivery reads for content type schemas, published entries by list/slug/id, related entries,
  search, taxonomies/terms, resolved menus and completed media assets
- Subscriber/list/form Delivery endpoints, short-lived preview tokens, outbound webhooks with
  encrypted signing secrets and replayable delivery records
- Separate generated `openapi-admin.json` and `openapi-delivery.json`

- Admin portal **API keys screen** — list, create with a show-once reveal panel, edit scopes and
  restrictions, rotate with a grace-period choice, and revoke behind a typed confirmation. The
  create form hides server-only scopes when the type is publishable, so the API's 422 for that
  combination is unreachable from the UI rather than merely handled.

**Still missing from Phase 2 polish:** GitHub secret-scanning partner auto-revoke, "unused for
90 days" notifications, plan-ceiling enforcement, SDK/embed/CLI packages, hosted docs/playground,
dynamic per-workspace OpenAPI expansion, CDN purges and response-cache invalidation, request-log
partition/retention automation, redacted header snapshots, and webhook failure notification
emails.

---

## 4. What remains — Phase 1 leftovers

Three items were consciously deferred rather than half-built. Each is marked in code.

### 4.1 Rich-text block editor · Large · Spec §7.3

**State:** the `rich_text` field stores and validates a structured JSON document (Open Decision #3
— never an HTML blob). The editor currently exposes that JSON directly in a textarea.

**Needed:** a TipTap/ProseMirror block editor supporting paragraph, H2–H4, bullet and numbered
lists, quote, code block with language, divider, table, image (from the media library), embed
(YouTube/Vimeo/X/generic oEmbed), callout, button/CTA, and custom component blocks defined by the
content type.

**Also needed:** a floating toolbar on selection, a `/` slash-command menu for block insertion, and
a document outline in the editor's left rail that scroll-syncs with headings.

**Gotchas:** the stored shape must not change when this lands — the schema is already correct, so
this is purely an editing surface. The Delivery API's optional `?format=html` rendering (§7.3) is
a separate piece of work that must produce the same output the editor previews.

**Depends on:** media library (done).

### 4.2 Relation field picker · Built · Spec §17.5

**State:** built. `relation_one` and `relation_many` render a searchable combobox
(`components/EntryPicker.tsx`) showing each candidate's title and status, with keyboard
navigation, debounced search and chips for the current selection. Ids already stored are resolved
back into titles, and a reference whose target has been deleted renders as "Missing entry" in the
danger colour rather than silently looking fine.

The content-type builder now asks which type a relation points at (`config.relationTypeApiId`) and
refuses to create a relation field without one — the column already existed in `FieldConfig` but
nothing ever populated it, so every relation field was untargetable.

Menu items reuse the same picker behind a content-type selector, because a menu may link to an
entry of any type and entry search is per-type.

**Fixed along the way:** admin entry search matched only `slug`, despite a comment claiming it
searched the jsonb. An entry called "Designing a Multi-Site CMS" with the placeholder slug
`untitled` was unfindable by name. Search now matches `slug` *or* the field values, via a bounded
raw pre-filter (500 ids) whose results feed the normal query so sorting, cursor pagination and the
count are unaffected. Postgres FTS replaces the pre-filter (§11.4).

### 4.3 Image variants and blurhash · Medium · Spec §4.6, §8.1

**State:** dimensions are extracted from file headers on upload, dependency-free. No derivatives
are generated.

**Needed:** the `media-transform` worker — responsive variants at configurable widths (default
320/640/1024/1600/2400), a WebP/AVIF version, and a blurhash placeholder.

**Also in §8.1 and not yet built:** multipart/chunked upload with pause/resume, deduplication by
SHA-256 checksum with a "this file already exists" prompt, SVG sanitisation (strip scripts), and
EXIF stripping with an opt-out.

**Gotchas:** this needs `sharp` (a native binary) and belongs on the **job queue**, not in the
upload request — generating derivatives inline makes uploads slow and failure-prone. The queue
now exists; the `media-transform` processor and image pipeline do not.

### 4.4 Content module gaps

Smaller items from §7 that are specified but not built:

| Item | Spec | Size | Notes |
|---|---|---|---|
| **Localisation UI** | §7.5 | Medium | Schema supports it (`locale`, `translation_group_id`, per-field `localised`). Missing: locale switcher in the editor, translation-status badges (`Not started` / `Outdated` / `Up to date`), "copy from default locale", side-by-side translation view, per-locale publish states, locale-completeness column |
| **Review workflow UI** | §7.2 | Small–Medium | `review_requests` table and the `in_review` / `changes_requested` states exist and are enforced on publish. Missing: submit-for-review dialog with assignee, reviewer notification, approve/reject actions, comment threads |
| **Entry comments** | §5.2, §17.5 | Medium | Table not yet created. Needs threaded comments, `@` mentions with notification, resolve/unresolve, and field-anchored comments |
| **Version comparison** | §7.4 | Medium | Restore works. Missing: side-by-side field-level diff with word-level highlighting inside text fields |
| **Autosave** | §7.3 | Small | Editor saves on demand (`⌘S`) with an explicit dirty bar. Spec asks for autosave every 3s of inactivity — never over a published version |
| **Saved views** | §7.7, §17.4 | Medium | Content list has fixed status tabs. Missing: named filter combinations, pinned as tabs, personal or shared |
| **Bulk actions** | §7.7 | Medium | Missing entirely: publish, unpublish, archive, delete, assign taxonomy, change author, duplicate, export — running as background jobs above 100 items |
| **Column configuration** | §7.7 | Small–Medium | Fixed columns today. Spec wants user-configurable columns for any field, saved per user per type |
| **Preview UI** | §7.8 | Medium | Short-lived (15 min) single-entry preview tokens and `/v1/preview/{token}` are built. Missing: per-type preview URL patterns and editor Preview-button wiring |
| **Duplicate entry** | §7.7 | Small | Row action not implemented |
| **Global search (`⌘K`)** | §7.9 | Medium | Command palette is a placeholder button. Needs workspace-wide search across entries, media, subscribers, campaigns and settings |
| **Starter content models** | §6.2 | Small | The chosen model is recorded on the `workspace.created` event but not provisioned. Now unblocked — content types exist |
| **Media library extras** | §8.2 | Medium | Missing: folder tree with drag-to-move, list view toggle, multi-select with bulk move/tag/delete/zip, replace-file (keeping the same id and URL), focal-point/crop tool, EXIF handling |

---

## 5. What remains — Phase 2: Delivery API & developer platform

**Spec estimate:** 3–4 weeks. **This is the first genuinely shippable milestone** — everything
before it is internal. A website cannot be built against this platform until Phase 2 exists.

### 5.1 API keys · Backend built · Spec §12.1

**Built:** key format `{type}_{env}_{random}`, 32 bytes CSPRNG base62, SHA-256 hash storage,
plaintext shown exactly once, publishable and secret keys, live/test environments, the seven spec
scopes, publishable-key server-scope rejection, publishable origin allowlists, secret-key IP/CIDR
restrictions, optional expiry, list/create/update/rotate/revoke admin endpoints, audit entries,
synchronous revocation through the database authority, Postgres-backed per-key rate limits,
optional per-key rate-limit overrides, and
Site Admin / org Owner/Admin email notices on revocation.

**Still needed:** GitHub secret-scanning partner integration with auto-revoke, and "unused for
90 days" notifications.

### 5.2 Delivery API endpoints · Large · Spec §14.4

Target Delivery API surface. Public reads and writes are scoped by the authenticated API key's
workspace, except unauthenticated health and preview-token reads:

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/content-types` | `content.read` |
| GET | `/v1/content-types/{api_id}` | `content.read` |
| GET | `/v1/content/{type}` | `content.read` |
| GET | `/v1/content/{type}/{slug}` | `content.read` |
| GET | `/v1/content/id/{id}` | `content.read` |
| GET | `/v1/content/{type}/{slug}/related` | `content.read` |
| GET | `/v1/search` | `search.read` |
| GET | `/v1/taxonomies`, `/v1/taxonomies/{api_id}/terms` | `content.read` |
| GET | `/v1/menus`, `/v1/menus/{api_id}` | `content.read` |
| GET | `/v1/media`, `/v1/media/{id}` | `media.read` |
| POST | `/v1/subscribers` | `subscriber.write` |
| GET/PATCH | `/v1/subscribers/{email}` | `subscriber.read` / `.write` |
| POST | `/v1/subscribers/{email}/unsubscribe` | `subscriber.write` |
| GET | `/v1/lists` | `subscriber.read` |
| POST | `/v1/forms/{api_id}/submit` | `form.submit` |
| GET | `/v1/forms/{api_id}` | `content.read` |
| GET | `/v1/preview/{token}` | — |
| GET | `/v1/health` | — (already built) |
| GET | `/v1/me` | any — **built**; echoes the key's workspace, scopes and limits |

**Query features required across content endpoints (§14.1):**
cursor pagination (`?limit=&cursor=`), sorting (`?sort=-published_at,title`), filtering
(`?filter[status]=published&filter[data.featured]=true&filter[published_at][gte]=…`), field
selection (`?fields=id,slug,data.title`), relation expansion (`?expand=author,data.hero_image`),
and locale with per-workspace fallback behaviour.

**Menu link resolution:** menu items pointing at an entry must resolve to the entry's *current*
slug at delivery time, so renaming a slug never breaks a menu (§7.6).

**State:** `/v1/health`, `/v1/me`, content-type schema reads, published-entry list,
published-entry-by-slug/id, related entries, search, taxonomies/terms, resolved menus,
completed-media reads, subscriber/list/form endpoints and preview-token reads are built.
Cursor pagination, sorting, filtering, field selection and locale fallback are implemented for
content reads. Still needed: relation expansion (`expand=`), and richer rich-text rendering options.
Search is now Postgres FTS (§11.4).

### 5.3 Key authentication pipeline · Medium · Spec §12.2

Ten ordered steps, each short-circuiting with a **specific** error code — `missing_api_key`,
`invalid_api_key`, `key_revoked`, `key_expired`, `workspace_archived`, `workspace_suspended`,
`origin_not_allowed`, `ip_not_allowed`, `rate_limit_exceeded`, `insufficient_scope`.

The spec is blunt about why: *"Every error response names the required scope or the failing
condition. Vague auth errors are the number-one cause of integration support tickets."*

**State:** implemented for missing, invalid, revoked, expired, archived, suspended, origin/IP,
rate-limit and scope failures.

### 5.4 Rate limiting · Medium · Spec §12.3

Fixed-window counters **in Postgres**, keyed by API key. Defaults: publishable 300 req/min, secret
1,000 req/min, subscriber-write 30 req/min per IP additionally. Every response carries
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Burst allowance of 2× for 10
seconds. Per-key overrides within plan ceilings.

**State:** per-key Postgres fixed-window limits are built for API-key-authenticated routes, with
configurable publishable/secret defaults, per-key overrides, 10-second burst windows,
subscriber-write/form-submit per-IP overlays and response headers. Still needed: plan-ceiling
enforcement once billing/plan limits are active.

### 5.5 Caching and invalidation · Medium · Spec §4.5

| Layer | What | TTL | Invalidation |
|---|---|---|---|
| CDN / edge | Delivery GET responses | 60s, per-workspace override | Purge by surrogate key on publish |
| — | Resolved entries by `(workspace, type, slug, locale)` | not built | would need an in-process or database cache |
| — | API key auth | **not cached** — resolved from the database per request, so revocation is immediate |
| Postgres | Rate-limit counters | fixed window | arithmetic; swept by `key-usage-flush` |
| Application | Content type schemas | 10 min | Delete on schema change |

Every Delivery response must carry `ETag` and `Cache-Control`. Publishing emits
`content.published`, which purges the CDN surrogate key `ws-{id}-type-{type}`.

**State:** API key auth caching, rate-limit counters, and `Cache-Control`/`ETag` headers on the
Delivery GET endpoints are built. Content response caching, content schema caching and CDN
surrogate-key purges remain.

### 5.6 Request logging · Medium · Spec §5.6, §12.5

`api_request_logs` partitioned daily, retained 30 days. Powers the logs UI: request-volume chart,
error-rate chart, p50/p95/p99 latency chart, and a filterable table (key, status class, endpoint,
time range) with expandable rows showing redacted headers and a `request_id`.

This data also feeds the dashboard's "Top content" card — the platform knows which entries a
customer's site actually fetches, which the spec notes "no headless CMS competitor gives you for
free."

**State:** basic `api_request_logs` persistence is built for authenticated Delivery requests,
including key, method, path, status, error code, IP, origin, user agent and duration. Admins can
read the 50 most recent rows per key and request an aggregate summary with totals, status buckets,
top paths, top keys and hourly/daily time series. The **admin UI is built**: a 24h/7d/30d range
selector, request/error-rate/p50/p95/p99 stat tiles, requests-over-time and error-rate-over-time
charts, a status-class breakdown, top endpoints, traffic by key, and a per-key recent-request
table with status and path filters.

Requests and error rate are two charts rather than one chart with two y-axes. A healthy workspace
has thousands of requests and single-digit errors, so a shared axis flattens the error series onto
zero and hides the one thing the screen exists to show.

Still needed: partitioning/retention automation, redacted header snapshots, persisted rollups, and
a **workspace-wide request log endpoint** — the API exposes individual requests only per key and
only the newest 50, so the UI's key selector is a backend constraint and its status/path filters
run client-side over those 50 rows.

### 5.7 Webhooks · Medium–Large · Spec §12.4

Outbound callbacks on domain events. The `webhook_endpoints` and `webhook_deliveries` tables are
built and covered by workspace-scoped RLS; the `webhook-deliver` job drains workspace-owned
`domain_events` into delivery rows and dispatches pending deliveries.

- Signature `X-Signature: t=…,v1=<hmac-sha256 of "t.body">`, 5-minute tolerance, `X-Event-Id` for
  receiver-side idempotency
- At-least-once delivery, 10s timeout, retries at 1m/5m/15m/1h/6h/12h/24h (8 attempts), then
  dead-lettered
- 15 consecutive failures auto-disables the webhook
- UI: deliveries table, expandable request/response bodies, Replay button, Send test event

**State:** backend endpoints are built for list/create/delete webhooks, list deliveries, send test
event and replay delivery. Delivery signing, retry schedule, dead-lettering and auto-disable are
implemented. The **admin UI is built**: endpoint list with failure counters, grouped event picker
(or "everything", which subscribes to `*` including future event types), show-once signing secret,
send-test, and an expandable delivery log showing the exact payload sent, the response body that
came back, the error, the attempt number and the next retry time, with Replay per delivery. Still
needed: failure-notification emails.

### 5.8 OpenAPI, docs site and playground · Medium · Spec §15

- `openapi-admin.json` and `openapi-delivery.json` are generated today.
- Hosted reference (Scalar or Swagger UI) with try-it-out, a key dropdown populated from the
  signed-in user's workspace, and auto-generated code samples in cURL/JS/TS/Python/PHP/Go/Ruby
- **Per-workspace dynamic docs** — `GET /admin/v1/workspaces/{id}/openapi.json` expanding the
  workspace's actual content types into concrete paths (`/v1/content/blog_post`) with real field
  schemas. The spec calls this "the highest-value documentation feature in the product"
- **Playground** — endpoint picker, key picker, parameter form with autocomplete from the
  workspace's real content types and slugs, response viewer, copy-as-cURL/JS/Python/PHP.
  Playground requests must be tagged in the logs so they do not pollute production metrics

### 5.9 SDK, embed script and CLI · Medium · Spec §12.6

- `@yourcms/client` JS SDK with typed responses, automatic retries with backoff, response caching
  and preview-mode support
- Zero-code embed script for subscriber capture
- `npx @yourcms/cli` — `login`, `types generate`, `content pull/push`, `migrate`

**State:** not yet built. The generated Delivery OpenAPI document now gives these packages a
stable contract to target.

### 5.10 Preview tokens · Small–Medium · Spec §7.8

Short-lived (15 min), single-entry, preview-scoped tokens minted by the editor's Preview button,
resolved by `GET /v1/preview/{token}`.

**State:** token minting endpoint and unauthenticated preview-token read are built. Still needed:
per-content-type preview URL patterns and editor Preview-button wiring.

---

## 6. What remains — Phase 3: Audience

**Spec estimate:** 3 weeks. Phase 2 created the backend foundation for subscribers, lists, public
forms and form submissions. What remains here is the actual audience product: admin UI, imports,
segments, double opt-in, compliance workflows and richer lifecycle handling.

### 6.1 Subscribers · Large · Spec §5.4, §9.1

The `subscribers` table and Delivery API upsert/lookup/update/unsubscribe endpoints exist with
custom attributes (jsonb), tags and the `subscribed / unsubscribed / bounced / complained`
statuses. Still needed: admin management UI, `pending`/`cleaned` lifecycle states, engagement
score, and full **consent evidence**: signup IP, signup URL, the exact consent text displayed, and
the double opt-in timestamp.

**The suppression list must be checked before every individual send, with no exception path** —
not before the batch, before each message. The spec notes this is what keeps you off blocklists.

`complained` is permanent and irreversible, with no admin override.

### 6.2 Lists and double opt-in · Medium · Spec §9.3

Audience lists and membership rows exist and are exposed through Delivery list/form endpoints.
Still needed: admin list management, per-list double opt-in, confirmation and welcome templates,
signed single-use 7-day confirmation tokens, and expiry cleanup for unconfirmed records.

### 6.3 Segments · Large · Spec §9.4

Saved rule trees evaluated as SQL. Nested AND/OR groups; 20 operators (`eq`, `neq`, `contains`,
`in`, `within_last`, `is_set`, …); rule fields covering email, status, tags, list membership, any
custom attribute, signup source and date, language, engagement (opened/clicked a specific campaign
within N days), last activity, bounce count, engagement score, and automation membership.

**Open Decision #5** chose evaluation **at send time** for correctness, with a cached count for
the UI.

**Builder UI:** nested groups with drag-to-reorder, a live "≈ 4,281 subscribers match" count on a
500ms debounce, and a preview table.

### 6.4 Forms · Medium–Large · Spec §9.6

The `forms` and `form_submissions` tables exist, public form schemas can be read, and form
submissions create/update subscribers and list membership. Still needed: the form builder UI,
field-type validation beyond the stored schema, double opt-in, success behaviour controls, spam
protection (honeypot, CAPTCHA, per-IP rate limit, origin allowlist), and internal notification
recipients.

Three integration paths, each with copy-ready code: JS embed, HTML + endpoint, API only.

### 6.5 Import and export · Medium · Spec §9.2

CSV import with a 4-step wizard: upload → column mapping with auto-match → options (target lists,
tags, duplicate handling, status, whether to trigger automations, and a **blocking consent
affirmation**) → review and import. Background processing at ≥10,000 rows/minute with a
downloadable per-row error report.

Export to CSV via a background job that emails a signed link.

### 6.6 Compliance · Medium · Spec §9.7

- Hosted **preference centre** — change list membership, set frequency, update details, or
  unsubscribe entirely, via a signed link with no login
- GDPR: data export (portability), erasure with a tombstone hash so the address stays suppressed,
  configurable retention, consent evidence storage
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers (one-click unsubscribe is now required by
  major mailbox providers)

---

## 7. What remains — Phase 4: Email sending

**Spec estimate:** 4–5 weeks. *"This is the phase where the product becomes distinctive."*

Sending **configuration** is built (see §3). Everything that actually sends is not.

### 7.1 Sender identities and domain authentication · Large · Spec §10.1

Current implementation validates from-addresses against domains Resend already reports as
verified. The spec's full flow is richer:

- **Single-address verification** — platform asks the ESP to create the identity, ESP emails the
  address, platform polls or receives a webhook, status flips to `verified`. Resend button
  rate-limited to once per 5 minutes.
- **Domain authentication** — request DKIM keys from the provider, display the record table
  (3× DKIM CNAME, SPF TXT, return-path CNAME, DMARC TXT) with per-row copy buttons and
  **independent per-row status**, a "Check records now" button running live DNS resolution,
  auto-recheck every 30 minutes for 72 hours then daily, and provider-specific guides
  (Cloudflare, GoDaddy, Route 53, Namecheap) with screenshots.
- An **"Email these instructions to a developer"** action — §17.13 notes, correctly, that the
  person configuring DNS is usually not the person looking at this screen.

The `sending_domains` table (§5.5) is **not yet created**.

### 7.2 Sending guardrails · Medium · Spec §10.2

**Cannot send** if: no verified sender identity, no valid unsubscribe link, no physical address
configured, audience resolves to zero recipients, or the monthly quota is exhausted.

**Warn (non-blocking)** if: DMARC absent, reply-to unset, subject empty or over 60 characters,
spam-score flag, or unreachable link URLs.

Send limits: per-plan monthly quota, per-hour throttle matched to the ESP rate, and a warm-up ramp
for new domains (200/day for 3 days, then doubling).

### 7.3 Campaign builder · Large · Spec §11.1

Five steps with a persistent readiness checklist: Setup → Audience → Content → Review → Schedule.

- **Setup:** live inbox preview showing how sender/subject/preheader appear in Gmail, Outlook and
  iOS Mail; subject-length indicator
- **Audience:** include/exclude lists and segments, live count with an expandable breakdown
  ("12,480 recipients — 312 suppressed, 44 duplicates removed")
- **Content:** drag-and-drop block editor, merge tags with default-value syntax
  (`{{first_name | "there"}}`), conditional blocks, global styles, device/dark-mode preview,
  automatic plain-text generation, link tracking and UTM builder
- **The content block** pulls live entries from the CMS into the email. The spec identifies this as
  *"the feature that justifies having the CMS and the newsletter tool in one product."*
- **Schedule:** send now, at a datetime, at each recipient's local time, or send-time optimised

### 7.4 Send pipeline · Large · Spec §11.2

```
schedule → preparing → resolve audience, dedupe, remove suppressed
         → INSERT campaign_recipients in batches of 5,000
         → freeze html/text/design snapshot onto the campaign
         → sending → N parallel throttled batch jobs
         → render merge tags, attach unsubscribe headers, tracking pixel, wrapped links
         → send via ESP, record message_id
         → sent
```

**Idempotency:** `UNIQUE (campaign_id, subscriber_id)` plus a per-recipient state machine means a
worker crash and replay can never double-send. Batches claimed with
`SELECT … FOR UPDATE SKIP LOCKED`.

**Controls during send:** pause (stops claiming new batches, in-flight finish), resume, cancel.
Live progress bar with send rate and estimated completion.

**Throughput target:** ≥50,000 emails/hour per workspace (§18.1).

### 7.5 Event ingestion · Medium · Spec §11.2

The webhook receiver exists and records provider events to the outbox. **Nothing consumes them
yet.** Needed: `email_events` (partitioned monthly), subscriber status updates on bounce and
complaint, and automatic suppression-list additions.

### 7.6 Campaign reporting · Medium–Large · Spec §11.3

Header stats (sent, delivered, open rate, click rate, CTOR, bounce, unsubscribe, complaint), a
72-hour timeline chart, link performance with a heat-map overlay, a filterable recipient table,
device and client breakdown, geography, and A/B results with statistical confidence.

Actions: duplicate, **resend to non-openers** (creates a pre-filtered campaign), export CSV/PDF.

### 7.7 Templates and A/B testing · Medium · Spec §11.5, §11.6

Template library with thumbnails, categories, an org-sharing flag, and 8–10 responsive starters.
A/B testing across subject, preheader, sender name, content or send time — 2–4 variants, a test
percentage, a winning metric, and a decision window, with auto-send of the winner.

---

## 8. What remains — Phase 5: Automations & analytics

**Spec estimate:** 3–4 weeks. *"The product is competitive rather than merely functional."*

### 8.1 Automation engine · Large · Spec §11.4

Tables `automations`, `automation_steps`, `automation_runs` — **none created yet**.

**Triggers:** joins a list, confirms opt-in, tag added/removed, attribute changes, form submitted,
date-based (birthday, N days after signup), **content published** (digest when a new post goes
live), API event, campaign opened/clicked, enters a segment.

**Step types:** send email, wait (fixed, until a weekday/hour, or until a condition with timeout),
condition (if/else), split test, add/remove tag, add/remove from list, update attribute, webhook,
goal, end.

**Settings:** re-entry policy, quiet hours (no sends 10pm–8am local), a weekly cap per subscriber
across all automations, and exit conditions.

**Presets to ship:** welcome series, re-engagement, post-purchase, abandoned form, new-content
digest.

### 8.2 Flow builder UI · Large · Spec §17.12

Full-height canvas with pan/zoom, minimap, node palette, per-node live counters ("312 waiting
here"), labelled Yes/No branch edges, a simulation mode that walks a chosen subscriber through,
and pre-activation validation that highlights unreachable nodes, missing templates and infinite
loops.

### 8.3 Analytics rollups · Medium–Large · Spec §13.3

Raw events in partitioned tables; hourly and nightly rollup jobs writing to pre-aggregated tables
keyed by `(workspace_id, date, metric, dimension)`. **Dashboard queries must hit only rollups** so
a workspace with 50M email events still loads in under 200ms. Raw retained 13 months, rollups
indefinitely.

### 8.4 The full dashboard · Medium–Large · Spec §17.3

The current dashboard shows the site's real state and an honest roadmap. The specified version is
substantially richer and needs the data the phases above produce:

- Conditional alert strip (no verified sender, DNS unverified, entries in review >7 days, API
  error rate, quota at 80%)
- Four KPI cards with 30-day sparklines and direction-aware delta chips (a rising bounce rate is
  red)
- Activity chart with tabs and range selector; recent activity feed
- "Needs your attention" task list; your drafts; quick actions; upcoming schedule
- Top content (from Delivery API logs) and email health with threshold indicators
- Cards reorderable and hideable, persisted per user per workspace; 60s auto-refresh

### 8.5 Reports · Medium · Spec §13.2

Content, audience, email and API reports, each with CSV/PDF export and scheduled email digests.

---

## 9. What remains — Phase 6: Documentation & polish

**Spec estimate:** 2–3 weeks, *"but really continuous."*

### 9.1 Integration wiki · Large · Spec §16

A separate Docusaurus/Mintlify site: core concepts, quickstart, authentication guidance (where to
store keys and where never to), fetching content, rendering rich text with reference renderers for
React/Vue/PHP, and framework guides.

**Sequencing note from §19:** write the framework guides *while* building Phase 2, not afterwards.
*"Writing the Next.js guide will expose at least three API design flaws while they are still cheap
to fix."*

### 9.2 Accessibility audit · Medium · Spec §18.5

Focus management, keyboard navigation throughout, ARIA labelling, colour contrast. The primitives
already keep focus rings and hide role-inaccessible nav items rather than disabling them, but no
audit has been done.

### 9.3 Internationalisation of the admin UI · Medium · Spec §18.5

Strings are currently inline. The spec asks for them externalised **from day one** so this is not a
retrofit — this is already technical debt. Also needed: RTL layout support, per-user timezone and
date-format preferences, locale-aware number and date formatting.

### 9.4 Responsive polish · Medium · Spec §17.18

Five screens must be genuinely usable on a phone: dashboard, content list, entry editor,
subscriber list, campaign report. The schema builder and flow builder are explicitly desktop-only
with a friendly small-screen message.

### 9.5 Notifications · Medium · Spec §17.2

The bell menu is not built. Needed: review requests assigned to you, comment mentions, campaign
completed, import finished, key expiring, quota at 80%, webhook failing, DNS verified — each
clickable, markable read, with a notification-settings page.

---

## 10. What remains — Phase 7: Scale & enterprise

Ongoing, and not required for a viable product.

| Item | Spec | Notes |
|---|---|---|
| SSO / SAML | §6.1 | Enterprise plan |
| MFA (TOTP) | §6.1 | Schema and the login challenge exist; enrolment and verification do not |
| Custom permission sets | §7 roadmap | Beyond the five fixed workspace roles |
| Data residency | §18.4 | Region pinned at workspace creation, immutable thereafter |
| Audit-log export | §18.2 | 12-month retention today, 7 years on enterprise |
| SOC 2 groundwork | §18.4 | Year-two goal |
| GraphQL endpoint | Open Decision #9 | **Deferred** — REST with field selection covers most needs; add when a customer asks twice |
| Content-as-code CLI | §12.6 | `content pull/push`, `migrate` |
| Multi-region read replicas | §7 roadmap | |
| Billing integration | §5.1 | `plan`, `billing_customer_ref` and `usage_counters` columns exist; nothing reads or enforces them |

---

## 11. Cross-cutting infrastructure debt

These are not features, and every one of them blocks or degrades work above.

### 11.1 Job queue · Built on Postgres; most processors still to write · Spec §4.6

Jobs live in the `jobs` table. A worker polls for due rows and claims them with
`SELECT ... FOR UPDATE SKIP LOCKED`, so any number of API instances can share the queue and no job
is handed to two of them. Retries use exponential backoff; a recurring job is a row whose `run_at`
is pushed forward one interval after each run, so there is no cron parser. A claim left behind by a
dead process is released after `JOB_CLAIM_TIMEOUT_MS`.

**Why not a broker.** Postgres is the only datastore this platform requires. A second one has to be
deployed, secured, monitored, backed up and restored, and that cost is real every day, whereas the
throughput a dedicated queue would add is not needed at this size. What is given up: latency is
bounded below by the poll interval (5s by default), and the queue will not carry a high-rate fan-out.
Neither matters for publishing content or delivering webhooks.

Twelve job names are declared in `jobs/job-names.ts`. Three have processors:
`publish-scheduled-content`, `webhook-deliver` and `key-usage-flush` (which sweeps expired
rate-limit counters).

**Still needed:** processors for `media-transform`, `subscriber-import`, `subscriber-export`,
`analytics-rollup`, `purge-soft-deleted`, `campaign-prepare`, `campaign-send-batch`,
`automation-tick` and `ingest-esp-events`. Also worth adding before the queue carries real volume:
an admin view of dead-lettered jobs, and retention for completed rows.

### 11.2 Admin rate limiting and session revocation are in-process · Medium

Auth rate limiting (`auth/rate-limiter.ts`) and the session-revocation cache
(`TokenService.isSessionRevoked`) are in-process. On one instance both are correct. Across N
instances, auth limits are roughly N times looser, and a revoked session can survive on another
instance for exactly one request — the database is still the authority and is consulted on every
cache miss.

The fix no longer needs new infrastructure: `rate_limit_counters` already provides a shared
fixed-window counter in Postgres, and both call sites sit behind narrow interfaces designed to be
swapped without touching callers. Delivery API key rate limiting already uses it.

### 11.3 Outbox dispatcher · Medium · Spec §4.7

`domain_events` now has one consumer: the webhook dispatcher turns workspace-owned events into
outbound webhook deliveries. Still needed: analytics rollup, automation trigger matcher and cache
invalidator consumers.

### 11.4 Search · Built on Postgres FTS · Open Decision #4

Content search is Postgres full-text search. `content_entries.search_vector` is a **stored
generated column** — `to_tsvector(slug) || jsonb_to_tsvector(data, '["string"]')` — with a GIN
index on it. The `"string"` filter matters: indexing `data::text` would also index field api_ids
and JSON punctuation, so searching "title" would have matched every entry ever written.

Both the Delivery `/v1/search` endpoint and the admin entry list share one definition
(`content/search-query.ts`). Queries are ANDed with a `:*` prefix on the final word, so
search-as-you-type works before a word is finished, and stemming covers the other direction.
Input is reduced to letters and digits before reaching `to_tsquery`, which has a real grammar and
raises a syntax error on the apostrophes and hyphens people type constantly. Delivery results are
ordered by `ts_rank` first — a title match beats a passing mention — with recency only breaking
ties. The previous substring implementation ordered purely by date.

**The GIN index is not currently used at runtime, and this is worth understanding before
optimising anything else.** `ts_match_vq`, the function behind `@@`, is not marked `LEAKPROOF`,
and Postgres will not evaluate a non-leakproof qual below a row-level-security barrier. The
application connects as `cms_app`, for which every row of this table sits behind such a barrier,
so the planner applies the match as a filter and the index goes unused. Verified with `EXPLAIN`
against both roles.

The stored column is what keeps that acceptable: the fallback reads a materialised `tsvector`
per row instead of recomputing `to_tsvector` over the jsonb for every candidate, and the
workspace-scoped index narrows the candidates first. It is a filter over one workspace's rows, not
a scan of the table.

Two ways to get the index working, when a workspace is large enough to need it:

| Option | Cost |
|---|---|
| `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF` | Requires superuser, which managed Postgres (RDS, Cloud SQL) often does not grant. Asserts the operator cannot leak its arguments, which weakens the RLS barrier this platform treats as load-bearing. Verified to work — the plan switches to a Bitmap Index Scan on `content_entries_search_idx`. **Not applied: it is a security trade, and that is the owner's call, not a default.** |
| Move search to a separate index/service (Meilisearch, per Open Decision #4) | No RLS interaction, at the cost of a second datastore to run and keep in sync — which is exactly what removing Redis was meant to avoid. |

**Still open:** media search is still `ILIKE` over filename, alt text and caption. That table is
small and the columns are short, so it has not been worth the same treatment.

### 11.5 Pagination · Small

Audit logs and member lists are capped at 50 rows with no pagination. Entries already use cursor
pagination per §14.1; the rest should follow.

### 11.6 Purge jobs · Small–Medium

Soft deletes accumulate with nothing removing them: workspaces past their 30-day window (including
object storage), media assets, entries, and abandoned uploads (asset rows with `uploaded_at` null).

### 11.7 Observability · Medium · Spec §4.3, §18.3

Not started. Needed: OpenTelemetry traces, structured JSON logs, Sentry, Prometheus + Grafana,
per-workspace metrics (a support requirement), SLOs with error budgets, and paging alerts on error
rate, latency, queue depth and send-failure rate.

### 11.8 Operational readiness · Medium · Spec §18.3

Needed: streaming replication, PITR, automated backups (daily/30 days, monthly/12 months) with
**quarterly restore tests** — the spec notes an untested backup is not a backup. Also: feature
flags with per-workspace targeting, and runbooks for ESP outage, queue backlog, tenant data-leak
suspicion, key compromise, mass unsubscribe, and database failover.

### 11.9 Browser test coverage · Medium

The portal has none. It is verified by typecheck and production build only; the API is verified
end to end against a real database. Playwright covering the five critical screens would close this.

---

## 12. Known limitations in what is built

Honest list of things that work but have caveats.

| Limitation | Impact | Fix |
|---|---|---|
| Most job processors are unwritten | Scheduled content, outbound webhooks and rate-limit-counter cleanup run; media transforms, imports, campaign sending, rollups and purge work still do nothing | §11.1 |
| API key plan ceilings are not enforced | Per-key limits, overrides, burst windows and subscriber-write/form-submit per-IP overlays work; billing/plan ceilings do not | §5.4 |
| Phase 2 product polish remains | Backend endpoints exist, but SDK/embed/CLI, hosted docs/playground, dynamic per-workspace OpenAPI, secret scanning and unused-key reminders are still missing | §5 |
| Admin/auth rate limiting is in-process | Limits are N× looser across N instances | §11.2 |
| Session revocation cache is in-process | A revoked session may survive on another instance until token expiry (DB is still the authority, so the window is one request) | §11.2 |
| Audit log and member lists unpaginated | Only the 50 most recent rows are visible | §11.5 |
| No image variants | Full-size originals served to all viewports | §4.3 |
| Rich text edits raw JSON | Usable but unpleasant for non-technical authors | §4.1 |
| No autosave in the editor | Work is lost if the tab closes with unsaved changes; a dirty-state bar and unsaved guard mitigate it | §4.4 |
| Admin UI strings are inline | Localisation becomes a retrofit, which §18.5 explicitly warned against | §9.3 |
| No billing enforcement | Plan limits and quotas are stored but never checked | §10 |

---

## 13. Open decisions still outstanding

From spec §20. Decisions already made are recorded in `docs/architecture.md`.

| # | Decision | Status |
|---|---|---|
| 1 | Backend framework | **Decided** — NestJS |
| 2 | ESP | **Decided** — Resend, per organisation (a deviation from the spec's platform-level model) |
| 3 | Rich text storage | **Decided** — structured JSON |
| 4 | Search | **Decided** — Postgres FTS over a stored generated `tsvector` column. Meilisearch stays the escape hatch above ~50k entries, or if the RLS/leakproof interaction in §11.4 becomes the bottleneck |
| 5 | Segment evaluation | **Open** — spec recommends at send time with a cached count |
| 6 | Preview mechanism | **Decided** — short-lived per-entry tokens |
| 7 | Media transformation | **Open** — spec recommends both pre-generated and signed on-the-fly |
| 8 | Billing model | **Open** — needs a pricing exercise, not an engineering one |
| 9 | GraphQL | **Decided** — defer |
| 10 | Admin API public? | **Decided** — published, versioned separately, documented as lower-stability |
| 11 | Content-type scope | **Decided** — per workspace; "copy schema from another site" is the pragmatic middle ground and is not yet built |
| 12 | Standalone or part of an existing platform? | **Still needs your answer.** It affects auth (shared identity provider?), deployment, and whether the org model already exists elsewhere |

---

## Recommended next steps

In order, with reasoning:

1. **Build Phase 2 product polish** — SDK/embed/CLI packages, hosted docs/playground, dynamic
   per-workspace OpenAPI, secret scanning, unused-key reminders and plan ceilings.
2. **Turn request-log summaries into reporting UI** — §5.6. Add retention automation, persisted
   rollups and charts now that raw rows and aggregate summaries exist.
3. **Build the remaining job processors** — §11.1. The queue is in place; next are
   `media-transform`, `purge-soft-deleted`, `subscriber-import/export`, `analytics-rollup` and
   `key-usage-flush`, because later product features depend on them.
4. **Write the framework guides and JS SDK together**, not after (§19 sequencing note).
5. **Move session revocation and admin rate limiting onto the shared Postgres counter** — §11.2.
   This removes the remaining multi-instance auth blocker.
6. **Phase 3 — Audience**, then **Phase 4 — Email sending**. Note §19's warning: do not build the
   email editor before the send pipeline. *"A beautiful editor that can't reliably deliver is worth
   nothing; a plain editor on a solid pipeline is a product."*
