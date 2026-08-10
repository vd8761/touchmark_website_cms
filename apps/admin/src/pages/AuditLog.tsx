import { useQuery } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip: string | null;
  request_id: string | null;
  occurred_at: string;
}

/** §5.6 / §17.17 — append-only, newest first. */
export function AuditLog() {
  const { currentWorkspace } = useSession();
  const workspaceId = currentWorkspace?.id;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit-log', workspaceId],
    queryFn: () => api.list<AuditRow>(`/admin/v1/workspaces/${workspaceId}/audit-logs`),
    enabled: Boolean(workspaceId),
  });

  if (isLoading) return <Skeleton rows={8} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load the audit log"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const rows = data?.items ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">Audit log</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Every privileged action in this site — who, what, when, from where. Append-only.
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          description="Actions like publishing, key creation and member changes appear here as they happen."
        />
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-5 py-3 font-medium">Action</th>
                <th className="px-5 py-3 font-medium">Resource</th>
                <th className="px-5 py-3 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 text-text-secondary">
                    <time
                      dateTime={row.occurred_at}
                      title={new Date(row.occurred_at).toISOString()}
                    >
                      {new Date(row.occurred_at).toLocaleString()}
                    </time>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-text">{row.action}</td>
                  <td className="px-5 py-3 text-text-secondary">
                    {row.resource_type}
                    {row.resource_id && (
                      <span className="ml-1 font-mono text-xs opacity-60">
                        {row.resource_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-text-secondary">{row.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
