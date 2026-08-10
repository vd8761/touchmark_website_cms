# Architecture notes

Companion to `CMS_Platform_Design_Spec.md`. This records what was built, and — more usefully —
where the implementation departs from the spec and why. Deviations are the parts most likely to
surprise someone reading the spec and then the code.

---

## 1. Deviations from the specification

### 1.1 Access tokens do not carry roles or permissions

**Spec §6.1** describes the access token as containing
`{ sub, org_id, workspace_id, role, permissions[], jti }`.

**Implemented:** `{ sub, sid, jti }`.

**Why.** §6.4 requires that "a user removed mid-session has their sessions revoked within 60
seconds". A 15-minute token carrying a baked-in role cannot satisfy that: for up to 15 minutes
after a demotion, the old role remains cryptographically asserted and the server has no reason to
question it. The two requirements are in direct conflict, and the 60-second guarantee is the one
with security consequences.

Roles are therefore resolved per request from the database (`RequestContextGuard`), and session
revocation is checked per request. A demotion or removal takes effect on the next request.

**Cost.** One extra query per authenticated request. It is a primary-key lookup joined to two
membership tables and is the obvious first thing to cache (the spec already budgets for
this in §4.5). The interface for that cache is already the guard's single `resolveContext` call.

### 1.2 Public ids are encoded, not stored

**Spec §5** specifies UUID v7 primary keys. **Appendix B** specifies resource ids as prefixed
base62, e.g. `ce_01J8XQ2M4K7N`. Taken literally these need two columns kept in sync.

**Implemented:** one column. The public id is a reversible base62 rendering of the same UUID with
a type prefix (`packages/shared/src/ids.ts`). `decodePublicId('content_entry', id)` returns the
stored UUID; a prefix mismatch throws rather than silently decoding, so passing a subscriber id
where an entry id is expected is an error and not a lookup against the wrong table.

### 1.3 Archived workspaces lose write permissions at context construction

**Spec §6.3** says an archived site "becomes read-only". The obvious implementation is a status
check in each write handler, which is the kind of thing that is correct for a year and then is not.

**Implemented:** `RequestContextGuard` filters write permissions out of the context when the
workspace is archived, using `readOnlyPermissions()` from the shared package. Denials report
`workspace_archived` with the real reason rather than blaming the caller's role — a Site Admin who
is told to "ask a Site Admin for a better role" has been given a false explanation for something
they cannot act on.

`POST /restore` therefore requires an *organisation*-level permission: an archived site grants no
write permissions, so a Site Admin cannot un-archive their own site.

### 1.4 Cross-tenant reads return 404, not 403

Not stated either way in the spec's error table (§14.3), which lists both codes.

A 403 on a workspace id confirms that workspace exists. That is a cross-tenant disclosure — it
turns id enumeration into a tenant directory. Every resource the caller may not see reports
`resource_not_found`, and the isolation suite asserts the status code is 404 specifically.

### 1.5 Email provider configuration is organisation-owned

**Spec §5.5** puts `sender_identities` at the workspace level and ESP credentials at the platform
level; §4.3 assumes one platform ESP account, and per-workspace credentials appear only as a
Phase 7 enterprise item.

**Implemented:** an `email_configurations` table owned by the **organisation**, holding a Resend
API key, its own webhook signing secret, and cached verified domains. An organisation may hold
several — one per brand, region, or environment. Each workspace selects one and sets a preferred
from-address; `sender_identities` stay workspace-scoped but reference the configuration that will
actually send them.

**Why.** Billing and sending reputation follow the organisation's own provider account rather than
a shared platform account, which is what makes multi-brand and agency use workable. It also means
a compromised or revoked key is contained to one organisation.

**Consequences that fall out of this, and are enforced:**

* The key is encrypted at rest (AES-256-GCM under a rotatable key id) and is never returned by any
  endpoint — only its last four characters.
* Each configuration gets its own inbound webhook at `/webhooks/email/:configId` with its own
  signing secret, so rotating or leaking one cannot be used to forge events for another.
* A workspace may only send from a domain **Resend reports as verified** for that configuration.
  This is checked against the provider rather than trusted, because sending from an unverified
  domain fails silently at the receiving end — far harder to diagnose later than a rejection now.
* Switching a workspace to a different configuration deletes its sender identities: they belong to
  the previous provider account and would not send.
* Deleting a configuration is refused while any site still uses it, so losing the ability to send
  is a decision rather than a surprise.

One provider-specific finding worth recording: **Resend answers an invalid API key with HTTP 400
`validation_error`, not 401.** Classifying on status alone gives the user a vague "could not
verify" instead of "check your key", so `ResendApiError.isCredentialError` checks the message too.
Verified against the live API; there is a regression test for it.

### 1.6 Media uploads are verified after the fact, not trusted

Uploads go **direct to storage** (§4.2), which means the client writes bytes the API never sees.
Everything it then claims about that upload is therefore exactly what must not be believed.

`POST /media/{id}/complete` re-derives the truth from the stored object: its real size (a client
can under-report to obtain a URL, then upload more), its type from magic bytes, and its
dimensions. A file whose contents disagree with its declared type is deleted rather than stored —
§18.2 requires MIME sniffing precisely because a browser renders a file by its bytes, not its
label, so an `image/png` containing HTML is stored XSS.

Assets stay invisible in the library until completion, so an abandoned upload never appears as a
broken thumbnail.

The local storage driver exists so development needs no cloud account. It presigns an HMAC-signed
URL **on this API** rather than inventing a different flow: the signature covers the key, content
type and expiry, and the endpoint is unauthenticated exactly as a presigned S3 URL is. It answers
`PUT`, because S3 presigns a `PUT` — a different verb would mean client code that works locally
fails against S3, which would defeat the point of having the driver.

### 1.7 Slug re-derivation is confined to unpublished entries

The "New entry" button creates an empty draft, which has no title to derive a slug from — so it
gets the placeholder `untitled`. Without intervention every entry created that way would become
`untitled`, `untitled-1`, `untitled-2`.

On update, a slug is re-derived from the title **only** when the entry has never been published
and its slug is still the placeholder. A live URL is never silently changed underneath the site
serving it; §17.5 treats changing a published slug as a deliberate act that needs a redirect
record. An explicitly supplied slug always wins.

---

## 2. Things the spec asks for that are stubbed

Each is marked in code at the point where the stub is.

| Item | State | Blocked on |
|---|---|---|
| Starter content models (§6.2) | The chosen model is validated and recorded on the `workspace.created` event; no types are provisioned | Nothing any more — content types now exist, so this is a small piece of work |
| MFA (§6.1) | Schema, and the login challenge returning `401 mfa_required`; enrolment and TOTP verification are not implemented | Deliberate — half-built MFA is worse than none |
| Rich-text block editor (§17.5) | The field stores and validates a structured document (Open Decision #3); the editor writes JSON directly | A block editor is a substantial piece of UI in its own right; the stored shape will not change when it arrives |
| Relation picker | Relation fields accept entry ids directly; media fields have a real picker | The Delivery search endpoint exists; the admin picker UI still needs to consume it |
| Image variants and blurhash (§4.6) | Dimensions are extracted on upload; variants are not generated | The job queue exists; the `media-transform` processor and sharp pipeline are still needed |

---

## 3. Layers, and what each one catches

Isolation is enforced four times. The redundancy is the point: each layer catches a different
class of mistake.

| Layer | Catches | Where |
|---|---|---|
| Request context | A caller trying to specify their own scope via the request body | `auth/request-context.guard.ts` |
| `authorize()` | A handler reachable by the wrong role | `auth/authorize.ts` |
| `TenantRepository` | A repository method written without a workspace filter | `common/tenant-repository.ts` |
| Row-level security | A raw query, a Prisma escape hatch, or a future developer bypassing the repository | `prisma/rls.sql` |

RLS only works because the application connects as `cms_app`, which is neither the table owner nor
`BYPASSRLS`. If `DATABASE_URL` is ever pointed at the owner role, **every policy silently stops
applying and all four layers collapse to three**. The isolation suite's cross-tenant write test is
what detects this: it can only fail-to-fail if RLS is live.

### System context

`PrismaService.asSystem()` sets `app.bypass_rls` and is the deliberate escape hatch for work that
is legitimately cross-tenant: login (which resolves a user before any workspace exists), the
scheduler, the outbox dispatcher, and seeding. It is a session *setting* rather than a role
privilege specifically so that it is visible in code review and greppable.

---

## 4. Cross-cutting mechanisms

**Audit log.** Append-only enforced by the database, not by convention: the RLS grants give
`cms_app` `SELECT` and `INSERT` on `audit_logs` and revoke `UPDATE` and `DELETE`. Before/after
snapshots are built from entity rows, which contain hashes and secrets, so `AuditService` redacts a
denylist of sensitive keys before writing (§18.2 requires this of "all log pipelines"; the audit
log is one).

A failed audit write is logged at error level but does not roll back the action it describes —
making the audit log an availability dependency of every mutation would be a worse trade. Where a
caller already has a transaction, `recordIn(tx, …)` commits the audit row with the change.

**Domain events.** A transactional outbox (`domain_events`), written in the same transaction as
the state change. Per §4.7, this is what makes an event survive the process dying between the
commit and the publish. The webhook module now drains workspace-owned events into
`webhook_deliveries` through the `webhook-deliver` job. Other consumers — analytics rollups,
automation triggers and cache invalidators — still need their own processors.

**API keys.** The Phase 2 key infrastructure is live: keys are workspace-owned, RLS-protected, stored
only as SHA-256 hashes, and shown in plaintext exactly once. Delivery key auth is deliberately
separate from the session guard: delivery routes are marked public for session auth, then guarded
by `ApiKeyGuard`. Auth contexts are resolved from the database on every request with no cache in
front, which is what makes revocation take effect on the very next request rather than at the end
of a TTL; every accepted delivery request then consumes a Postgres fixed-window per-key rate
counter before reaching the handler. Admins can update non-secret key settings,
configure per-key rate-limit overrides, rotate keys with immediate/1h/24h/7d grace windows, and
read recent per-key Delivery request logs. Subscriber-write and form-submit routes also consume a
per-IP overlay and a short-window burst counter. Revocation emails are sent to Site Admins plus
organisation Owners/Admins.

**Delivery API.** The public surface now covers content type schemas, published entries by
list/slug/id, related entries via shared taxonomy terms, search across published entries and
completed media, taxonomy terms, resolved menus, completed media assets, subscriber upserts,
subscriber lookup/update/unsubscribe, list reads, public form schemas/submissions and single-entry
preview tokens. These routes are scoped entirely by the authenticated API key's workspace except
preview-token reads, serve only published/non-expired content or completed media, and emit
`Cache-Control` plus weak `ETag` headers where the response is cacheable. Delivery responses
deliberately omit editor-only state such as locks and unpublished-change flags.

**Webhooks.** Outbound webhook endpoints store their signing secrets encrypted at rest and return
the plaintext secret only once on creation. Deliveries are at-least-once with HMAC signatures over
`timestamp.body`, a 10-second timeout, retry delays at 1m/5m/15m/1h/6h/12h/24h, dead-lettering
after eight attempts and auto-disable after 15 consecutive failures. Admins can send a test event,
inspect recent deliveries and replay a delivery.

**OpenAPI.** The generator now emits both `openapi-admin.json` and `openapi-delivery.json`. The
delivery document is filtered to `/v1/*` routes and uses a delivery API-key security scheme, so
the public developer contract is separated from admin/session APIs.

**Errors.** One filter produces the §14.2 envelope for everything thrown, so clients parse exactly
one shape. `AppError` carries a §14.3 error code rather than a bare HTTP status, which is what lets
the filter emit `type`, `code`, `docs_url` and `request_id` without guessing. Unrecognised
exceptions return `internal_error` and a request id — the detail goes to the logs, never the client.

---

## 5. Known limitations

Honest list; none of these are on the Phase 0 exit criteria, and each has a clear upgrade path.

- **Admin/auth rate limiting and session-revocation caching are in-process.** Correct on one
  instance, wrong on several. Both are behind narrow interfaces (`RateLimiter`,
  `TokenService.isSessionRevoked`) and can move onto the shared `rate_limit_counters` table with no
  call-site changes. Delivery API key rate limiting already uses it.
- **The job queue has three real processors so far.** `publish-scheduled-content`,
  `webhook-deliver` and `key-usage-flush` are registered; media transforms, imports/exports,
  campaign sending, rollups and purge work still need processors.
- **API key plan ceilings are not enforced.** Per-key limits, per-key overrides, burst
  windows and subscriber-write/form-submit per-IP overlays work; billing/plan ceilings do not.
- **Phase 2 has backend coverage, not product polish.** SDK/embed/CLI packages, dynamic
  per-workspace docs, a playground UI, secret-scanning integration and unused-key reminders still
  need to land.
- **Audit log and member lists are unpaginated**, capped at 50 rows. Cursor pagination per §14.1
  arrives with the first list endpoint that genuinely needs it.
- **The portal covers Phase 0 screens only.** Routes for later phases render an honest
  "not built yet" rather than an empty shell.
- **No browser-level test coverage** of the portal. It is verified by typecheck and production
  build; the API is verified end to end against a real Postgres.
- **Search is Postgres FTS, but the GIN index is not reachable at runtime.** `search_vector` is a
  stored generated column with a GIN index; `ts_match_vq` is not leakproof, so under RLS the
  planner applies it as a filter rather than an index condition. The stored column keeps that
  cheap. See §11.4 of PROJECT_STATUS.md for the two ways out and why neither is a default.
