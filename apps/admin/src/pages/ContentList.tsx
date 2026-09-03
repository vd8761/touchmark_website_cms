import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, EmptyState, ErrorState, Pill, Skeleton } from '../components/primitives';
import {
  STATUS_LABEL,
  STATUS_TONE,
  entryTitle,
  type ContentTypeDto,
  type EntryDto,
  type EntryStatus,
} from '../lib/content-types';
import { useSession } from '../lib/session';

const TABS: { label: string; status?: EntryStatus }[] = [
  { label: 'All' },
  { label: 'Published', status: 'published' },
  { label: 'Drafts', status: 'draft' },
  { label: 'Scheduled', status: 'scheduled' },
  { label: 'Archived', status: 'archived' },
];

/** The content list of §17.4 — saved-view tabs, status filter, row actions. */
export function ContentList() {
  const { typeApiId } = useParams();
  const navigate = useNavigate();
  const { currentWorkspace, currentOrg, can } = useSession();
  const queryClient = useQueryClient();

  const ws = currentWorkspace?.id;
  const [status, setStatus] = useState<EntryStatus | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const base = `/o/${currentOrg?.slug}/s/${currentWorkspace?.slug}/content/${typeApiId}`;

  const typesQuery = useQuery({
    queryKey: ['content-types', ws],
    queryFn: () => api.list<ContentTypeDto>(`/admin/v1/workspaces/${ws}/content-types`),
    enabled: Boolean(ws),
  });

  const type = typesQuery.data?.items.find((t) => t.api_id === typeApiId);

  const entriesQuery = useQuery({
    queryKey: ['entries', ws, typeApiId, status],
    queryFn: () =>
      api.list<EntryDto>(
        `/admin/v1/workspaces/${ws}/content/${typeApiId}${status ? `?status=${status}` : ''}`,
      ),
    enabled: Boolean(ws && typeApiId),
  });

  const create = useMutation({
    mutationFn: () => {
      setCreateError(null);
      return api.post<EntryDto>(`/admin/v1/workspaces/${ws}/content/${typeApiId}`, { data: {} });
    },
    onSuccess: (newEntry) => {
      void queryClient.invalidateQueries({ queryKey: ['entries', ws, typeApiId] });
      navigate(`${base}/${newEntry.id}`);
    },
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setCreateError(caught.message);
      } else {
        setCreateError((caught as Error).message || 'Failed to create entry.');
      }
    },
  });

  const remove = useMutation({
    mutationFn: (entryId: string) =>
      api.delete(`/admin/v1/workspaces/${ws}/content/entries/${entryId}`),
    onSuccess: () => {
      setDeletingId(null);
      void queryClient.invalidateQueries({ queryKey: ['entries', ws, typeApiId] });
    },
  });

  if (typesQuery.isLoading || entriesQuery.isLoading) return <Skeleton rows={8} />;

  if (entriesQuery.error) {
    const apiError = entriesQuery.error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load entries"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void entriesQuery.refetch()}
      />
    );
  }

  const entries = entriesQuery.data?.items ?? [];
  const total = entriesQuery.data?.meta.total ?? 0;
  const canCreate = can('content.create') || can('content.edit.own');
  const canDelete = can('content.delete') || can('content.delete.own_draft');

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-text-secondary">Content</p>
          <h1 className="text-2xl font-semibold text-text">
            {type?.name ?? typeApiId}{' '}
            <span className="text-base font-normal text-text-secondary">({total})</span>
          </h1>
        </div>
        {canCreate && (
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            ＋ New {type?.name ?? 'entry'}
          </Button>
        )}
      </header>

      {createError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          <p className="font-medium">{createError}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            onClick={() => setStatus(tab.status)}
            className={`rounded-full border px-3 py-1 text-sm ${
              status === tab.status
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-text-secondary hover:bg-surface-subtle'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        status ? (
          <EmptyState
            title="No entries match this filter"
            description="Try a different status, or clear the filter to see everything."
            action={
              <Button variant="secondary" onClick={() => setStatus(undefined)}>
                Clear filter
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={`No ${type?.name.toLowerCase() ?? 'entries'} yet`}
            description={
              type && type.fields.length === 0
                ? 'This type has no fields yet — add some in Content types first, or create an entry and add fields as you go.'
                : 'Create your first entry. It saves as a draft, so you can fill it in over time.'
            }
            action={
              canCreate && (
                <Button variant="primary" onClick={() => create.mutate()}>
                  Create entry
                </Button>
              )
            }
          />
        )
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-5 py-3 font-medium">Title</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3 font-medium">Version</th>
                {canDelete && <th className="px-5 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border last:border-0 hover:bg-surface-subtle">
                  <td className="px-5 py-3">
                    <Link to={`${base}/${entry.id}`} className="font-medium text-text hover:underline">
                      {entryTitle(entry, type?.fields ?? [])}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2">
                      {entry.slug && (
                        <span className="font-mono text-xs text-text-secondary">/{entry.slug}</span>
                      )}
                      {/* The "unpublished changes" dot of §17.4. */}
                      {entry.has_unpublished_changes && (
                        <span className="text-xs text-warning" title="Edited since it was published">
                          ● unpublished changes
                        </span>
                      )}
                      {entry.is_incomplete && (
                        <span className="text-xs text-danger" title="A required field was added after this was saved">
                          ● incomplete
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Pill tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Pill>
                  </td>
                  <td className="px-5 py-3 text-text-secondary">
                    <time dateTime={entry.updated_at} title={new Date(entry.updated_at).toISOString()}>
                      {new Date(entry.updated_at).toLocaleDateString()}
                    </time>
                  </td>
                  <td className="px-5 py-3 text-text-secondary">v{entry.current_version}</td>
                  {canDelete && (
                    <td className="px-5 py-3 text-right">
                      {deletingId === entry.id ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="text-xs text-danger">Delete?</span>
                          <button
                            type="button"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(entry.id)}
                            className="rounded px-1.5 py-0.5 text-xs font-semibold text-danger hover:bg-danger/10"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            disabled={remove.isPending}
                            onClick={() => setDeletingId(null)}
                            className="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-subtle"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeletingId(entry.id)}
                          className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-subtle hover:text-danger"
                          title="Delete entry"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
