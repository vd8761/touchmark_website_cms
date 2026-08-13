import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { ContentTypeDto, FieldDto } from '../lib/content-types';
import { useSession } from '../lib/session';
import { Card, cx, EmptyState, Skeleton } from '../components/primitives';

/**
 * The integration guide, rendered against this site's own content model.
 *
 * A hosted docs site can only ever show `your-type-here`. This one knows the
 * workspace it is being read in, so every example carries the reader's real
 * base URL, their real content-type api_ids and their real field names — which
 * removes the step where a developer has to translate a generic example into
 * their own schema and gets the api_id subtly wrong.
 *
 * It is deliberately one page with anchored sections rather than a set of
 * routes: the questions a developer has on day one ("how do I authenticate,
 * how do I fetch a list, why is this 401") are read in sequence, and Ctrl-F
 * across the whole thing beats navigating a tree.
 */

interface Topic {
  id: string;
  label: string;
}

const TOPICS: Topic[] = [
  { id: 'overview', label: 'How it works' },
  { id: 'keys', label: 'Get an API key' },
  { id: 'first-request', label: 'Your first request' },
  { id: 'model', label: 'Your content model' },
  { id: 'reading', label: 'Reading content' },
  { id: 'queries', label: 'Filtering & pagination' },
  { id: 'frameworks', label: 'Framework recipes' },
  { id: 'audience', label: 'Forms & subscribers' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'preview', label: 'Draft preview' },
  { id: 'errors', label: 'Errors & rate limits' },
];

export function DeveloperGuide() {
  const { orgSlug, siteSlug } = useParams();
  const { currentWorkspace } = useSession();
  const workspaceId = currentWorkspace?.id;
  const base = `/o/${orgSlug}/s/${siteSlug}`;

  const typesQuery = useQuery({
    queryKey: ['content-types', workspaceId],
    queryFn: () => api.list<ContentTypeDto>(`/admin/v1/workspaces/${workspaceId}/content-types`),
    enabled: Boolean(workspaceId),
  });

  const types = typesQuery.data?.items ?? [];
  // The first collection is the one examples are written against — it is nearly
  // always the one a new integration is being built for.
  const sample = types.find((type) => type.kind === 'collection') ?? types[0];

  const origin = typeof window === 'undefined' ? 'https://your-api.example.com' : window.location.origin;

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-8 px-4 py-8">
      <TopicRail base={base} />

      <div className="min-w-0 flex-1 space-y-10">
        <header>
          <h1 className="text-2xl font-semibold text-text">Developer guide</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Everything needed to pull this site’s content into a website or app. Examples below use
            this site’s real content types and this deployment’s address, so they can be copied
            straight into a project.
          </p>
        </header>

        <Overview origin={origin} />
        <Keys base={base} origin={origin} />
        <FirstRequest origin={origin} sample={sample} loading={typesQuery.isLoading} />
        <ContentModel types={types} loading={typesQuery.isLoading} base={base} />
        <Reading origin={origin} sample={sample} />
        <Queries origin={origin} sample={sample} />
        <Frameworks origin={origin} sample={sample} />
        <Audience origin={origin} />
        <Webhooks base={base} />
        <Preview origin={origin} />
        <Errors />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Overview({ origin }: { origin: string }) {
  return (
    <Section id="overview" title="How it works">
      <p>
        This platform serves two separate APIs, and keeping them apart is the most important thing
        to understand before writing any code.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <h3 className="text-sm font-semibold text-text">Delivery API — {code('/v1/…')}</h3>
          <p className="mt-1 text-sm text-text-secondary">
            What your website talks to. Authenticated with an API key. Reads published content and
            accepts audience writes such as form submissions. Scoped to this one site.
          </p>
        </Card>
        <Card>
          <h3 className="text-sm font-semibold text-text">Admin API — {code('/admin/v1/…')}</h3>
          <p className="mt-1 text-sm text-text-secondary">
            What this portal talks to. Authenticated with a user session. Manages settings, members
            and drafts. <strong className="text-text">Your website should never call it.</strong>
          </p>
        </Card>
      </div>

      <Callout tone="info" title="Why the split matters">
        A Delivery key that leaks — and publishable keys ship in browser bundles, so assume they
        will — can read your published content and nothing else. It cannot touch billing, members,
        settings, drafts, or any other site. That containment is the entire reason for two APIs.
      </Callout>

      <p>
        Base URL for this deployment: {code(origin)}. In local development the portal runs on Vite
        and proxies to the API, so a server outside the browser should call the API directly —
        usually {code('http://localhost:4000')}.
      </p>
    </Section>
  );
}

function Keys({ base, origin }: { base: string; origin: string }) {
  return (
    <Section id="keys" title="Get an API key">
      <p>
        Create one under{' '}
        <Link className="text-accent underline underline-offset-2" to={`${base}/api-keys`}>
          API keys
        </Link>
        . The key is shown <strong className="text-text">once</strong>, at creation — only a hash is
        stored, so a lost key is rotated, never recovered.
      </p>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-secondary">
            <th className="py-2 pr-4 font-medium">Prefix</th>
            <th className="py-2 pr-4 font-medium">Use it</th>
            <th className="py-2 font-medium">Never</th>
          </tr>
        </thead>
        <tbody className="text-text-secondary">
          <tr className="border-b border-border/60">
            <td className="py-2 pr-4">{code('pk_live_…')}</td>
            <td className="py-2 pr-4">
              In the browser. Publishable — safe to ship in a client bundle. Restrict it to your
              domains with an origin allowlist.
            </td>
            <td className="py-2">Cannot hold server-only scopes.</td>
          </tr>
          <tr className="border-b border-border/60">
            <td className="py-2 pr-4">{code('sk_live_…')}</td>
            <td className="py-2 pr-4">
              On a server only — API routes, SSR, build steps. Can be pinned to specific IPs.
            </td>
            <td className="py-2">Never in client code or a public repo.</td>
          </tr>
          <tr>
            <td className="py-2 pr-4">{code('…_test_…')}</td>
            <td className="py-2 pr-4">Staging and CI, so test traffic stays out of live figures.</td>
            <td className="py-2">—</td>
          </tr>
        </tbody>
      </table>

      <p>Send it as a bearer token on every Delivery request:</p>
      <CodeBlock language="http" code={`Authorization: Bearer sk_live_your_key_here`} />

      <p>
        Check a key works — this endpoint accepts any valid key and echoes back what it is allowed
        to do, which makes it the fastest way to tell a bad key from a bad scope:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -H "Authorization: Bearer sk_live_…" \\\n  "${origin}/v1/me"`}
      />
    </Section>
  );
}

function FirstRequest({
  origin,
  sample,
  loading,
}: {
  origin: string;
  sample?: ContentTypeDto;
  loading: boolean;
}) {
  if (loading) return <Section id="first-request" title="Your first request"><Skeleton rows={4} /></Section>;

  if (!sample) {
    return (
      <Section id="first-request" title="Your first request">
        <EmptyState
          title="No content types yet"
          description="Define one under Content model and this guide fills itself in with your real endpoints and field names."
        />
      </Section>
    );
  }

  return (
    <Section id="first-request" title="Your first request">
      <p>
        This fetches published <strong className="text-text">{sample.name}</strong> entries from this
        site. It is a real, working URL — the api_id is yours, not a placeholder.
      </p>
      <CodeBlock
        language="bash"
        code={`curl -H "Authorization: Bearer sk_live_…" \\\n  "${origin}/v1/content/${sample.api_id}?limit=10"`}
      />

      <p>Every response uses the same envelope:</p>
      <CodeBlock
        language="json"
        code={JSON.stringify(
          {
            data: [
              {
                id: 'ent_…',
                slug: 'an-example',
                status: 'published',
                locale: 'en',
                published_at: '2026-01-01T09:00:00.000Z',
                data: sampleData(sample.fields),
              },
            ],
            meta: { total: 42, limit: 10, has_more: true, next_cursor: 'ent_…', request_id: 'req_…' },
          },
          null,
          2,
        )}
      />

      <Callout tone="info" title="Two fields worth noting">
        Your own content lives under {code('data')} — the keys there are the field api_ids from your
        content model. And {code('meta.request_id')} is on every response, including errors: quote
        it in a support request and it can be traced to the exact call in the logs.
      </Callout>
    </Section>
  );
}

function ContentModel({
  types,
  loading,
  base,
}: {
  types: ContentTypeDto[];
  loading: boolean;
  base: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Section id="model" title="Your content model">
      <p>
        The live schema for this site. These are the exact identifiers to use in code — the API IDs
        are permanent, while display names can be renamed at any time, so never key on the name.
      </p>

      {loading ? (
        <Skeleton rows={4} />
      ) : types.length === 0 ? (
        <EmptyState
          title="Nothing defined yet"
          description="Content types you create appear here, with their endpoints and a field reference."
          action={
            <Link
              to={`${base}/settings/content-types`}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              Open content model
            </Link>
          }
        />
      ) : (
        <div className="space-y-2">
          {types.map((type) => (
            <Card key={type.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => setExpanded(expanded === type.id ? null : type.id)}
                aria-expanded={expanded === type.id}
              >
                <span className="min-w-0">
                  <span className="text-sm font-semibold text-text">{type.name}</span>
                  <span className="ml-2 text-xs text-text-secondary">
                    {code(type.api_id)} · {type.kind} · {type.fields.length} field
                    {type.fields.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-secondary">
                  {expanded === type.id ? 'Hide' : 'Show fields'}
                </span>
              </button>

              {expanded === type.id && (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <CodeBlock
                    language="http"
                    code={
                      type.kind === 'single'
                        ? `GET /v1/content/${type.api_id}`
                        : `GET /v1/content/${type.api_id}\nGET /v1/content/${type.api_id}/{slug}`
                    }
                  />
                  {type.fields.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      No fields yet — entries of this type have nothing to return.
                    </p>
                  ) : (
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-text-secondary">
                          <th className="py-1.5 pr-4 font-medium">Key in {code('data')}</th>
                          <th className="py-1.5 pr-4 font-medium">Type</th>
                          <th className="py-1.5 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="text-text-secondary">
                        {type.fields.map((field) => (
                          <tr key={field.id} className="border-b border-border/60 last:border-0">
                            <td className="py-1.5 pr-4">{code(field.api_id)}</td>
                            <td className="py-1.5 pr-4">{field.type}</td>
                            <td className="py-1.5">
                              {[
                                field.required && 'required',
                                field.localised && 'localised',
                                field.deprecated && 'deprecated — stop reading this',
                                field.config?.relationTypeApiId &&
                                  `points at ${field.config.relationTypeApiId}`,
                              ]
                                .filter(Boolean)
                                .join(' · ') || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

function Reading({ origin, sample }: { origin: string; sample?: ContentTypeDto }) {
  const type = sample?.api_id ?? 'your-type';

  return (
    <Section id="reading" title="Reading content">
      <p>
        Only <strong className="text-text">published</strong> entries are ever returned. Drafts,
        scheduled entries and archived ones are invisible to the Delivery API — the single exception
        is a preview token, covered below.
      </p>

      <EndpointTable
        rows={[
          [`GET /v1/content/${type}`, 'A page of published entries.'],
          [`GET /v1/content/${type}/{slug}`, 'One entry by its URL slug — what a page route uses.'],
          ['GET /v1/content/id/{id}', 'One entry by id, when you stored the id rather than the slug.'],
          [`GET /v1/content/${type}/{slug}/related`, 'Entries sharing taxonomy terms with this one.'],
          ['GET /v1/content-types', 'The schema itself, if you generate types or forms from it.'],
          ['GET /v1/search?q=…', 'Full-text search across published entries.'],
          ['GET /v1/taxonomies, /v1/taxonomies/{api_id}/terms', 'Categories and tags.'],
          ['GET /v1/menus/{api_id}', 'A resolved navigation tree.'],
          ['GET /v1/media, /v1/media/{id}', 'Uploaded assets.'],
        ]}
      />

      <Callout tone="info" title="Menus resolve slugs at request time">
        A menu item pointing at an entry always returns that entry’s <em>current</em> slug. Renaming
        a slug therefore never leaves a broken link in your navigation — so build nav from the menu
        endpoint rather than hardcoding paths.
      </Callout>

      <CodeBlock
        language="bash"
        code={`# One page, by slug — the shape of almost every route you will write\ncurl -H "Authorization: Bearer sk_live_…" \\\n  "${origin}/v1/content/${type}/hello-world"`}
      />
    </Section>
  );
}

function Queries({ origin, sample }: { origin: string; sample?: ContentTypeDto }) {
  const type = sample?.api_id ?? 'your-type';

  return (
    <Section id="queries" title="Filtering & pagination">
      <EndpointTable
        rows={[
          ['?limit=&cursor=', 'Cursor pagination. Pass back meta.next_cursor for the next page.'],
          ['?sort=-published_at,title', 'Sort fields, prefixed with - for descending.'],
          ['?filter[data.featured]=true', 'Filter on your own fields, or on status and dates.'],
          ['?filter[published_at][gte]=…', 'Range operators on dates.'],
          ['?fields=id,slug,data.title', 'Return only what you need.'],
          ['?locale=fr', 'A specific locale, with this site’s fallback behaviour applied.'],
        ]}
      />

      <Callout tone="warn" title="Cursors, not page numbers">
        Pagination is keyset-based on purpose. An offset re-reads a window that has shifted if
        anything was published in between, so paging through a busy list with{' '}
        {code('?page=2')} would show you some entries twice and skip others. Follow{' '}
        {code('meta.next_cursor')} until {code('meta.has_more')} is false.
      </Callout>

      <CodeBlock
        language="js"
        code={`// Walk every published entry, one page at a time.
async function* allEntries(apiKey) {
  let cursor = null;

  do {
    const url = new URL('${origin}/v1/content/${type}');
    url.searchParams.set('limit', '100');
    url.searchParams.set('sort', '-published_at');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url, {
      headers: { Authorization: \`Bearer \${apiKey}\` },
    });
    if (!response.ok) throw new Error(\`CMS returned \${response.status}\`);

    const { data, meta } = await response.json();
    yield* data;

    // has_more is the terminator — an empty page is not the signal.
    cursor = meta.has_more ? meta.next_cursor : null;
  } while (cursor);
}`}
      />
    </Section>
  );
}

function Frameworks({ origin, sample }: { origin: string; sample?: ContentTypeDto }) {
  const type = sample?.api_id ?? 'your-type';
  const [tab, setTab] = useState<'next' | 'astro' | 'node'>('next');

  const samples: Record<typeof tab, { label: string; language: string; code: string }> = {
    next: {
      label: 'Next.js',
      language: 'tsx',
      code: `// app/${type}/[slug]/page.tsx
const CMS = '${origin}';

// A secret key, read on the server only. Never NEXT_PUBLIC_*.
const key = process.env.CMS_API_KEY!;

async function getEntry(slug: string) {
  const response = await fetch(\`\${CMS}/v1/content/${type}/\${slug}\`, {
    headers: { Authorization: \`Bearer \${key}\` },
    // Cache the render and let a webhook revalidate it, rather than
    // hitting the CMS on every visitor request.
    next: { tags: ['${type}'], revalidate: 3600 },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(\`CMS \${response.status}\`);

  const { data } = await response.json();
  return data;
}

export async function generateStaticParams() {
  const response = await fetch(\`\${CMS}/v1/content/${type}?fields=slug&limit=100\`, {
    headers: { Authorization: \`Bearer \${key}\` },
  });
  const { data } = await response.json();
  return data.map((entry: { slug: string }) => ({ slug: entry.slug }));
}

export default async function Page({ params }: { params: { slug: string } }) {
  const entry = await getEntry(params.slug);
  if (!entry) notFound();

  return <article>{/* entry.data.* — see "Your content model" above */}</article>;
}`,
    },
    astro: {
      label: 'Astro',
      language: 'astro',
      code: `---
// src/pages/${type}/[slug].astro
const CMS = '${origin}';
const key = import.meta.env.CMS_API_KEY;

export async function getStaticPaths() {
  const response = await fetch(\`\${CMS}/v1/content/${type}?limit=100\`, {
    headers: { Authorization: \`Bearer \${import.meta.env.CMS_API_KEY}\` },
  });
  const { data } = await response.json();

  return data.map((entry) => ({
    params: { slug: entry.slug },
    props: { entry },
  }));
}

const { entry } = Astro.props;
---

<article>
  <!-- entry.data.* — see "Your content model" above -->
</article>`,
    },
    node: {
      label: 'Plain fetch',
      language: 'js',
      code: `// A tiny client — no SDK required.
export function cms(apiKey, base = '${origin}') {
  async function request(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const response = await fetch(url, {
      headers: { Authorization: \`Bearer \${apiKey}\` },
    });

    if (!response.ok) {
      // The error envelope is always JSON and always carries a request_id.
      const body = await response.json().catch(() => null);
      const error = body?.error;
      throw new Error(
        \`\${error?.code ?? response.status}: \${error?.message ?? 'Request failed'} \` +
        \`(request_id \${error?.request_id ?? 'unknown'})\`
      );
    }

    return response.json();
  }

  return {
    list: (type, params) => request(\`/v1/content/\${type}\`, params),
    bySlug: (type, slug) => request(\`/v1/content/\${type}/\${slug}\`),
    search: (q, params) => request('/v1/search', { q, ...params }),
    menu: (apiId) => request(\`/v1/menus/\${apiId}\`),
  };
}`,
    },
  };

  return (
    <Section id="frameworks" title="Framework recipes">
      <div className="flex gap-1.5">
        {(Object.keys(samples) as (keyof typeof samples)[]).map((keyName) => (
          <button
            key={keyName}
            type="button"
            onClick={() => setTab(keyName)}
            className={cx(
              'rounded-lg border px-3 py-1 text-sm',
              tab === keyName
                ? 'border-accent bg-accent/10 font-medium text-text'
                : 'border-border text-text-secondary hover:text-text',
            )}
          >
            {samples[keyName].label}
          </button>
        ))}
      </div>

      <CodeBlock language={samples[tab].language} code={samples[tab].code} />

      <Callout tone="warn" title="Which key goes where">
        Anything running on a server — Next.js server components, {code('getStaticPaths')}, API
        routes — uses a secret key from an environment variable. Only code that ends up in the
        browser bundle uses a publishable key, and that key should have an origin allowlist set on
        it. A secret key in a {code('NEXT_PUBLIC_')} variable is published to every visitor.
      </Callout>
    </Section>
  );
}

function Audience({ origin }: { origin: string }) {
  return (
    <Section id="audience" title="Forms & subscribers">
      <p>
        These are the only Delivery endpoints that write. They are designed to be called from a
        browser with a publishable key, so they carry their own per-IP rate limits on top of the
        per-key ones.
      </p>

      <EndpointTable
        rows={[
          ['POST /v1/subscribers', 'Create or update a subscriber. Scope: subscriber.write'],
          ['GET/PATCH /v1/subscribers/{email}', 'Read or update one subscriber.'],
          ['POST /v1/subscribers/{email}/unsubscribe', 'Honour an unsubscribe.'],
          ['GET /v1/lists', 'Lists available to subscribe to.'],
          ['POST /v1/forms/{api_id}/submit', 'Submit a form. Scope: form.submit'],
          ['GET /v1/forms/{api_id}', 'A form’s definition, to render it.'],
        ]}
      />

      <CodeBlock
        language="js"
        code={`// A newsletter signup, from the browser, with a publishable key.
async function subscribe(email) {
  const response = await fetch('${origin}/v1/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer pk_live_…',
    },
    body: JSON.stringify({ email, source: 'footer-form' }),
  });

  if (response.status === 429) {
    return { ok: false, message: 'Too many attempts. Try again shortly.' };
  }
  if (!response.ok) {
    const { error } = await response.json();
    return { ok: false, message: error.message };
  }

  return { ok: true };
}`}
      />

      <Callout tone="info" title="The admin side of this is not built yet">
        Subscribers, lists and forms can be written to over the Delivery API, and the tables exist.
        The screens for managing them in this portal are Phase 3 — which is why those sidebar items
        are marked “Soon”.
      </Callout>
    </Section>
  );
}

function Webhooks({ base }: { base: string }) {
  return (
    <Section id="webhooks" title="Webhooks">
      <p>
        Rather than polling, have the CMS tell your site when something changes — the usual reason
        being to rebuild a static page or purge a cache the moment an editor publishes. Configure
        endpoints under{' '}
        <Link className="text-accent underline underline-offset-2" to={`${base}/webhooks`}>
          Webhooks
        </Link>
        .
      </p>

      <p>
        Every delivery is signed. <strong className="text-text">Verify the signature</strong> — the
        endpoint is a public URL, and without verification anyone who finds it can trigger your
        rebuilds or feed you fabricated payloads.
      </p>

      <CodeBlock
        language="js"
        code={`import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(signatureHeader, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  // Compare in constant time; a plain === leaks the secret one byte at a time.
  return received.length === computed.length && timingSafeEqual(received, computed);
}

// Verify against the RAW request body, before any JSON parsing.
// Re-serialising parsed JSON changes key order and whitespace, and the
// signature will never match again.`}
      />

      <Callout tone="warn" title="Respond fast, work later">
        Return 2xx as soon as you have verified and queued the work. A slow handler is retried with
        backoff and eventually dead-lettered, so doing the rebuild inline is how you end up
        processing the same event four times.
      </Callout>
    </Section>
  );
}

function Preview({ origin }: { origin: string }) {
  return (
    <Section id="preview" title="Draft preview">
      <p>
        The one way to read unpublished content. The portal mints a short-lived token for a single
        entry; your site exchanges it for the draft. Tokens expire in 15 minutes and are scoped to
        that one entry, so a leaked preview link cannot become a window onto everything unpublished.
      </p>
      <CodeBlock language="bash" code={`curl "${origin}/v1/preview/{token}"`} />
      <p className="text-sm text-text-secondary">
        No API key is needed — the token is the credential. Which is also why a preview URL should
        be treated like one.
      </p>
    </Section>
  );
}

function Errors() {
  return (
    <Section id="errors" title="Errors & rate limits">
      <p>Errors share one envelope. Branch on {code('error.code')}, never on the message text.</p>

      <CodeBlock
        language="json"
        code={JSON.stringify(
          {
            error: {
              type: 'authentication_error',
              code: 'invalid_api_key',
              message: 'That API key is not valid.',
              detail: 'Check the key was copied in full, including the prefix.',
              request_id: 'req_…',
            },
          },
          null,
          2,
        )}
      />

      <EndpointTable
        rows={[
          ['401 missing_api_key / invalid_api_key', 'No key, or one that does not resolve.'],
          ['401 revoked_api_key / expired_api_key', 'The key was rotated or has passed its expiry.'],
          ['403 origin_not_allowed', 'A publishable key called from a domain not on its allowlist.'],
          ['403 insufficient_scope', 'Valid key, but the scope for this endpoint was not granted.'],
          ['404 resource_not_found', 'No such entry — or it is not published.'],
          ['429 rate_limit_exceeded', 'Too many requests. Back off and retry.'],
        ]}
      />

      <p>
        Every response carries {code('X-RateLimit-Limit')}, {code('X-RateLimit-Remaining')} and{' '}
        {code('X-RateLimit-Reset')}. Read them rather than waiting to be refused — and on a 429,
        respect {code('Retry-After')} instead of retrying immediately.
      </p>

      <Callout tone="info" title="A 404 is often a publishing state, not a bad URL">
        The Delivery API cannot see drafts, so an entry an editor is still working on is genuinely
        absent from it. Before debugging the URL, check the entry is published — this is the single
        most common “the API is broken” report.
      </Callout>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function TopicRail({ base }: { base: string }) {
  return (
    <nav className="sticky top-8 hidden h-fit w-52 shrink-0 lg:block" aria-label="Guide contents">
      <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text/60">
        On this page
      </p>
      <ul className="space-y-0.5">
        {TOPICS.map((topic) => (
          <li key={topic.id}>
            <a
              href={`#${topic.id}`}
              className="block rounded-lg px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-subtle hover:text-text"
            >
              {topic.label}
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t border-border pt-3">
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="block rounded-lg px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-subtle hover:text-text"
        >
          Full API reference ↗
        </a>
        <Link
          to={`${base}/api-keys`}
          className="block rounded-lg px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-subtle hover:text-text"
        >
          Manage API keys
        </Link>
      </div>
    </nav>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    // scroll-mt keeps the heading clear of the sticky header when jumped to.
    <section id={id} className="scroll-mt-8 space-y-3">
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

function CodeBlock({ code: source, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  // Written by hand rather than pulled from a highlighter: syntax colouring is
  // a large dependency for something read a handful of times per integration.
  const copy = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-surface-subtle">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-text-secondary">{language}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface hover:text-text"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* Wide samples scroll inside the block; the page itself must not. */}
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed text-text">
        <code>{source}</code>
      </pre>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn';
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        'rounded-lg border px-3 py-2.5 text-sm',
        tone === 'warn'
          ? 'border-warning/40 bg-warning/10 text-text-secondary'
          : 'border-border bg-surface-subtle text-text-secondary',
      )}
    >
      <p className="font-semibold text-text">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function EndpointTable({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <tbody className="text-text-secondary">
        {rows.map(([left, right]) => (
          <tr key={left} className="border-b border-border/60 last:border-0 align-top">
            <td className="whitespace-nowrap py-1.5 pr-4">{code(left)}</td>
            <td className="py-1.5">{right}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function code(value: string) {
  return (
    <code className="rounded bg-surface-subtle px-1 py-px font-mono text-[0.85em] text-text">
      {value}
    </code>
  );
}

/** A plausible `data` object built from the type's real fields. */
function sampleData(fields: FieldDto[]): Record<string, unknown> {
  const shape: Record<string, unknown> = {};

  for (const field of fields.slice(0, 6)) {
    shape[field.api_id] = exampleFor(field);
  }

  return shape;
}

function exampleFor(field: FieldDto): unknown {
  switch (field.type) {
    case 'number':
    case 'decimal':
      return 42;
    case 'boolean':
      return true;
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T09:00:00.000Z';
    case 'media':
      return { id: 'ast_…', url: 'https://…/image.jpg', width: 1600, height: 900 };
    case 'media_list':
      return [{ id: 'ast_…', url: 'https://…/image.jpg' }];
    case 'relation_one':
      return { id: 'ent_…', slug: 'related-entry' };
    case 'relation_many':
      return [{ id: 'ent_…', slug: 'related-entry' }];
    case 'rich_text':
      // Structured JSON, never an HTML blob — see Open Decision #3.
      return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '…' }] }] };
    case 'json':
      return {};
    case 'multi_enum':
      return ['one', 'two'];
    case 'geo':
      return { lat: 51.5074, lng: -0.1278 };
    case 'email':
      return 'someone@example.com';
    case 'url':
      return 'https://example.com';
    case 'colour':
      return '#4F46E5';
    default:
      return 'A string value';
  }
}
