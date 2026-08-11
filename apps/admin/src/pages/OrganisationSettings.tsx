import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ORG_ROLES,
  type OrganisationDto,
  type OrganisationMemberDto,
  type OrgRole,
} from '@cms/shared';

import { ApiError, api } from '../lib/api';
import {
  Button,
  Card,
  CopyableId,
  ErrorState,
  Field,
  Input,
  Pill,
  Skeleton,
} from '../components/primitives';
import { TransferOwnership } from '../components/TransferOwnership';
import { useSession } from '../lib/session';

/**
 * Organisation settings — §6.4 and §17.17.
 *
 * Reached from inside a site so the shell and its site switcher stay in place,
 * the same arrangement the organisation email configurations screen uses.
 * Everything here is organisation-scoped, so the gate is the organisation role
 * rather than the site permissions in `can()`.
 */
export function OrganisationSettings() {
  const { currentOrg, refresh } = useSession();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ name: '', billing_email: '' });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    setForm({ name: currentOrg.name, billing_email: '' });
    setDirty(false);
  }, [currentOrg]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<OrganisationDto>(`/admin/v1/orgs/${currentOrg!.id}`, {
        name: form.name,
        ...(form.billing_email ? { billing_email: form.billing_email } : {}),
      }),
    onSuccess: async () => {
      setDirty(false);
      setError(null);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (caught) => setError(caught as ApiError),
  });

  if (!currentOrg) return null;

  const isOwner = currentOrg.role === 'owner';
  const canManageMembers = isOwner || currentOrg.role === 'admin';
  const editable = canManageMembers;

  return (
    <div className="max-w-2xl space-y-6 pb-24">
      <header>
        <h1 className="text-2xl font-semibold text-text">Organisation</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Settings shared by every site in {currentOrg.name}.
        </p>
      </header>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-text">Identifiers</h2>
        <CopyableId label="Organisation ID" value={currentOrg.id} />
        <CopyableId
          label="Slug"
          value={currentOrg.slug}
          hint="Part of every portal URL under this organisation."
        />
      </Card>

      <Card className="space-y-4">
        <h2 className="text-sm font-semibold text-text">General</h2>

        <Field label="Name">
          <Input
            value={form.name}
            disabled={!editable}
            onChange={(event) => {
              setForm((current) => ({ ...current, name: event.target.value }));
              setDirty(true);
            }}
          />
        </Field>

        <Field
          label="Billing email"
          hint="Where invoices and plan notices go. Leave blank to keep the current address."
        >
          <Input
            type="email"
            value={form.billing_email}
            disabled={!editable}
            onChange={(event) => {
              setForm((current) => ({ ...current, billing_email: event.target.value }));
              setDirty(true);
            }}
          />
        </Field>

        {dirty && editable && (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setForm({ name: currentOrg.name, billing_email: '' });
                setDirty(false);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm text-danger">
            {error.message} {error.detail}
          </p>
        )}
      </Card>

      <OrganisationMembers orgId={currentOrg.id} manageable={canManageMembers} isOwner={isOwner} />

      {/* §3.1: only an Owner may transfer the organisation. Showing the form to
          an Admin would produce an action that always fails. */}
      {isOwner && (
        <TransferOwnership
          scope="organisation"
          name={currentOrg.name}
          endpoint={`/admin/v1/orgs/${currentOrg.id}/transfer-ownership`}
          ownerLabel="you"
          consequence="The new owner takes over billing and every site; you stay on as an Admin."
          onTransferred={async () => {
            await refresh();
            await queryClient.invalidateQueries({ queryKey: ['org-members', currentOrg.id] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Organisation members, including people who have been invited but have not
 * joined yet — the API returns both from one endpoint so the table reads as one
 * list of "people in this organisation" rather than two half-lists.
 */
function OrganisationMembers({
  orgId,
  manageable,
  isOwner,
}: {
  orgId: string;
  manageable: boolean;
  isOwner: boolean;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [error, setError] = useState<ApiError | null>(null);

  const { data, isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => api.list<OrganisationMemberDto>(`/admin/v1/orgs/${orgId}/members`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });

  const invite = useMutation({
    mutationFn: () =>
      api.post(`/admin/v1/orgs/${orgId}/invitations`, { email: email.trim(), org_role: role }),
    onSuccess: async () => {
      setEmail('');
      setError(null);
      await invalidate();
    },
    onError: (caught) => setError(caught as ApiError),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: OrgRole }) =>
      api.patch(`/admin/v1/orgs/${orgId}/members/${userId}`, { role: next }),
    onSuccess: invalidate,
    onError: (caught) => setError(caught as ApiError),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/admin/v1/orgs/${orgId}/members/${userId}`),
    onSuccess: invalidate,
    onError: (caught) => setError(caught as ApiError),
  });

  if (isLoading) return <Skeleton rows={4} />;

  if (loadError) {
    const apiError = loadError as ApiError;
    return (
      <ErrorState
        message="Couldn’t load organisation members"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const members = data?.items ?? [];
  // Only an Owner may create another Owner, so the option is hidden otherwise
  // rather than offered and rejected.
  const assignableRoles = ORG_ROLES.filter((r) => r !== 'owner' || isOwner);

  return (
    <Card className="space-y-4 p-0">
      <div className="px-5 pt-5">
        <h2 className="text-sm font-semibold text-text">People</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Organisation roles. Site-by-site access is granted from each site’s Members screen.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="border-y border-border text-left text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-5 py-3 font-medium">Person</th>
            <th className="px-5 py-3 font-medium">Role</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} className="border-b border-border last:border-0">
              <td className="px-5 py-3">
                <p className="flex items-center gap-2 font-medium text-text">
                  {member.user.full_name ?? member.user.email}
                  {member.status === 'invited' && <Pill tone="warning">Invited</Pill>}
                  {member.role === 'owner' && <Pill tone="accent">Owner</Pill>}
                </p>
                <p className="text-xs text-text-secondary">{member.user.email}</p>
              </td>
              <td className="px-5 py-3">
                {manageable && member.status === 'active' && member.role !== 'owner' ? (
                  <select
                    value={member.role}
                    onChange={(event) =>
                      changeRole.mutate({
                        userId: member.user.id,
                        next: event.target.value as OrgRole,
                      })
                    }
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-sm capitalize"
                  >
                    {assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="capitalize text-text">{member.role}</span>
                )}
              </td>
              <td className="px-5 py-3 text-right">
                {manageable && member.status === 'active' && member.role !== 'owner' && (
                  <button
                    type="button"
                    onClick={() => remove.mutate(member.user.id)}
                    className="text-sm text-danger hover:underline"
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {manageable && (
        <div className="space-y-3 px-5 pb-5">
          <p className="text-sm font-medium text-text">Invite someone</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              value={email}
              placeholder="colleague@example.com"
              onChange={(event) => setEmail(event.target.value)}
              className="w-64 flex-none"
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as OrgRole)}
              className="rounded-lg border border-border bg-surface px-2 py-2 text-sm capitalize"
            >
              {assignableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              loading={invite.isPending}
              disabled={!email.trim()}
              onClick={() => invite.mutate()}
            >
              Send invitation
            </Button>
          </div>
          <p className="text-xs text-text-secondary">
            The invitation link is valid for 7 days. Ownership can only be transferred to someone
            who has already joined.
          </p>
        </div>
      )}

      {error && (
        <p className="px-5 pb-5 text-sm text-danger">
          {error.message} {error.detail}
        </p>
      )}
    </Card>
  );
}
