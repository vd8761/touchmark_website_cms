import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { FieldInput } from '../components/FieldInput';
import { Button, Card, ErrorState, Field, Input, Pill, Skeleton } from '../components/primitives';
import {
  STATUS_LABEL,
  STATUS_TONE,
  type ContentTypeDto,
  type EntryDto,
  type VersionDto,
} from '../lib/content-types';
import { useSession } from '../lib/session';

/**
 * The entry editor of §17.5 — schema-driven form, status rail, version history.
 *
 * The form is generated entirely from the content type's fields, so a new field
 * type needs a branch in FieldInput and nothing here.
 */
export function EntryEditor() {
  const { typeApiId, entryId } = useParams();
  const { currentWorkspace, currentOrg, can } = useSession();
  const queryClient = useQueryClient();

  const ws = currentWorkspace?.id;
  const entryPath = `/admin/v1/workspaces/${ws}/content/entries/${entryId}`;

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  // Held separately from `draft`: the slug is a property of the entry, not one
  // of its field values, and the API takes it as its own key. `null` means
  // "untouched" — the server then keeps deriving it from the title, which is
  // what you want until someone deliberately overrides it.
  const [slugDraft, setSlugDraft] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [showVersions, setShowVersions] = useState(false);

  const typesQuery = useQuery({
    queryKey: ['content-types', ws],
    queryFn: () => api.list<ContentTypeDto>(`/admin/v1/workspaces/${ws}/content-types`),
    enabled: Boolean(ws),
  });

  const entryQuery = useQuery({
    queryKey: ['entry', entryId],
    queryFn: () => api.get<EntryDto>(entryPath),
    enabled: Boolean(ws && entryId),
  });

  const versionsQuery = useQuery({
    queryKey: ['entry-versions', entryId],
    queryFn: () => api.list<VersionDto>(`${entryPath}/versions`),
    enabled: showVersions && Boolean(entryId),
  });

  const entry = entryQuery.data;
  const type = typesQuery.data?.items.find((t) => t.api_id === (entry?.type ?? typeApiId));

  // Reset the working copy whenever the server's version changes — after a
  // save, a publish, or a restore.
  useEffect(() => {
    if (!entry) return;
    setDraft(entry.data ?? {});
    setSlugDraft(null);
    setDirty(false);
  }, [entry?.id, entry?.current_version]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<EntryDto>(entryPath, {
        data: draft,
        // Only sent when edited, so an untouched slug keeps auto-deriving from
        // the title instead of being pinned to its placeholder.
        ...(slugDraft === null ? {} : { slug: slugDraft }),
        // Optimistic concurrency: a second editor's save turns this into a 409
        // rather than silently discarding their work.
        expected_version: entry?.current_version,
      }),
    onSuccess: (updated) => {
      setFieldErrors({});
      setActionError(null);
      queryClient.setQueryData(['entry', entryId], updated);
      void queryClient.invalidateQueries({ queryKey: ['entries', ws] });
    },
    onError: (error) => handleError(error as ApiError),
  });

  const publish = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<EntryDto>(`${entryPath}/publish`, body),
    onSuccess: (updated) => {
      setFieldErrors({});
      setActionError(null);
      queryClient.setQueryData(['entry', entryId], updated);
      void queryClient.invalidateQueries({ queryKey: ['entries', ws] });
    },
    onError: (error) => handleError(error as ApiError),
  });

  const unpublish = useMutation({
    mutationFn: () => api.post<EntryDto>(`${entryPath}/unpublish`),
    onSuccess: (updated) => queryClient.setQueryData(['entry', entryId], updated),
    onError: (error) => handleError(error as ApiError),
  });

  const restore = useMutation({
    mutationFn: (version: number) => api.post<EntryDto>(`${entryPath}/versions/restore`, { version }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['entry', entryId], updated);
      void queryClient.invalidateQueries({ queryKey: ['entry-versions', entryId] });
    },
    onError: (error) => handleError(error as ApiError),
  });

  function handleError(error: ApiError) {
    if (error.fields?.length) {
      setFieldErrors(Object.fromEntries(error.fields.map((f) => [f.field, f.message])));
      setActionError(error);
    } else {
      setFieldErrors({});
      setActionError(error);
    }
  }

  // ⌘S saves — §17.5's keyboard map.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        if (dirty) save.mutate();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dirty, save]);

  const visibleFields = useMemo(
    () => (type?.fields ?? []).filter((field) => !field.deprecated),
    [type],
  );

  if (entryQuery.isLoading || typesQuery.isLoading) return <Skeleton rows={8} />;

  if (entryQuery.error) {
    const apiError = entryQuery.error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load this entry"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void entryQuery.refetch()}
      />
    );
  }

  if (!entry || !type) return null;

  const listPath = `/o/${currentOrg?.slug}/s/${currentWorkspace?.slug}/content/${type.api_id}`;
  const canPublish = can('content.publish');

  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-24">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to={listPath} className="text-sm text-text-secondary hover:text-text">
            ← {type.name}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">
              {slugDraft !== null
                ? `/${slugDraft}`
                : entry.slug
                  ? `/${entry.slug}`
                  : 'Untitled entry'}
            </h1>
            <Pill tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Pill>
            {entry.has_unpublished_changes && <Pill tone="warning">Unpublished changes</Pill>}
            {entry.is_incomplete && <Pill tone="danger">Incomplete</Pill>}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Version {entry.current_version}
            {entry.published_version ? ` · live: v${entry.published_version}` : ''} · updated{' '}
            {new Date(entry.updated_at).toLocaleString()}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setShowVersions((v) => !v)}>
            History
          </Button>
          <Button variant="secondary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            {dirty ? 'Save' : 'Saved'}
          </Button>
          {canPublish &&
            (entry.status === 'published' ? (
              <Button variant="ghost" loading={unpublish.isPending} onClick={() => unpublish.mutate()}>
                Unpublish
              </Button>
            ) : null)}
          {canPublish && (
            <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate({})}>
              {entry.has_unpublished_changes ? 'Publish changes' : 'Publish'}
            </Button>
          )}
        </div>
      </header>

      {entry.is_incomplete && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          A required field was added to this type after this entry was last saved. Fill it in to
          publish again — the currently live version is unaffected.
        </div>
      )}

      {actionError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{actionError.message}</p>
          {actionError.detail && (
            <p className="mt-1 text-xs text-text-secondary">{actionError.detail}</p>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <Card className="space-y-5">
          {visibleFields.length === 0 ? (
            <p className="text-sm text-text-secondary">
              This content type has no fields yet. Add some in Content types, and they appear here
              immediately.
            </p>
          ) : (
            visibleFields.map((field) => (
              <FieldInput
                key={field.id}
                field={field}
                value={draft[field.api_id]}
                error={fieldErrors[field.api_id]}
                onChange={(value) => {
                  setDraft((current) => ({ ...current, [field.api_id]: value }));
                  setDirty(true);
                }}
              />
            ))
          )}
        </Card>

        <div className="space-y-4">
          {/* §17.5 treats the slug as editable. Until it is published the server
              keeps deriving it from the title, so an entry saved with a title
              stops being `/untitled` on its own — but a derived slug is a guess,
              and the URL is the one thing you cannot fix after the fact. */}
          {type.has_slug && (
            <Card className="space-y-2">
              <h2 className="text-sm font-semibold text-text">URL slug</h2>
              <Field
                label="Slug"
                hint={
                  entry.status === 'published'
                    ? 'This entry is live. Changing the slug changes its public URL.'
                    : 'Left alone, this follows the title until the entry is first published.'
                }
                error={fieldErrors.slug}
              >
                <Input
                  value={slugDraft ?? entry.slug ?? ''}
                  placeholder="derived-from-the-title"
                  onChange={(event) => {
                    setSlugDraft(event.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              {slugDraft !== null && (
                <button
                  type="button"
                  onClick={() => setSlugDraft(null)}
                  className="text-xs text-accent hover:underline"
                >
                  Go back to deriving it from the title
                </button>
              )}
            </Card>
          )}

          {canPublish && type.enable_scheduling && entry.status !== 'published' && (
            <Card className="space-y-3">
              <h2 className="text-sm font-semibold text-text">Schedule</h2>
              <Field label="Publish at" hint={`Times are in ${currentWorkspace?.timezone}.`}>
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                />
              </Field>
              <Button
                variant="secondary"
                disabled={!scheduleAt}
                loading={publish.isPending}
                onClick={() =>
                  publish.mutate({ scheduled_at: new Date(scheduleAt).toISOString() })
                }
                className="w-full"
              >
                Schedule
              </Button>
              {entry.scheduled_at && (
                <p className="text-xs text-text-secondary">
                  Scheduled for {new Date(entry.scheduled_at).toLocaleString()}.
                </p>
              )}
            </Card>
          )}

          <Card className="space-y-2">
            <h2 className="text-sm font-semibold text-text">API</h2>
            <p className="break-all font-mono text-xs text-text-secondary">
              GET /v1/content/{type.api_id}/{entry.slug ?? '—'}
            </p>
            <p className="text-xs text-text-secondary">Schema version {entry.schema_version}</p>
          </Card>

          {showVersions && (
            <Card className="space-y-2">
              <h2 className="text-sm font-semibold text-text">Version history</h2>
              {versionsQuery.isLoading ? (
                <Skeleton rows={3} />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(versionsQuery.data?.items ?? []).map((version) => (
                    <li key={version.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-text">
                          v{version.version}
                          {version.was_published && <Pill tone="success">published</Pill>}
                        </p>
                        <p className="truncate text-xs text-text-secondary">
                          {version.change_note ?? new Date(version.created_at).toLocaleString()}
                        </p>
                      </div>
                      {version.version !== entry.current_version && (
                        <button
                          type="button"
                          onClick={() => restore.mutate(version.version)}
                          className="shrink-0 text-xs text-accent hover:underline"
                        >
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-text-secondary">
                Restoring appends a new version rather than rewinding, so nothing is lost.
              </p>
            </Card>
          )}
        </div>
      </div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface-raised px-6 py-3">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <p className="text-sm text-text-secondary">Unsaved changes · ⌘S to save</p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(entry.data ?? {});
                  setSlugDraft(null);
                  setDirty(false);
                  setFieldErrors({});
                }}
              >
                Discard
              </Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
