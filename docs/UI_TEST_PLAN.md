# UI test plan — manual verification

**Purpose.** Everything built in this session is verified at the API and unit level and **none of it
at the UI level** (the browser extension was unavailable). This file is the checklist to walk
through once a browser is available, and the source material for the Playwright suite that should
eventually replace it.

**Status key:** ⬜ not yet checked · ✅ verified · ❌ failed · ⚠️ works with caveats

**Last updated:** after the first browser pass. Kept current as work continues.

## Results of the first browser pass

Verified in Chrome against the built portal. **Three bugs found, all fixed** — two of them serious
and neither reachable by any test that does not drive a real browser.

| Verified | |
|---|---|
| ✅ 2.1–2.4 | Sidebar highlighting — the reported bug is gone, including the three-row case |
| ✅ 3.1–3.4 | Developer guide renders with real `blog` api_id, real field names, real base URL |
| ✅ 4.1–4.2 | API ID derives live to `data.featured_image_url` — identical to the server's rule |
| ✅ 4.9–4.12 | Options editor appears for enum; length rules disappear; **Add field correctly disabled** with no options |
| ✅ preview | Preview pane renders a real `<select>` with 2 options as they are typed |
| ✅ 5.1, 5.3 | Block editor mounts; slash menu opens and filters |
| ✅ 6.10 | `beforeunload` guard — it blocked my own automated navigation |
| ✅ 8.4 | No horizontal overflow (`scrollWidth === clientWidth`) |

### Bugs found and fixed

1. **Access tokens were never refreshed for anything but the session query.** `withRefresh` was
   wired into exactly one call site. Every save, publish, upload and autosave failed outright once
   the 15-minute token expired, showing "You are not signed in" to someone who was. With autosave
   this is worse than an inconvenience — work silently stops being saved while the editor still
   looks healthy. Refresh now happens inside the API client, for every request.
2. **Two open tabs signed the user out.** Refresh tokens rotate, so two tabs expiring together post
   the same token; the first rotates it and the second is treated as a replayed stolen token, which
   revokes the whole session family (§6.1). Now serialised with a Web Lock across tabs, so the
   second tab refreshes with the token the first produced. *This is what the `session_expired`
   during testing actually was.*
3. **Developer guide printed a literal `{BASE}`** in the `/v1/me` sample instead of the URL.

### Second pass — the block editor

| | |
|---|---|
| ✅ 5.1 | Editor mounts, toolbar and outline rail render, placeholder shows |
| ✅ 5.3–5.4 | Slash menu opens at a word boundary and filters (`/head` → the three headings) |
| ✅ 5.5 | Enter inserts the block — H2 applied, styled larger |
| ✅ 5.9 | Outline populates from headings |
| ❌→fixed | **The slash query was not fully removed.** `/head` + Enter produced a heading reading `/hWhy foxes matter`. The deletion range was computed from `slashQuery.length` — React state that lags behind fast typing, since each keystroke's handler closes over its own render's value. It now searches the *document* backwards for the `/`, which cannot be stale because it inspects the text on screen. |

**Fix status: unverified end to end.** It typechecks and builds, and the reasoning is sound, but I
could not re-drive the editor to confirm it. The automation harness delivers keystrokes to
ProseMirror only intermittently — the element reports focused and `contenteditable=true`, the
session is valid, and typed characters still do not always arrive. That makes further results
untrustworthy rather than informative, so the remaining editor rows (5.6–5.8, 5.10–5.22), autosave
(§6) and version comparison (§7) stay unchecked.

**This is the case for Playwright**, which drives ProseMirror with real user-event semantics
instead of synthesised key events. Every row below marked ⬜ is a coin flip until then, and the one
bug this pass did find was invisible to 322 passing tests.

### Not a bug, but worth recording

Querying `content_types` with a plain Prisma client returns **zero rows** — RLS is doing its job,
since no `app.workspace_id` is set. Diagnostic scripts must use `withWorkspaceScope` or they will
report an empty database. This briefly looked like data loss during testing.

---

## 0. Setup

```bash
npm run db:up
```

```bash
npm run build --workspace @cms/admin && npm run start:prod --workspace @cms/api
```

Portal and API are then both on **http://localhost:4000** (one origin — session cookies are
`SameSite=Lax` and will not survive a split origin).

Sign in as `sriharan2544@gmail.com`. The account is an org **Owner** of "Sriharan", so it inherits
Site Admin on every site and every screen below is reachable.

> The org has **0 sites** on a fresh check — §1 creates one, and later sections depend on it.

---

## 1. Onboarding and site creation

| # | Step | Expected |
|---|---|---|
| 1.1 | ⬜ Sign in | Lands on the site list or onboarding, not a 404 |
| 1.2 | ⬜ Create a site called `Blog` | Redirects into the new site's dashboard |
| 1.3 | ⬜ Check the URL shape | `/o/<org-slug>/s/<site-slug>/…` |

---

## 2. Sidebar navigation — regression from a reported bug

The original report: on **Content model**, "Site settings" also highlighted. Root cause was
prefix-matching; on `settings/org/email` **three** rows lit at once.

| # | Step | Expected |
|---|---|---|
| 2.1 | ⬜ Open **Content model** | **Only** Content model is highlighted — Site settings is *not* |
| 2.2 | ⬜ Open **Site settings** | Only Site settings highlighted |
| 2.3 | ⬜ Open **Site members** | Only Site members — not Site settings |
| 2.4 | ⬜ Open **Email configurations** (Organisation) | Only that row — not Organisation settings, not Site settings |
| 2.5 | ⬜ Open **Dashboard** | Only Dashboard |
| 2.6 | ⬜ Open an entry inside a content type | The content type stays highlighted while in the editor (prefix matching is *wanted* here) |
| 2.7 | ⬜ Collapse the sidebar | Icons only; group hairlines replace headings |
| 2.8 | ⬜ Confirm "Soon" badges | Subscribers, Lists & segments, Forms, Campaigns, Automations — these are genuinely unbuilt |

---

## 3. Developer guide (new)

Reached via **Developers → Developer guide**.

| # | Step | Expected |
|---|---|---|
| 3.1 | ⬜ Open the page | Renders; left rail lists 11 topics |
| 3.2 | ⬜ Check the base URL in samples | Shows `http://localhost:4000`, not a placeholder |
| 3.3 | ⬜ Check "Your first request" | Uses **your real** content-type api_id (e.g. `article`), not `your-type` |
| 3.4 | ⬜ Expand a type under "Your content model" | Lists real fields, their api_ids, types, and required/translatable flags |
| 3.5 | ⬜ Click a topic in the left rail | Jumps to the section, heading not hidden under the header |
| 3.6 | ⬜ Click **Copy** on a code block | Label flips to "Copied" for ~1.6s; clipboard holds the sample |
| 3.7 | ⬜ Switch framework tabs | Next.js / Astro / Plain fetch swap the sample |
| 3.8 | ⬜ Wide code samples | Scroll **inside** the block; the page itself never scrolls sideways |
| 3.9 | ⬜ With no content types | Shows an empty state, not a broken sample |
| 3.10 | ⬜ Visible to a non-admin role | Page is ungated by permission |

---

## 4. Field configuration (rebuilt)

**Content model → select a type → Fields.**

| # | Step | Expected |
|---|---|---|
| 4.1 | ⬜ Click **Add field**, type name `Meta Title` | `data.meta_title` appears live, marked "permanent once saved" |
| 4.2 | ⬜ Watch the **Preview** pane | Renders the actual control, updating as you change type |
| 4.3 | ⬜ Tick **Required** | Preview label gains `*` |
| 4.4 | ⬜ Enter help text | Appears under the preview input |
| 4.5 | ⬜ Pick type **Text** | Min/max length, pattern shown |
| 4.6 | ⬜ Enter a pattern | A "message when the pattern fails" field appears |
| 4.7 | ⬜ Pick **Number** | Min/max shown; length/pattern **gone** |
| 4.8 | ⬜ Pick **Date** | *No* validation section (server enforces none) |
| 4.9 | ⬜ Pick **Select** | Options editor with value + label rows |
| 4.10 | ⬜ Add/remove option rows | Last row cannot be removed; Add appends |
| 4.11 | ⬜ Try saving an enum with no options | **Add field** disabled |
| 4.12 | ⬜ Pick **Reference** with no target | **Add field** disabled |
| 4.13 | ⬜ Save the field | Appears in the list with its rules summarised (`5–60 chars · pattern`) |
| 4.14 | ⬜ Click **Edit** on it | Form reopens populated — *this did not exist before* |
| 4.15 | ⬜ Rename it and save | Name changes, **api_id does not** |
| 4.16 | ⬜ Clear help text and group, save | Both actually clear (they previously could not) |
| 4.17 | ⬜ Try changing Text → Number | Refused: "From text you can safely widen to: long_text, markdown" |
| 4.18 | ⬜ Change Text → Long text | Accepted |
| 4.19 | ⬜ Set a group, e.g. `SEO` | Shown as a pill in the field list |

---

## 5. Rich-text block editor (new)

Add a **Rich text** field to a type, then open an entry.

| # | Step | Expected |
|---|---|---|
| 5.1 | ⬜ Open an entry with a rich-text field | Block editor, **not** a JSON textarea. Brief skeleton while the chunk loads |
| 5.2 | ⬜ Type a paragraph | Placeholder disappears; text renders at normal size |
| 5.3 | ⬜ Press `/` at the start of a line | Slash menu opens |
| 5.4 | ⬜ Type `head` in the menu | Filters to the heading commands |
| 5.5 | ⬜ Arrow down / Enter | Highlight moves; Enter inserts; the typed `/head` is removed |
| 5.6 | ⬜ Type `and/or` mid-sentence | Menu does **not** open (only fires at a word boundary) |
| 5.7 | ⬜ Press Escape with the menu open | Closes, leaves text alone |
| 5.8 | ⬜ Insert H2 / H3 / H4 | Visibly different sizes |
| 5.9 | ⬜ Check the **Outline** rail | Lists headings; clicking one jumps to it |
| 5.10 | ⬜ Select text | Bubble toolbar appears (B / I / S / code / link) |
| 5.11 | ⬜ Click **B** with text selected | Bolds — selection is **not** lost |
| 5.12 | ⬜ Click **Link**, enter a URL | Applies; renders underlined in accent |
| 5.13 | ⬜ Click Link again, clear the field | Removes the link |
| 5.14 | ⬜ Insert bullet + numbered list | Correct markers and indentation |
| 5.15 | ⬜ Insert quote / code block / divider | All visually distinct |
| 5.16 | ⬜ Insert **Table** | 3×3 with a bordered header row |
| 5.17 | ⬜ Insert **Image** | Media picker opens; chosen image renders inline |
| 5.18 | ⬜ Insert **Callout** | Bordered aside, editable inside |
| 5.19 | ⬜ Insert **Button**, give href + label | Renders as an accent button |
| 5.20 | ⬜ Insert **Embed** with a YouTube URL | Dashed placeholder reading `Embed — <url>` |
| 5.21 | ⬜ Save, reload the page | Every block returns exactly as left |
| 5.22 | ⬜ Confirm no H1 offered | Deliberate — the title field is the page's H1 |

---

## 6. Autosave (new)

Use a **draft** entry (autosave is deliberately off for published ones).

| # | Step | Expected |
|---|---|---|
| 6.1 | ⬜ Type, then stop | After ~3s: "Saving…" then "Saved at HH:MM" |
| 6.2 | ⬜ Type continuously for 10s | Does **not** save mid-flow; saves ~3s after you stop |
| 6.3 | ⬜ Reload without pressing Save | Text is there |
| 6.4 | ⬜ Keep typing *during* a save | Bar returns to "Unsaved changes" — the new keystrokes are not lost or falsely reported saved |
| 6.5 | ⬜ Watch the version number in the header | Increments per autosave |
| 6.6 | ⬜ Open **History** after several autosaves | **One** new version, not one per save |
| 6.7 | ⬜ Press ⌘S / Ctrl+S | Saves immediately; adds its own version |
| 6.8 | ⬜ Click **Discard** while dirty | Reverts to last saved; no autosave fires after |
| 6.9 | ⬜ **Publish** the entry, then edit | Bar reads "…published entries do not autosave"; nothing saves until ⌘S |
| 6.10 | ⬜ Close the tab while dirty | Browser warns before leaving |
| 6.11 | ⬜ Force an error (open the same entry in two tabs, save in both) | 409 shown; autosave stops rather than retrying per keystroke; Save resumes it |

---

## 7. Version comparison (new)

**History → Compare versions** (needs ≥2 versions).

| # | Step | Expected |
|---|---|---|
| 7.1 | ⬜ Open the compare panel | Defaults to previous → newest |
| 7.2 | ⬜ Change a word, save, compare | Only that word highlighted — red left, green right |
| 7.3 | ⬜ Change two adjacent words | Highlighted as **one** block, not two with a gap |
| 7.4 | ⬜ Check unchanged fields | Hidden; "Show N unchanged" reveals them |
| 7.5 | ⬜ Compare rich-text versions | Shows readable prose, not raw JSON |
| 7.6 | ⬜ Compare versions where rich text did *not* change | Reported unchanged (jsonb key reordering must not read as an edit) |
| 7.7 | ⬜ Clear a field, compare | Marked "cleared"; before pane has text, after says "empty" |
| 7.8 | ⬜ Add a new field's value, compare | Marked "added" |
| 7.9 | ⬜ Delete a field from the type, compare old versions | Value still shown, tagged "no longer in the schema" |
| 7.10 | ⬜ Click **Restore vN** | Restores; history gains a version (append-only, never rewinds) |
| 7.11 | ⬜ Pick two versions far apart | Loads both without stalling |

---

## 8. Cross-cutting

| # | Step | Expected |
|---|---|---|
| 8.1 | ⬜ Audit log with >25 entries | Paginates; no 50-row cliff |
| 8.2 | ⬜ API key request logs | Paginate |
| 8.3 | ⬜ Webhook deliveries | Paginate |
| 8.4 | ⬜ Resize to mobile width | Sidebar collapses to a drawer; no sideways page scroll |
| 8.5 | ⬜ Keyboard-only pass of the editor | Focus ring always visible |
| 8.6 | ⬜ Watch the API console during use | Structured JSON log lines carrying `request_id` and `workspace_id` |
| 8.7 | ⬜ `GET /metrics` with no token | 404 (fails closed) |
| 8.8 | ⬜ `GET /metrics` with `METRICS_TOKEN` set + bearer | Prometheus text |

---

## 9. Pending — sections to add as work lands

- ⬜ **#11** Test-tenant cleanup — verify by row counts, not UI
- ⬜ **#12** Image variants and blurhash — upload, check derivatives and placeholder
- ⬜ **#13** Bulk actions — multi-select, publish/archive/delete, >100 via job
- ⬜ **#14** ⌘K command palette — search across entries, media, settings

---

## Known-unverified risk register

Ranked by what would hurt most if wrong, given none of it has been seen in a browser:

1. **Autosave timing and the dirty-state race** (§6.4) — logic is unit-tested, the *interaction* is not
2. **Slash menu keyboard handling** (§5.3–5.7) — most intricate new interaction
3. **Bubble menu positioning** (§5.10) — depends on Tippy in a scrolling container
4. **Media picker inside the editor** (§5.17) — async URL resolution after selection
5. **Diff rendering with long fields** (§7.11) — degradation path only unit-tested
