import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, EmptyState, ErrorState, Field, Input, Pill, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

interface ConfigurationOption {
  id: string;
  name: string;
  provider: string;
  status: string;
  selected: boolean;
  verified_domains: string[];
}

interface SenderDto {
  id: string;
  from_name: string;
  from_email: string;
  reply_to_email: string | null;
  status: string;
  is_default: boolean;
  verified_at: string | null;
}

/**
 * Site settings → Email.
 *
 * Two steps, in order: choose one of the organisation's configurations, then
 * add the from-addresses this site sends as. The second is disabled until the
 * first is done, because a from-address can only be validated against a chosen
 * provider account.
 */
export function SiteEmail() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const workspaceId = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${workspaceId}/email`;

  const manageable = can('senderidentity.manage');

  const configs = useQuery({
    queryKey: ['site-email-configs', workspaceId],
    queryFn: () => api.list<ConfigurationOption>(`${base}/configurations`),
    enabled: Boolean(workspaceId),
  });

  const senders = useQuery({
    queryKey: ['site-senders', workspaceId],
    queryFn: () => api.list<SenderDto>(`${base}/senders`),
    enabled: Boolean(workspaceId),
  });

  const select = useMutation({
    mutationFn: (configId: string | null) =>
      api.patch(`${base}/configuration`, { email_configuration_id: configId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['site-email-configs', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['site-senders', workspaceId] });
    },
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.post(`${base}/senders/${id}/default`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['site-senders', workspaceId] }),
  });

  const removeSender = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/senders/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['site-senders', workspaceId] }),
  });

  if (configs.isLoading) return <Skeleton rows={4} />;

  if (configs.error) {
    const apiError = configs.error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load email settings"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void configs.refetch()}
      />
    );
  }

  const options = configs.data?.items ?? [];
  const selected = options.find((option) => option.selected) ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Email</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Which of your organisation’s provider accounts this site sends through, and the
          addresses it sends from.
        </p>
      </header>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Email configuration</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Managed in organisation settings. Switching accounts removes this site’s existing
            from-addresses — they belong to the previous account and would not send.
          </p>
        </div>

        {options.length === 0 ? (
          <EmptyState
            title="No configurations available"
            description="Your organisation has no email configurations yet. An organisation Owner or Admin can add one in organisation settings."
          />
        ) : (
          <Field label="Send through">
            <select
              value={selected?.id ?? ''}
              disabled={!manageable || select.isPending}
              onChange={(event) => select.mutate(event.target.value || null)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text disabled:opacity-50"
            >
              <option value="">— None (this site cannot send email) —</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.verified_domains.length
                    ? ` — ${option.verified_domains.join(', ')}`
                    : ' — no verified domains'}
                </option>
              ))}
            </select>
          </Field>
        )}

        {selected && selected.verified_domains.length === 0 && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
            “{selected.name}” has no verified domains, so this site cannot send yet. Verify a
            domain in Resend, then press Refresh on the configuration in organisation settings.
          </p>
        )}

        {select.error && (
          <p className="text-sm text-danger">{(select.error as ApiError).message}</p>
        )}
      </Card>

      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text">From addresses</h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              The preferred address is used by default for campaigns from this site.
            </p>
          </div>
        </div>

        {!selected ? (
          <p className="text-sm text-text-secondary">
            Choose an email configuration above first.
          </p>
        ) : (
          <>
            {(senders.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-text-secondary">No from-addresses yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {(senders.data?.items ?? []).map((sender) => (
                  <li key={sender.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">
                        {sender.from_name}{' '}
                        <span className="text-text-secondary">&lt;{sender.from_email}&gt;</span>
                      </p>
                      {sender.reply_to_email && (
                        <p className="text-xs text-text-secondary">
                          Replies to {sender.reply_to_email}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {sender.is_default ? (
                        <Pill tone="accent">Preferred</Pill>
                      ) : (
                        manageable && (
                          <button
                            type="button"
                            onClick={() => setDefault.mutate(sender.id)}
                            className="text-xs text-accent hover:underline"
                          >
                            Make preferred
                          </button>
                        )
                      )}
                      {manageable && (
                        <button
                          type="button"
                          onClick={() => removeSender.mutate(sender.id)}
                          className="text-xs text-danger hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {manageable && (
              <AddSender
                base={base}
                allowedDomains={selected.verified_domains}
                onAdded={() =>
                  queryClient.invalidateQueries({ queryKey: ['site-senders', workspaceId] })
                }
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function AddSender({
  base,
  allowedDomains,
  onAdded,
}: {
  base: string;
  allowedDomains: string[];
  onAdded: () => void;
}) {
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to_email: '' });

  const create = useMutation({
    mutationFn: () =>
      api.post(`${base}/senders`, {
        from_name: form.from_name,
        from_email: form.from_email,
        ...(form.reply_to_email ? { reply_to_email: form.reply_to_email } : {}),
      }),
    onSuccess: () => {
      setForm({ from_name: '', from_email: '', reply_to_email: '' });
      onAdded();
    },
  });

  const error = create.error as ApiError | null;

  return (
    <div className="space-y-3 rounded-lg bg-surface-subtle p-4">
      <p className="text-sm font-medium text-text">Add a from-address</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name">
          <Input
            value={form.from_name}
            onChange={(event) => setForm({ ...form, from_name: event.target.value })}
            placeholder="Acme Newsletter"
          />
        </Field>

        <Field
          label="Email address"
          hint={
            allowedDomains.length
              ? `Must be @${allowedDomains.join(' or @')}`
              : 'No verified domains available'
          }
        >
          <Input
            type="email"
            value={form.from_email}
            onChange={(event) => setForm({ ...form, from_email: event.target.value })}
            placeholder={allowedDomains.length ? `news@${allowedDomains[0]}` : 'news@example.com'}
          />
        </Field>
      </div>

      <Field label="Reply-to (optional)">
        <Input
          type="email"
          value={form.reply_to_email}
          onChange={(event) => setForm({ ...form, reply_to_email: event.target.value })}
          placeholder="hello@acme.com"
        />
      </Field>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
        </div>
      )}

      <Button
        variant="secondary"
        loading={create.isPending}
        disabled={!form.from_name || !form.from_email || allowedDomains.length === 0}
        onClick={() => create.mutate()}
      >
        Add address
      </Button>
    </div>
  );
}
