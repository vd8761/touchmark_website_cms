import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PermissionDenied,
  Pill,
  Skeleton,
} from '../components/primitives';
import { useSession } from '../lib/session';

/**
 * The §4.7 event vocabulary a workspace can subscribe to. Kept in the order the
 * events actually happen in, not alphabetically — people scan this list looking
 * for a moment in a workflow, not for a string.
 */
const EVENT_GROUPS = [
  {
    label: 'Content',
    events: [
      'content.created',
      'content.updated',
      'content.published',
      'content.unpublished',
      'content.scheduled',
      'content.deleted',
    ],
  },
  { label: 'Media', events: ['media.uploaded', 'media.deleted'] },
  {
    label: 'Site',
    events: [
      'workspace.created',
      'workspace.archived',
      'workspace.restored',
      'workspace.deletion_scheduled',
    ],
  },
  {
    label: 'People',
    events: ['member.invited', 'member.joined', 'member.removed', 'member.role_changed'],
  },
] as const;

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: string[];
  signing_secret_last_four: string;
  status: 'active' | 'disabled';
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  delivery_count?: number;
  created_at: string;
  updated_at: string;
  /** Present only in the create response — shown once and never stored. */
  signing_secret?: string;
  signing_secret_notice?: string;
}

export interface WebhookDeliveryDto {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  status: 'pending' | 'delivered' | 'failed' | 'dead_lettered';
  attempt: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Site settings → Webhooks.
 *
 * Deliveries are the reason this screen exists. Creating an endpoint is a
 * thirty-second job; working out why the receiver rejected event #4,812 is
 * where the time actually goes, so the delivery log is expandable down to the
 * exact payload sent and the exact body that came back.
 */
export function Webhooks() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();

  const workspaceId = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${workspaceId}/webhooks`;
  const listKey = ['webhooks', workspaceId];

  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<WebhookDto | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookDto | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () => api.list<WebhookDto>(base),
    enabled: Boolean(workspaceId) && can('webhook.manage'),
  });

  if (!can('webhook.manage')) return <PermissionDenied requiredRole="Site Admin" />;
  if (isLoading) return <Skeleton rows={4} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load webhooks"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const webhooks = data?.items ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Webhooks</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Tell your systems when something changes here — rebuild a static site on publish, sync
            an entry into a search index, post to a channel. Every request is signed, and failures
            retry for a day before we give up.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          ＋ Add endpoint
        </Button>
      </header>

      {revealed?.signing_secret && (
        <SecretReveal webhook={revealed} onDone={() => setRevealed(null)} />
      )}

      {creating && (
        <CreateWebhook
          base={base}
          onCancel={() => setCreating(false)}
          onCreated={(webhook) => {
            setCreating(false);
            setRevealed(webhook);
            void queryClient.invalidateQueries({ queryKey: listKey });
          }}
        />
      )}

      {deleting && (
        <DeleteWebhook
          base={base}
          webhook={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void queryClient.invalidateQueries({ queryKey: listKey });
          }}
        />
      )}

      {webhooks.length === 0 && !creating ? (
        <EmptyState
          title="No webhooks yet"
          description="Add an endpoint and we’ll POST a signed JSON payload to it whenever one of the events you choose happens."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add endpoint
            </Button>
          }
        />
      ) : (
        webhooks.map((webhook) => (
          <WebhookCard
            key={webhook.id}
            base={base}
            webhook={webhook}
            expanded={expanded === webhook.id}
            onToggle={() => setExpanded(expanded === webhook.id ? null : webhook.id)}
            onDelete={() => setDeleting(webhook)}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function WebhookCard({
  base,
  webhook,
  expanded,
  onToggle,
  onDelete,
}: {
  base: string;
  webhook: WebhookDto;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const disabled = webhook.status !== 'active';

  const sendTest = useMutation({
    mutationFn: () => api.post<WebhookDeliveryDto>(`${base}/${webhook.id}/test`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', webhook.id] }),
  });

  return (
    <Card className={disabled ? 'opacity-70' : undefined}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text">{webhook.name}</h2>
            {disabled ? <Pill tone="danger">disabled</Pill> : <Pill tone="success">active</Pill>}
            {webhook.consecutive_failures > 0 && (
              <Pill tone="warning">
                {webhook.consecutive_failures} failure
                {webhook.consecutive_failures === 1 ? '' : 's'} in a row
              </Pill>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-sm text-text-secondary">{webhook.url}</p>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            loading={sendTest.isPending}
            disabled={disabled}
            onClick={() => sendTest.mutate()}
          >
            Send test
          </Button>
          <Button variant="ghost" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {/* 15 consecutive failures disables an endpoint automatically, so a
          climbing counter is the one number worth interrupting someone for. */}
      {disabled && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-text">
          This endpoint was disabled after too many consecutive failures. Fix the receiver, then
          delete and re-add it to start again.
        </p>
      )}

      {sendTest.error && (
        <p className="mt-3 text-sm text-danger">{(sendTest.error as ApiError).message}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {webhook.events.includes('*') ? (
          <Pill tone="accent">every event</Pill>
        ) : (
          webhook.events.map((event) => <Pill key={event}>{event}</Pill>)
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Detail label="Signing secret">
          <span className="font-mono">••••{webhook.signing_secret_last_four}</span>
        </Detail>
        <Detail label="Last success">
          {webhook.last_success_at ? formatDateTime(webhook.last_success_at) : 'Never'}
        </Detail>
        <Detail label="Last failure">
          {webhook.last_failure_at ? formatDateTime(webhook.last_failure_at) : 'Never'}
        </Detail>
      </dl>

      <button
        type="button"
        onClick={onToggle}
        className="mt-4 text-sm font-medium text-accent hover:underline"
      >
        {expanded ? 'Hide deliveries' : 'Show deliveries'}
      </button>

      {expanded && <Deliveries base={base} webhookId={webhook.id} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Deliveries({ base, webhookId }: { base: string; webhookId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const deliveriesKey = ['webhook-deliveries', webhookId];

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: deliveriesKey,
    queryFn: () => api.list<WebhookDeliveryDto>(`${base}/${webhookId}/deliveries`),
  });

  const replay = useMutation({
    mutationFn: (deliveryId: string) =>
      api.post<WebhookDeliveryDto>(`${base}/deliveries/${deliveryId}/replay`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deliveriesKey }),
  });

  if (isLoading) return <div className="mt-4"><Skeleton rows={3} /></div>;

  if (error) {
    const apiError = error as ApiError;
    return (
      <div className="mt-4">
        <ErrorState
          message="Couldn’t load deliveries"
          detail={apiError.detail}
          code={apiError.code}
          requestId={apiError.requestId}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const deliveries = data?.items ?? [];

  if (deliveries.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
        No deliveries yet. Publish something, or use “Send test” to check the endpoint is wired up.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-secondary">Most recent first</p>
        <Button variant="ghost" onClick={() => void refetch()}>
          Refresh
        </Button>
      </div>

      {deliveries.map((delivery) => (
        <div key={delivery.id} className="rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setOpen(open === delivery.id ? null : delivery.id)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-subtle"
          >
            <DeliveryStatusPill delivery={delivery} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">
              {delivery.event_type}
            </span>
            {delivery.attempt > 1 && (
              <span className="text-xs text-text-secondary">attempt {delivery.attempt}</span>
            )}
            <span className="shrink-0 text-xs text-text-secondary">
              {formatDateTime(delivery.created_at)}
            </span>
          </button>

          {open === delivery.id && (
            <div className="space-y-3 border-t border-border px-3 py-3">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Detail label="Event id">
                  <span className="font-mono text-xs">{delivery.event_id}</span>
                </Detail>
                <Detail label="Response">
                  {delivery.response_status ?? <span className="text-text-secondary">—</span>}
                </Detail>
                <Detail label="Delivered">
                  {delivery.delivered_at ? formatDateTime(delivery.delivered_at) : 'Not yet'}
                </Detail>
                {delivery.next_attempt_at && (
                  <Detail label="Next attempt">
                    {formatDateTime(delivery.next_attempt_at)}
                  </Detail>
                )}
              </dl>

              {delivery.error && (
                <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
                  <p className="text-xs font-medium text-text">Error</p>
                  <p className="mt-1 font-mono text-xs text-text-secondary">{delivery.error}</p>
                </div>
              )}

              <Payload label="Request body (what we sent)" value={delivery.payload} />
              {delivery.response_body && (
                <Payload label="Response body (what came back)" value={delivery.response_body} />
              )}

              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  loading={replay.isPending && replay.variables === delivery.id}
                  onClick={() => replay.mutate(delivery.id)}
                >
                  Replay
                </Button>
                <p className="text-xs text-text-secondary">
                  Sends the same payload again as a new delivery. Your receiver should treat
                  repeats of an event id as one event.
                </p>
              </div>

              {replay.error && replay.variables === delivery.id && (
                <p className="text-sm text-danger">{(replay.error as ApiError).message}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DeliveryStatusPill({ delivery }: { delivery: WebhookDeliveryDto }) {
  if (delivery.status === 'delivered') return <Pill tone="success">delivered</Pill>;
  if (delivery.status === 'pending') return <Pill tone="neutral">pending</Pill>;
  if (delivery.status === 'dead_lettered') return <Pill tone="danger">gave up</Pill>;
  return <Pill tone="warning">failed</Pill>;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === 'string' ? tryPrettyJson(value) : JSON.stringify(value, null, 2) ?? '';

  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-subtle p-3 font-mono text-xs text-text">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateWebhook({
  base,
  onCancel,
  onCreated,
}: {
  base: string;
  onCancel: () => void;
  onCreated: (webhook: WebhookDto) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [everything, setEverything] = useState(false);
  const [events, setEvents] = useState<string[]>(['content.published']);

  const create = useMutation({
    mutationFn: () =>
      api.post<WebhookDto>(base, { name, url, events: everything ? ['*'] : events }),
    onSuccess: (webhook) => onCreated(webhook),
  });

  function toggle(event: string) {
    setEvents((current) =>
      current.includes(event) ? current.filter((e) => e !== event) : [...current, event],
    );
  }

  const error = create.error as ApiError | null;
  const ready = name.trim() && url.trim() && (everything || events.length > 0);

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold text-text">Add a webhook endpoint</h2>

      <Field label="Name" hint="What this endpoint is for — “Rebuild marketing site”.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>

      <Field
        label="URL"
        hint="Must be https in production. We POST JSON here and expect a 2xx within 10 seconds."
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/hooks/cms"
        />
      </Field>

      <fieldset>
        <legend className="text-sm font-medium text-text">Events</legend>

        <label className="mt-2 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={everything}
            onChange={(e) => setEverything(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-sm text-text">
            Everything
            <span className="ml-2 text-text-secondary">
              including events added in future releases
            </span>
          </span>
        </label>

        {!everything && (
          <div className="mt-3 space-y-3">
            {EVENT_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-medium text-text-secondary">{group.label}</p>
                <div className="mt-1 space-y-1">
                  {group.events.map((event) => (
                    <label key={event} className="flex cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={events.includes(event)}
                        onChange={() => toggle(event)}
                        className="accent-accent"
                      />
                      <span className="font-mono text-sm text-text">{event}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {!everything && events.length === 0 && (
          <p className="mt-2 text-xs text-danger">Choose at least one event.</p>
        )}
      </fieldset>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={!ready}
          onClick={() => create.mutate()}
        >
          Add endpoint
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function SecretReveal({ webhook, onDone }: { webhook: WebhookDto; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const secret = webhook.signing_secret!;

  return (
    <Card className="border-accent/40 bg-accent/5">
      <h2 className="text-base font-semibold text-text">Copy the signing secret for “{webhook.name}”</h2>
      <p className="mt-1 text-sm text-text-secondary">
        {webhook.signing_secret_notice ?? 'Copy this secret now. It is not shown again.'} Your
        receiver uses it to verify the <code className="font-mono text-xs">X-Signature</code> header
        — without that check, anyone who learns your URL can forge events.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text">
          {secret}
        </code>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <Button variant="primary" className="mt-4" onClick={onDone}>
        I’ve stored it safely
      </Button>
    </Card>
  );
}

function DeleteWebhook({
  base,
  webhook,
  onCancel,
  onDeleted,
}: {
  base: string;
  webhook: WebhookDto;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => api.delete(`${base}/${webhook.id}`),
    onSuccess: onDeleted,
  });

  return (
    <Card className="space-y-4 border-danger/40 bg-danger/5">
      <h2 className="text-base font-semibold text-text">Delete “{webhook.name}”?</h2>
      <p className="text-sm text-text-secondary">
        We stop sending to <span className="font-mono">{webhook.url}</span> immediately. Pending
        retries are abandoned and the delivery history goes with it.
      </p>

      {remove.error && (
        <p className="text-sm text-danger">{(remove.error as ApiError).message}</p>
      )}

      <div className="flex gap-2">
        <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
          Delete endpoint
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Receivers usually answer in JSON; show it formatted when it is, raw when not. */
function tryPrettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
