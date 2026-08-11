import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDto, WorkspaceMemberDto } from '@cms/shared';

import { ApiError, api } from '../lib/api';
import { Button, Card, CopyableId, Field, Input } from '../components/primitives';
import { TransferOwnership } from '../components/TransferOwnership';
import { useSession } from '../lib/session';

/**
 * Site settings — the General group of §6.5, plus the danger zone.
 *
 * The remaining groups (Localisation, Content, Media, Audience, Email, API)
 * configure modules that do not exist yet; adding their forms now would let
 * someone set a value that nothing reads.
 */
export function SiteSettings() {
  const { currentWorkspace, currentOrg, refresh, can } = useSession();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ name: '', description: '', primary_url: '', timezone: '' });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!currentWorkspace) return;
    setForm({
      name: currentWorkspace.name,
      description: currentWorkspace.description ?? '',
      primary_url: currentWorkspace.primary_url ?? '',
      timezone: currentWorkspace.timezone,
    });
    setDirty(false);
  }, [currentWorkspace]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<WorkspaceDto>(`/admin/v1/workspaces/${currentWorkspace!.id}`, {
        name: form.name,
        description: form.description,
        timezone: form.timezone,
        ...(form.primary_url ? { primary_url: form.primary_url } : {}),
      }),
    onSuccess: async () => {
      setDirty(false);
      setError(null);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (caught) => setError(caught as ApiError),
  });

  if (!currentWorkspace) return null;

  const editable = can('workspace.settings.edit');

  function update(patch: Partial<typeof form>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  return (
    <div className="max-w-2xl space-y-6 pb-24">
      <header>
        <h1 className="text-2xl font-semibold text-text">Site settings</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Called a “site” here and a workspace in the API.
        </p>
      </header>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Identifiers</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Every Admin API path is built from the site id, so it is the one value you will need
            again and again.
          </p>
        </div>

        <CopyableId
          label="Site ID"
          value={currentWorkspace.id}
          hint={`Used as {workspaceId} in /admin/v1/workspaces/{workspaceId}/…`}
        />

        {currentOrg && <CopyableId label="Organisation ID" value={currentOrg.id} />}

        <CopyableId
          label="Slug"
          value={currentWorkspace.slug}
          hint="Part of this site’s portal URLs. Changing it breaks existing links."
        />
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-text">General</h2>

        <Field label="Name">
          <Input
            value={form.name}
            disabled={!editable}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>

        <Field label="Description">
          <Input
            value={form.description}
            disabled={!editable}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>

        <Field
          label="Live site URL"
          hint="Informational only — never fetched or verified. Used for preview links."
        >
          <Input
            type="url"
            value={form.primary_url}
            disabled={!editable}
            onChange={(event) => update({ primary_url: event.target.value })}
          />
        </Field>

        <Field label="Timezone" hint="Drives content scheduling, campaign send times and reports.">
          <Input
            value={form.timezone}
            disabled={!editable}
            onChange={(event) => update({ timezone: event.target.value })}
          />
        </Field>
      </Card>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{error.message}</p>
          {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
        </div>
      )}

      {/* §17.17: a sticky save bar that appears only when the form is dirty,
          with Discard alongside. */}
      {dirty && editable && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface-raised px-6 py-3">
          <div className="mx-auto flex max-w-2xl items-center justify-between">
            <p className="text-sm text-text-secondary">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setForm({
                    name: currentWorkspace.name,
                    description: currentWorkspace.description ?? '',
                    primary_url: currentWorkspace.primary_url ?? '',
                    timezone: currentWorkspace.timezone,
                  });
                  setDirty(false);
                }}
              >
                Discard
              </Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <OwnershipCard workspace={currentWorkspace} />

      <DangerZone workspace={currentWorkspace} />
    </div>
  );
}

/**
 * Site ownership (§6.3).
 *
 * The owner is resolved from the members list rather than fetched separately —
 * the list already carries `is_owner`, and one request that answers both "who
 * owns this" and "who else is here" beats two.
 */
function OwnershipCard({ workspace }: { workspace: WorkspaceDto }) {
  const { refresh, can } = useSession();
  const queryClient = useQueryClient();

  const members = useQuery({
    queryKey: ['workspace-members', workspace.id],
    queryFn: () => api.list<WorkspaceMemberDto>(`/admin/v1/workspaces/${workspace.id}/members`),
    enabled: can('workspace.view'),
  });

  if (!can('workspace.ownership.transfer')) return null;

  const owner = members.data?.items.find((m) => m.is_owner) ?? null;

  return (
    <TransferOwnership
      scope="site"
      name={workspace.name}
      endpoint={`/admin/v1/workspaces/${workspace.id}/transfer-ownership`}
      ownerLabel={owner ? (owner.user.full_name ?? owner.user.email) : null}
      consequence="The new owner becomes Site Admin; the outgoing owner is demoted to Editor and keeps access to the site."
      disabled={workspace.status === 'archived'}
      onTransferred={async () => {
        await refresh();
        await queryClient.invalidateQueries({ queryKey: ['workspace-members', workspace.id] });
      }}
    />
  );
}

/** §17.17: always the last card, red-bordered, typed confirmation for each action. */
function DangerZone({ workspace }: { workspace: WorkspaceDto }) {
  const { refresh, can } = useSession();
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const archive = useMutation({
    mutationFn: () => api.post(`/admin/v1/workspaces/${workspace.id}/archive`),
    onSuccess: () => refresh(),
    onError: (caught) => setError(caught as ApiError),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.delete(`/admin/v1/workspaces/${workspace.id}`, { confirm_name: confirmName }),
    onSuccess: () => refresh(),
    onError: (caught) => setError(caught as ApiError),
  });

  if (!can('workspace.settings.edit')) return null;

  return (
    <div className="rounded-xl border border-danger/40 bg-danger/5 p-5">
      <h2 className="text-sm font-semibold text-danger">Danger zone</h2>

      <div className="mt-4 flex items-start justify-between gap-4 border-b border-danger/20 pb-4">
        <div>
          <p className="text-sm font-medium text-text">Archive this site</p>
          <p className="mt-0.5 text-sm text-text-secondary">
            The site becomes read-only and its API keys stop working. Content is kept and this
            is reversible.
          </p>
        </div>
        <Button
          variant="secondary"
          loading={archive.isPending}
          disabled={workspace.status === 'archived'}
          onClick={() => archive.mutate()}
        >
          {workspace.status === 'archived' ? 'Archived' : 'Archive'}
        </Button>
      </div>

      <div className="mt-4">
        <p className="text-sm font-medium text-text">Delete this site</p>
        <p className="mt-0.5 text-sm text-text-secondary">
          Recoverable for 30 days, then permanently purged including all media. Requires an
          organisation Owner or Admin.
        </p>

        <div className="mt-3 flex gap-2">
          <Input
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            placeholder={`Type "${workspace.name}" to confirm`}
          />
          <Button
            variant="danger"
            loading={remove.isPending}
            disabled={confirmName !== workspace.name}
            onClick={() => remove.mutate()}
          >
            Delete
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-danger">
          {error.message} {error.detail}
        </p>
      )}
    </div>
  );
}
