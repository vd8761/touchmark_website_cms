import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WORKSPACE_ROLES, type WorkspaceMemberDto, type WorkspaceRole } from '@cms/shared';

import { ApiError, api } from '../lib/api';
import { Card, EmptyState, ErrorState, Pill, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

/**
 * Site members — §6.4 and §17.17.
 *
 * Org Owners and Admins appear here with an "inherited" pill: they hold Site
 * Admin implicitly (§3.3) and have no membership row, so their role cannot be
 * changed or removed from this screen. Hiding them would make the site look
 * unadministered; showing them as editable would produce actions that fail.
 */
export function Members() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const workspaceId = currentWorkspace?.id;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: () =>
      api.list<WorkspaceMemberDto>(`/admin/v1/workspaces/${workspaceId}/members`),
    enabled: Boolean(workspaceId),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      api.patch(`/admin/v1/workspaces/${workspaceId}/members/${userId}`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace-members', workspaceId] }),
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/admin/v1/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace-members', workspaceId] }),
  });

  const manageable = can('workspace.member.manage');

  if (isLoading) return <Skeleton rows={6} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load members"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const members = data?.items ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Members</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Who can work in {currentWorkspace?.name}, and with which role.
        </p>
      </header>

      {members.length === 0 ? (
        <EmptyState
          title="No members yet"
          description="Invite people to the organisation, then grant them a role on this site."
        />
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-5 py-3 font-medium">Person</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Added</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium text-text">{member.user.full_name ?? '—'}</p>
                    <p className="text-xs text-text-secondary">{member.user.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    {member.inherited || member.is_owner || !manageable ? (
                      <span className="flex items-center gap-2">
                        <span className="capitalize text-text">
                          {member.role.replace('_', ' ')}
                        </span>
                        {member.is_owner && <Pill tone="success">Owner</Pill>}
                        {member.inherited && <Pill tone="accent">Inherited</Pill>}
                      </span>
                    ) : (
                      <select
                        value={member.role}
                        onChange={(event) =>
                          changeRole.mutate({
                            userId: member.user.id,
                            role: event.target.value as WorkspaceRole,
                          })
                        }
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-sm capitalize"
                      >
                        {WORKSPACE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-5 py-3 text-text-secondary">
                    {new Date(member.added_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {manageable && !member.inherited && !member.is_owner && (
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
        </Card>
      )}

      {members.some((m) => m.inherited) && (
        <p className="text-xs text-text-secondary">
          Inherited members are organisation Owners and Admins. They hold Site Admin on every
          site — change their organisation role to revoke it.
        </p>
      )}

      {members.some((m) => m.is_owner) && (
        <p className="text-xs text-text-secondary">
          The owner’s role cannot be changed here — a site always has someone accountable for it.
          Hand it over from Site settings → Ownership.
        </p>
      )}
    </div>
  );
}
