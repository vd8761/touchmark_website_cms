import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, Card, EmptyState, ErrorState, Field, Input, Pill, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

interface TaxonomyDto {
  id: string;
  name: string;
  api_id: string;
  description: string | null;
  is_hierarchical: boolean;
  term_count: number;
}

interface TermDto {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  entry_count: number;
  children: TermDto[];
}

/** Taxonomies and their term manager (§17.8). */
export function Taxonomies() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const ws = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${ws}/taxonomies`;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['taxonomies', ws],
    queryFn: () => api.list<TaxonomyDto>(base),
    enabled: Boolean(ws),
  });

  const manageable = can('taxonomy.manage');

  if (isLoading) return <Skeleton rows={5} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load taxonomies"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const taxonomies = data?.items ?? [];
  const selected = taxonomies.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Taxonomies</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Ways to classify content — categories, tags, topics. Terms are shared across every
            content type the taxonomy applies to.
          </p>
        </div>
        {manageable && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            ＋ New taxonomy
          </Button>
        )}
      </header>

      {creating && (
        <CreateTaxonomy
          base={base}
          onCancel={() => setCreating(false)}
          onCreated={(taxonomy) => {
            setCreating(false);
            setSelectedId(taxonomy.id);
            void queryClient.invalidateQueries({ queryKey: ['taxonomies', ws] });
          }}
        />
      )}

      {taxonomies.length === 0 && !creating ? (
        <EmptyState
          title="No taxonomies yet"
          description="Create one to group entries — a flat Tag list, or a hierarchical Category tree."
          action={
            manageable && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create a taxonomy
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <ul className="space-y-2">
            {taxonomies.map((taxonomy) => (
              <li key={taxonomy.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(taxonomy.id)}
                  className={`w-full rounded-xl border p-4 text-left ${
                    taxonomy.id === selectedId
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-surface hover:bg-surface-subtle'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">{taxonomy.name}</span>
                    {taxonomy.is_hierarchical && <Pill tone="accent">tree</Pill>}
                  </div>
                  <p className="mt-1 font-mono text-xs text-text-secondary">{taxonomy.api_id}</p>
                  <p className="mt-1 text-xs text-text-secondary">{taxonomy.term_count} terms</p>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <TermManager key={selected.id} taxonomy={selected} base={base} editable={manageable} />
          ) : (
            <Card>
              <p className="text-sm text-text-secondary">Select a taxonomy to manage its terms.</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function CreateTaxonomy({
  base,
  onCancel,
  onCreated,
}: {
  base: string;
  onCancel: () => void;
  onCreated: (taxonomy: TaxonomyDto) => void;
}) {
  const [name, setName] = useState('');
  const [hierarchical, setHierarchical] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post<TaxonomyDto>(base, { name, is_hierarchical: hierarchical }),
    onSuccess: onCreated,
  });

  const error = create.error as ApiError | null;

  return (
    <Card className="space-y-4 border-accent">
      <h2 className="font-semibold text-text">New taxonomy</h2>

      <Field label="Name" hint="The API ID is derived from this and is permanent.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Category" autoFocus />
      </Field>

      <label className="flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={hierarchical}
          onChange={(e) => setHierarchical(e.target.checked)}
          className="mt-1"
        />
        <span>
          Hierarchical
          <span className="block text-xs text-text-secondary">
            Terms can nest under one another — Engineering › Databases. Leave off for flat tags.
          </span>
        </span>
      </label>

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
        <Button variant="primary" loading={create.isPending} disabled={!name} onClick={() => create.mutate()}>
          Create
        </Button>
      </div>
    </Card>
  );
}

function TermManager({
  taxonomy,
  base,
  editable,
}: {
  taxonomy: TaxonomyDto;
  base: string;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const [error, setError] = useState<ApiError | null>(null);

  const termsQuery = useQuery({
    queryKey: ['terms', taxonomy.id],
    queryFn: () => api.list<TermDto>(`${base}/${taxonomy.id}/terms`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post(`${base}/${taxonomy.id}/terms`, {
        name,
        ...(parentId ? { parent_id: parentId } : {}),
      }),
    onSuccess: () => {
      setName('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['terms', taxonomy.id] });
      void queryClient.invalidateQueries({ queryKey: ['taxonomies'] });
    },
    onError: (e) => setError(e as ApiError),
  });

  const remove = useMutation({
    mutationFn: (termId: string) =>
      api.delete(base.replace('/taxonomies', '/terms') + `/${termId}`),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['terms', taxonomy.id] });
      void queryClient.invalidateQueries({ queryKey: ['taxonomies'] });
    },
    onError: (e) => setError(e as ApiError),
  });

  const terms = termsQuery.data?.items ?? [];

  // Flattened for the parent dropdown, with depth shown by indentation.
  const flat: { id: string; label: string }[] = [];
  const walk = (nodes: TermDto[], depth: number) => {
    for (const node of nodes) {
      flat.push({ id: node.id, label: `${'— '.repeat(depth)}${node.name}` });
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(terms, 0);

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-lg font-semibold text-text">{taxonomy.name}</h2>
        <p className="font-mono text-xs text-text-secondary">
          GET /v1/taxonomies/{taxonomy.api_id}/terms
        </p>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text">Terms</h3>

        {termsQuery.isLoading ? (
          <Skeleton rows={3} />
        ) : terms.length === 0 ? (
          <p className="text-sm text-text-secondary">No terms yet.</p>
        ) : (
          <TermTree terms={terms} depth={0} editable={editable} onDelete={(id) => remove.mutate(id)} />
        )}

        {editable && (
          <div className="space-y-2 rounded-lg bg-surface-subtle p-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New term name"
                className="max-w-xs"
              />
              {taxonomy.is_hierarchical && flat.length > 0 && (
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  <option value="">Top level</option>
                  {flat.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="secondary"
                loading={create.isPending}
                disabled={!name}
                onClick={() => create.mutate()}
              >
                Add term
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
            <p className="text-sm text-text">{error.message}</p>
            {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

function TermTree({
  terms,
  depth,
  editable,
  onDelete,
}: {
  terms: TermDto[];
  depth: number;
  editable: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <ul className={depth > 0 ? 'ml-5 border-l border-border pl-3' : ''}>
      {terms.map((term) => (
        <li key={term.id}>
          <div className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-text">{term.name}</p>
              <p className="font-mono text-xs text-text-secondary">
                /{term.slug}
                {term.entry_count > 0 && ` · ${term.entry_count} entries`}
              </p>
            </div>
            {editable && (
              <button
                type="button"
                onClick={() => onDelete(term.id)}
                className="shrink-0 text-xs text-danger hover:underline"
              >
                Delete
              </button>
            )}
          </div>
          {term.children?.length > 0 && (
            <TermTree terms={term.children} depth={depth + 1} editable={editable} onDelete={onDelete} />
          )}
        </li>
      ))}
    </ul>
  );
}
