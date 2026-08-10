import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, EmptyState, ErrorState, Field, Input, Pill, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

export interface EmailConfigurationDto {
  id: string;
  name: string;
  provider: string;
  api_key_last_four: string;
  status: 'pending' | 'active' | 'invalid' | 'disabled';
  status_detail: string | null;
  domains: { name: string; status: string }[];
  verified_domains: string[];
  last_verified_at: string | null;
  webhook_url: string;
  webhook_last_event_at: string | null;
  webhook_event_count: number;
  sites_using: number;
  sender_identities: number;
  created_at: string;
  /** Present only in the create response — shown once and never stored. */
  webhook_signing_secret?: string;
}

/**
 * Organisation settings → Email.
 *
 * An organisation can hold several provider configurations; each site then
 * picks one. Keys are verified against Resend on entry and never returned
 * afterwards, so this screen shows only the last four characters.
 */
export function EmailConfigurations() {
  const { currentOrg } = useSession();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<EmailConfigurationDto | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['email-configurations', orgId],
    queryFn: () => api.list<EmailConfigurationDto>(`/admin/v1/orgs/${orgId}/email-configurations`),
    enabled: Boolean(orgId),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => api.post(`/admin/v1/orgs/${orgId}/email-configurations/${id}/refresh`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['email-configurations', orgId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/v1/orgs/${orgId}/email-configurations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['email-configurations', orgId] }),
  });

  if (isLoading) return <Skeleton rows={4} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load email configurations"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const configs = data?.items ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Email configurations</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Your Resend accounts. Each site chooses one to send through, so you can keep brands,
            regions or environments on separate accounts and separate sending reputations.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          ＋ Add configuration
        </Button>
      </header>

      {revealed?.webhook_signing_secret && (
        <WebhookReveal config={revealed} onDone={() => setRevealed(null)} />
      )}

      {adding && (
        <AddConfiguration
          orgId={orgId!}
          onCancel={() => setAdding(false)}
          onCreated={(config) => {
            setAdding(false);
            setRevealed(config);
            void queryClient.invalidateQueries({ queryKey: ['email-configurations', orgId] });
          }}
        />
      )}

      {configs.length === 0 && !adding ? (
        <EmptyState
          title="No email configurations yet"
          description="Add a Resend API key to let your sites send campaigns and transactional email. You can add more than one."
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add configuration
            </Button>
          }
        />
      ) : (
        configs.map((config) => (
          <Card key={config.id} className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-text">{config.name}</h2>
                  <Pill tone={STATUS_TONE[config.status]}>{config.status}</Pill>
                </div>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Resend · key ending <span className="font-mono">{config.api_key_last_four}</span>
                  {' · '}
                  {config.sites_using} site{config.sites_using === 1 ? '' : 's'}
                </p>
                {config.status_detail && (
                  <p className="mt-1 text-sm text-danger">{config.status_detail}</p>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  loading={refresh.isPending && refresh.variables === config.id}
                  onClick={() => refresh.mutate(config.id)}
                  title="Re-check the key and pull the latest verified domains from Resend"
                >
                  Refresh
                </Button>
                <Button
                  variant="ghost"
                  loading={remove.isPending && remove.variables === config.id}
                  onClick={() => remove.mutate(config.id)}
                >
                  Delete
                </Button>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                Sending domains
              </p>
              {config.domains.length === 0 ? (
                <p className="mt-1 text-sm text-text-secondary">
                  None yet. Add a domain in Resend and verify its DNS records, then Refresh — sites
                  can only send from verified domains.
                </p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {config.domains.map((domain) => (
                    <li key={domain.name}>
                      <Pill tone={domain.status === 'verified' ? 'success' : 'warning'}>
                        {domain.name} · {domain.status}
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg bg-surface-subtle p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                Webhook
              </p>
              <p className="mt-1 break-all font-mono text-xs text-text">
                {window.location.origin.replace('5173', '4000')}
                {config.webhook_url}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {config.webhook_event_count > 0
                  ? `${config.webhook_event_count} events received · last ${
                      config.webhook_last_event_at
                        ? new Date(config.webhook_last_event_at).toLocaleString()
                        : 'never'
                    }`
                  : 'No events received yet. Paste this URL into Resend → Webhooks.'}
              </p>
            </div>

            {remove.error && remove.variables === config.id && (
              <p className="text-sm text-danger">
                {(remove.error as ApiError).message} {(remove.error as ApiError).detail}
              </p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

const STATUS_TONE = {
  active: 'success',
  pending: 'warning',
  invalid: 'danger',
  disabled: 'neutral',
} as const;

function AddConfiguration({
  orgId,
  onCancel,
  onCreated,
}: {
  orgId: string;
  onCancel: () => void;
  onCreated: (config: EmailConfigurationDto) => void;
}) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<EmailConfigurationDto>(`/admin/v1/orgs/${orgId}/email-configurations`, {
        name,
        api_key: apiKey,
      }),
    onSuccess: onCreated,
  });

  const error = create.error as ApiError | null;

  return (
    <Card className="space-y-4 border-accent">
      <h2 className="font-semibold text-text">Add an email configuration</h2>

      <Field label="Name" hint="How this appears in each site’s email dropdown.">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme — production"
          autoFocus
        />
      </Field>

      <Field
        label="Resend API key"
        hint="From resend.com → API Keys. Verified before saving, then encrypted — it is never shown again."
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="re_..."
          autoComplete="off"
        />
      </Field>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={!name || !apiKey}
          onClick={() => create.mutate()}
        >
          Verify and save
        </Button>
      </div>
    </Card>
  );
}

/**
 * One-time reveal of the webhook signing secret, following the API-key pattern
 * of §17.14: it cannot be dismissed until the user confirms they have saved it,
 * because there is no way to show it again.
 */
function WebhookReveal({
  config,
  onDone,
}: {
  config: EmailConfigurationDto;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const url = `${window.location.origin.replace('5173', '4000')}${config.webhook_url}`;

  return (
    <div className="rounded-xl border-2 border-accent bg-accent/5 p-5">
      <h2 className="font-semibold text-text">Finish setting up “{config.name}” in Resend</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Add a webhook in Resend with the URL and signing secret below, so delivery, open, bounce
        and complaint events reach this platform.
      </p>

      <div className="mt-4 space-y-3">
        <CopyRow label="Webhook URL" value={url} />
        <CopyRow label="Signing secret" value={config.webhook_signing_secret!} mono />
      </div>

      <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
        This is the only time the signing secret is shown. Store it now — you can generate a new
        one later, but you cannot recover this one.
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I’ve saved the signing secret
      </label>

      <div className="mt-3 flex justify-end">
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <div className="mt-1 flex gap-2">
        <code
          className={`flex-1 overflow-x-auto rounded-lg border border-border bg-surface px-3 py-2 text-xs ${
            mono ? 'font-mono' : ''
          }`}
        >
          {value}
        </code>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
