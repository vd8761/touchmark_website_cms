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

const API_KEY_SCOPES = [
  'content.read',
  'content.preview',
  'media.read',
  'subscriber.write',
  'subscriber.read',
  'form.submit',
  'search.read',
] as const;

type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Scopes a publishable key may hold. The API rejects the rest with a 422. */
const PUBLISHABLE_SCOPES: readonly ApiKeyScope[] = [
  'content.read',
  'media.read',
  'form.submit',
  'search.read',
];

const SCOPE_HELP: Record<ApiKeyScope, string> = {
  'content.read': 'Read published entries, content types, taxonomies and menus.',
  'content.preview': 'Read unpublished entries. Server-side only.',
  'media.read': 'Read media assets.',
  'subscriber.write': 'Create and update subscribers, and unsubscribe them.',
  'subscriber.read': 'Read subscriber records. Server-side only.',
  'form.submit': 'Submit public forms.',
  'search.read': 'Search content.',
};

const GRACE_PERIODS = [
  { value: 'immediate', label: 'Immediately' },
  { value: '1h', label: 'After 1 hour' },
  { value: '24h', label: 'After 24 hours' },
  { value: '7d', label: 'After 7 days' },
] as const;

export interface ApiKeyDto {
  id: string;
  name: string;
  type: 'publishable' | 'secret';
  environment: 'live' | 'test';
  prefix: string;
  last_four: string;
  scopes: ApiKeyScope[];
  allowed_origins: string[];
  allowed_ips: string[];
  rate_limit_per_minute: number | null;
  expires_at: string | null;
  status: 'active' | 'revoked' | 'expired';
  last_used_at: string | null;
  usage_count: number;
  rotated_from_id: string | null;
  rotated_to_id: string | null;
  rotation_grace_ends_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only in a create or rotate response — shown once, never stored. */
  key?: string;
}

interface RotateResponse {
  previous: ApiKeyDto;
  replacement: ApiKeyDto;
  grace_ends_at: string | null;
}

/**
 * Site settings → API keys.
 *
 * A key's plaintext exists in exactly one response and is never recoverable, so
 * the reveal panel is deliberately hard to dismiss by accident and is the only
 * thing on screen that can produce it.
 */
export function ApiKeys() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();

  const workspaceId = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${workspaceId}/api-keys`;
  const keysQueryKey = ['api-keys', workspaceId];

  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; name: string; note?: string } | null>(
    null,
  );
  const [editing, setEditing] = useState<ApiKeyDto | null>(null);
  const [rotating, setRotating] = useState<ApiKeyDto | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keysQueryKey,
    queryFn: () => api.list<ApiKeyDto>(base),
    enabled: Boolean(workspaceId) && can('apikey.manage'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keysQueryKey });

  if (!can('apikey.manage')) return <PermissionDenied requiredRole="Site Admin" />;
  if (isLoading) return <Skeleton rows={4} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load API keys"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const keys = data?.items ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">API keys</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Keys your website uses to read published content and capture subscribers through the
            Delivery API. Publishable keys are safe in browser code and are pinned to the origins
            you list; secret keys are for your server only.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          ＋ Create key
        </Button>
      </header>

      {revealed && (
        <RevealPanel
          name={revealed.name}
          plaintext={revealed.key}
          note={revealed.note}
          onDone={() => setRevealed(null)}
        />
      )}

      {creating && (
        <CreateKey
          base={base}
          onCancel={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            if (key.key) setRevealed({ key: key.key, name: key.name });
            void invalidate();
          }}
        />
      )}

      {editing && (
        <EditKey
          base={base}
          apiKey={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}

      {rotating && (
        <RotateKey
          base={base}
          apiKey={rotating}
          onCancel={() => setRotating(null)}
          onRotated={(result) => {
            setRotating(null);
            if (result.replacement.key) {
              setRevealed({
                key: result.replacement.key,
                name: result.replacement.name,
                note: result.grace_ends_at
                  ? `The old key keeps working until ${formatDateTime(result.grace_ends_at)}. Deploy this one before then.`
                  : 'The old key stopped working immediately.',
              });
            }
            void invalidate();
          }}
        />
      )}

      {revoking && (
        <RevokeKey
          base={base}
          apiKey={revoking}
          onCancel={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            void invalidate();
          }}
        />
      )}

      {keys.length === 0 && !creating ? (
        <EmptyState
          title="No API keys yet"
          description="Create a key to let your website fetch published content. You can restrict what each key reaches and revoke it at any time."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        />
      ) : (
        keys.map((key) => (
          <KeyCard
            key={key.id}
            apiKey={key}
            onEdit={() => setEditing(key)}
            onRotate={() => setRotating(key)}
            onRevoke={() => setRevoking(key)}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function KeyCard({
  apiKey,
  onEdit,
  onRotate,
  onRevoke,
}: {
  apiKey: ApiKeyDto;
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const revoked = apiKey.status === 'revoked';
  const expired = apiKey.status === 'expired';
  const inactive = revoked || expired;
  const rotated = Boolean(apiKey.rotated_to_id);

  return (
    <Card className={cxDim(inactive)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text">{apiKey.name}</h2>
            <Pill tone={apiKey.type === 'secret' ? 'warning' : 'neutral'}>{apiKey.type}</Pill>
            <Pill tone={apiKey.environment === 'live' ? 'accent' : 'neutral'}>
              {apiKey.environment}
            </Pill>
            {revoked && <Pill tone="danger">revoked</Pill>}
            {expired && <Pill tone="danger">expired</Pill>}
            {rotated && !revoked && <Pill tone="warning">rotated</Pill>}
          </div>

          {/* Shaped like the real thing — pk_live_…MoYg — so it is recognisable
              against a key pasted in a config file. */}
          <p className="mt-2 font-mono text-sm text-text-secondary">
            {apiKey.prefix}_<span aria-hidden>••••••••</span>
            {apiKey.last_four}
          </p>
        </div>

        {!inactive && (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            {!rotated && (
              <Button variant="secondary" onClick={onRotate}>
                Rotate
              </Button>
            )}
            <Button variant="ghost" onClick={onRevoke}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {apiKey.scopes.map((scope) => (
          <Pill key={scope}>{scope}</Pill>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Detail label="Last used">
          {apiKey.last_used_at ? formatDateTime(apiKey.last_used_at) : 'Never'}
        </Detail>
        <Detail label="Requests">{apiKey.usage_count.toLocaleString()}</Detail>
        <Detail label="Rate limit">
          {apiKey.rate_limit_per_minute
            ? `${apiKey.rate_limit_per_minute}/min`
            : `Default (${apiKey.type === 'secret' ? '1,000' : '300'}/min)`}
        </Detail>
        <Detail label="Expires">
          {apiKey.expires_at ? formatDateTime(apiKey.expires_at) : 'Never'}
        </Detail>
        <Detail label="Created">{formatDateTime(apiKey.created_at)}</Detail>
        {apiKey.rotation_grace_ends_at && !revoked && (
          <Detail label="Stops working">{formatDateTime(apiKey.rotation_grace_ends_at)}</Detail>
        )}
        {apiKey.revoked_at && <Detail label="Revoked">{formatDateTime(apiKey.revoked_at)}</Detail>}
      </dl>

      {apiKey.allowed_origins.length > 0 && (
        <Restriction label="Allowed origins" values={apiKey.allowed_origins} />
      )}
      {apiKey.allowed_ips.length > 0 && (
        <Restriction label="Allowed IPs" values={apiKey.allowed_ips} />
      )}

      {apiKey.type === 'secret' && apiKey.allowed_ips.length === 0 && !inactive && (
        <p className="mt-4 text-xs text-text-secondary">
          This secret key accepts requests from any IP address. Adding an allowlist limits the
          damage if it leaks.
        </p>
      )}
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  );
}

function Restriction({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="mt-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="rounded-md bg-surface-subtle px-2 py-0.5 font-mono text-xs text-text"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The one and only sighting of the plaintext key.
 *
 * It is not dismissed by clicking away or by pressing Escape: losing it means
 * rotating the key, so the only way out is the explicit confirmation.
 */
function RevealPanel({
  name,
  plaintext,
  note,
  onDone,
}: {
  name: string;
  plaintext: string;
  note?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(plaintext);
    setCopied(true);
  }

  return (
    <Card className="border-accent/40 bg-accent/5">
      <h2 className="text-base font-semibold text-text">Copy “{name}” now</h2>
      <p className="mt-1 text-sm text-text-secondary">
        This is the only time this key is shown. We store a hash of it, so it cannot be recovered —
        if you lose it you will have to rotate the key.
      </p>
      {note && <p className="mt-2 text-sm text-text-secondary">{note}</p>}

      <div className="mt-4 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text">
          {plaintext}
        </code>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <Button variant="primary" className="mt-4" onClick={onDone}>
        I’ve stored it safely
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CreateKey({
  base,
  onCancel,
  onCreated,
}: {
  base: string;
  onCancel: () => void;
  onCreated: (key: ApiKeyDto) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'publishable' | 'secret'>('publishable');
  const [environment, setEnvironment] = useState<'live' | 'test'>('live');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['content.read']);
  const [origins, setOrigins] = useState('');
  const [ips, setIps] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [rateLimit, setRateLimit] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<ApiKeyDto>(base, {
        name,
        type,
        environment,
        scopes,
        ...(type === 'publishable' ? { allowed_origins: splitList(origins) } : {}),
        ...(type === 'secret' && ips.trim() ? { allowed_ips: splitList(ips) } : {}),
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
        ...(rateLimit ? { rate_limit_per_minute: Number(rateLimit) } : {}),
      }),
    onSuccess: (key) => onCreated(key),
  });

  // Switching to publishable drops scopes the API would reject anyway, so the
  // 422 never happens: the form cannot express the invalid combination.
  function changeType(next: 'publishable' | 'secret') {
    setType(next);
    if (next === 'publishable') {
      setScopes((current) => current.filter((scope) => PUBLISHABLE_SCOPES.includes(scope)));
    }
  }

  const available = type === 'publishable' ? PUBLISHABLE_SCOPES : API_KEY_SCOPES;
  const error = create.error as ApiError | null;

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-semibold text-text">Create an API key</h2>

      <Field label="Name" hint="Where this key is used — “Marketing site production”.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Type"
          hint={
            type === 'publishable'
              ? 'Safe in browser code. Restricted to the origins you list.'
              : 'Server-side only. Never ship this to a browser.'
          }
        >
          <Select value={type} onChange={(value) => changeType(value as 'publishable' | 'secret')}>
            <option value="publishable">Publishable</option>
            <option value="secret">Secret</option>
          </Select>
        </Field>

        <Field label="Environment" hint="Test keys are for staging and local development.">
          <Select
            value={environment}
            onChange={(value) => setEnvironment(value as 'live' | 'test')}
          >
            <option value="live">Live</option>
            <option value="test">Test</option>
          </Select>
        </Field>
      </div>

      <ScopePicker available={available} selected={scopes} onChange={setScopes} />

      {type === 'publishable' ? (
        <Field
          label="Allowed origins"
          hint="Required. One per line, exact — https://www.example.com."
        >
          <Textarea value={origins} onChange={setOrigins} placeholder={'https://www.example.com'} />
        </Field>
      ) : (
        <Field
          label="Allowed IPs"
          hint="Optional but recommended. One per line. IPv4, IPv6 or IPv4 CIDR."
        >
          <Textarea value={ips} onChange={setIps} placeholder={'203.0.113.4\n198.51.100.0/24'} />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expires" hint="Optional. The key stops working at this moment.">
          <Input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
        <Field
          label="Rate limit"
          hint={`Optional override. Default is ${type === 'secret' ? '1,000' : '300'} per minute.`}
        >
          <Input
            type="number"
            min={1}
            max={60000}
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
            placeholder="requests / minute"
          />
        </Field>
      </div>

      <FormError error={error} />

      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={!name.trim() || scopes.length === 0}
          onClick={() => create.mutate()}
        >
          Create key
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function EditKey({
  base,
  apiKey,
  onCancel,
  onSaved,
}: {
  base: string;
  apiKey: ApiKeyDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(apiKey.name);
  const [scopes, setScopes] = useState<ApiKeyScope[]>(apiKey.scopes);
  const [origins, setOrigins] = useState(apiKey.allowed_origins.join('\n'));
  const [ips, setIps] = useState(apiKey.allowed_ips.join('\n'));
  const [rateLimit, setRateLimit] = useState(
    apiKey.rate_limit_per_minute ? String(apiKey.rate_limit_per_minute) : '',
  );

  const save = useMutation({
    mutationFn: () =>
      api.patch<ApiKeyDto>(`${base}/${apiKey.id}`, {
        name,
        scopes,
        ...(apiKey.type === 'publishable'
          ? { allowed_origins: splitList(origins) }
          : { allowed_ips: splitList(ips) }),
        ...(rateLimit ? { rate_limit_per_minute: Number(rateLimit) } : {}),
      }),
    onSuccess: onSaved,
  });

  const available = apiKey.type === 'publishable' ? PUBLISHABLE_SCOPES : API_KEY_SCOPES;

  return (
    <Card className="space-y-4 border-accent/40">
      <h2 className="text-base font-semibold text-text">Edit “{apiKey.name}”</h2>
      <p className="text-sm text-text-secondary">
        The key itself does not change. Changes take effect within a minute, once the key auth cache
        expires.
      </p>

      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <ScopePicker available={available} selected={scopes} onChange={setScopes} />

      {apiKey.type === 'publishable' ? (
        <Field label="Allowed origins" hint="One per line. At least one is required.">
          <Textarea value={origins} onChange={setOrigins} />
        </Field>
      ) : (
        <Field label="Allowed IPs" hint="One per line. Leave empty to allow any address.">
          <Textarea value={ips} onChange={setIps} />
        </Field>
      )}

      <Field label="Rate limit" hint="Leave empty to use the default for this key type.">
        <Input
          type="number"
          min={1}
          max={60000}
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
        />
      </Field>

      <FormError error={save.error as ApiError | null} />

      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!name.trim() || scopes.length === 0}
          onClick={() => save.mutate()}
        >
          Save changes
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RotateKey({
  base,
  apiKey,
  onCancel,
  onRotated,
}: {
  base: string;
  apiKey: ApiKeyDto;
  onCancel: () => void;
  onRotated: (result: RotateResponse) => void;
}) {
  const [grace, setGrace] = useState<string>('24h');
  const [name, setName] = useState('');

  const rotate = useMutation({
    mutationFn: () =>
      api.post<RotateResponse>(`${base}/${apiKey.id}/rotate`, {
        grace_period: grace,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (result) => onRotated(result),
  });

  return (
    <Card className="space-y-4 border-accent/40">
      <h2 className="text-base font-semibold text-text">Rotate “{apiKey.name}”</h2>
      <p className="text-sm text-text-secondary">
        This issues a replacement key with the same scopes and restrictions. The grace period is how
        long the current key keeps working, so you have time to deploy the new one before anything
        breaks.
      </p>

      <Field label="Old key stops working">
        <Select value={grace} onChange={setGrace}>
          {GRACE_PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </Select>
      </Field>

      {grace === 'immediate' && (
        <p className="text-sm text-danger">
          Anything still using the current key will start failing as soon as you rotate.
        </p>
      )}

      <Field label="Name for the replacement" hint="Optional. One is generated if you leave this.">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <FormError error={rotate.error as ApiError | null} />

      <div className="flex gap-2">
        <Button variant="primary" loading={rotate.isPending} onClick={() => rotate.mutate()}>
          Rotate key
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RevokeKey({
  base,
  apiKey,
  onCancel,
  onRevoked,
}: {
  base: string;
  apiKey: ApiKeyDto;
  onCancel: () => void;
  onRevoked: () => void;
}) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const revoke = useMutation({
    mutationFn: () =>
      api.post(`${base}/${apiKey.id}/revoke`, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: onRevoked,
  });

  // Typed confirmation, as the danger zone in site settings does: revocation is
  // immediate, irreversible, and takes a live website down with it.
  const confirmed = confirmation === apiKey.name;

  return (
    <Card className="space-y-4 border-danger/40 bg-danger/5">
      <h2 className="text-base font-semibold text-text">Revoke “{apiKey.name}”</h2>
      <p className="text-sm text-text-secondary">
        This takes effect immediately and cannot be undone. Any site still using this key will start
        getting <code className="font-mono text-xs">key_revoked</code> errors on its next request.
        To replace a key without downtime, rotate it instead.
      </p>

      <Field label="Reason" hint="Optional. Recorded in the audit log.">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Committed to a public repository"
        />
      </Field>

      <Field label={`Type “${apiKey.name}” to confirm`}>
        <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      </Field>

      <FormError error={revoke.error as ApiError | null} />

      <div className="flex gap-2">
        <Button
          variant="danger"
          loading={revoke.isPending}
          disabled={!confirmed}
          onClick={() => revoke.mutate()}
        >
          Revoke key
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ScopePicker({
  available,
  selected,
  onChange,
}: {
  available: readonly ApiKeyScope[];
  selected: ApiKeyScope[];
  onChange: (scopes: ApiKeyScope[]) => void;
}) {
  function toggle(scope: ApiKeyScope) {
    onChange(
      selected.includes(scope) ? selected.filter((s) => s !== scope) : [...selected, scope],
    );
  }

  return (
    <fieldset>
      <legend className="text-sm font-medium text-text">Scopes</legend>
      <p className="mt-0.5 text-xs text-text-secondary">
        Grant only what this key needs. Server-only scopes are hidden for publishable keys.
      </p>

      <div className="mt-2 space-y-1.5">
        {available.map((scope) => (
          <label key={scope} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={selected.includes(scope)}
              onChange={() => toggle(scope)}
              className="mt-0.5 accent-accent"
            />
            <span className="text-sm">
              <span className="font-mono text-text">{scope}</span>
              <span className="ml-2 text-text-secondary">{SCOPE_HELP[scope]}</span>
            </span>
          </label>
        ))}
      </div>

      {selected.length === 0 && (
        <p className="mt-2 text-xs text-danger">Choose at least one scope.</p>
      )}
    </fieldset>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
    >
      {children}
    </select>
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={3}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text outline-none placeholder:text-text-secondary focus:border-accent"
    />
  );
}

function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
      <p className="text-sm text-text">{error.message}</p>
      {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function cxDim(inactive: boolean): string {
  return inactive ? 'opacity-60' : '';
}
