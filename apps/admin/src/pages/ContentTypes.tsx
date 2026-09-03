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
  Pill,
  Skeleton,
} from '../components/primitives';
import { FieldForm } from '../components/FieldForm';
import { type ContentTypeDto, type FieldDto } from '../lib/content-types';
import { useSession } from '../lib/session';

/**
 * The content type builder — §7.1 and §17.6.
 *
 * Every guardrail the API enforces is surfaced here *before* the action, not
 * as an error afterwards: immutable API IDs are shown as locked, deletion runs
 * an impact check first, and adding a required field warns how many entries it
 * will mark incomplete.
 */
export function ContentTypes() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const ws = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${ws}/content-types`;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['content-types', ws],
    queryFn: () => api.list<ContentTypeDto>(base),
    enabled: Boolean(ws),
  });

  const manageable = can('contenttype.manage');
  const types = data?.items ?? [];
  const selected = types.find((t) => t.id === selectedId) ?? null;

  if (isLoading) return <Skeleton rows={5} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load content types"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Content types</h1>
          <p className="mt-1 text-sm text-text-secondary">
            The shape of your content. Define types and fields here; entries follow them
            everywhere else.
          </p>
        </div>
        {manageable && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            ＋ New content type
          </Button>
        )}
      </header>

      {creating && (
        <CreateType
          base={base}
          onCancel={() => setCreating(false)}
          onCreated={(type) => {
            setCreating(false);
            setSelectedId(type.id);
            void queryClient.invalidateQueries({ queryKey: ['content-types', ws] });
          }}
        />
      )}

      {types.length === 0 && !creating ? (
        <EmptyState
          title="No content types yet"
          description="A content type is a schema — Blog Post, Case Study, Author. Create one and its entries become available through the API immediately."
          action={
            manageable && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first type
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <ul className="space-y-2">
            {types.map((type) => (
              <li key={type.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(type.id)}
                  className={`w-full rounded-xl border p-4 text-left ${
                    type.id === selectedId
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-surface hover:bg-surface-subtle'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">{type.name}</span>
                    <Pill tone={type.kind === 'single' ? 'accent' : 'neutral'}>{type.kind}</Pill>
                  </div>
                  <p className="mt-1 font-mono text-xs text-text-secondary">{type.api_id}</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {type.fields.filter((f) => !f.deprecated).length} fields ·{' '}
                    {type.entry_count ?? 0} entries · schema v{type.schema_version}
                  </p>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <TypeEditor
              key={selected.id}
              type={selected}
              allTypes={types}
              base={base}
              editable={manageable}
              onChanged={() => queryClient.invalidateQueries({ queryKey: ['content-types', ws] })}
              onDeleted={() => {
                setSelectedId(null);
                void queryClient.invalidateQueries({ queryKey: ['content-types', ws] });
              }}
            />
          ) : (
            <Card>
              <p className="text-sm text-text-secondary">
                Select a content type to see and edit its fields.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function CreateType({
  base,
  onCancel,
  onCreated,
}: {
  base: string;
  onCancel: () => void;
  onCreated: (type: ContentTypeDto) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'collection' | 'single'>('collection');

  const create = useMutation({
    mutationFn: () => api.post<ContentTypeDto>(base, { name, kind }),
    onSuccess: onCreated,
  });

  const error = create.error as ApiError | null;
  const previewApiId = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return (
    <Card className="space-y-4 border-accent">
      <h2 className="font-semibold text-text">New content type</h2>

      <Field
        label="Name"
        hint={
          previewApiId
            ? `API ID will be "${previewApiId}" — permanent, and used in every API URL.`
            : 'The API ID is derived from this and cannot be changed later.'
        }
      >
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Blog Post" autoFocus />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">Kind</legend>
        {(
          [
            ['collection', 'Collection', 'Many entries — blog posts, case studies, authors'],
            ['single', 'Single', 'Exactly one entry — a homepage, an about page'],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              kind === value ? 'border-accent bg-accent/5' : 'border-border'
            }`}
          >
            <input
              type="radio"
              checked={kind === value}
              onChange={() => setKind(value)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-text">{label}</span>
              <span className="block text-xs text-text-secondary">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

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
          Create type
        </Button>
      </div>
    </Card>
  );
}

function TypeEditor({
  type,
  allTypes,
  base,
  editable,
  onChanged,
  onDeleted,
}: {
  type: ContentTypeDto;
  allTypes: ContentTypeDto[];
  base: string;
  editable: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [addingField, setAddingField] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const deprecate = useMutation({
    mutationFn: (fieldId: string) => api.post(`${base}/${type.id}/fields/${fieldId}/deprecate`),
    onSuccess: onChanged,
    onError: (e) => setActionError(e as ApiError),
  });

  const removeField = useMutation({
    mutationFn: (fieldId: string) => api.delete(`${base}/${type.id}/fields/${fieldId}`),
    onSuccess: onChanged,
    onError: (e) => setActionError(e as ApiError),
  });

  const removeType = useMutation({
    mutationFn: () =>
      api.delete(`${base}/${type.id}`, { delete_entries: true, confirm_name: confirmName }),
    onSuccess: onDeleted,
    onError: (e) => setActionError(e as ApiError),
  });

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text">{type.name}</h2>
            <p className="font-mono text-xs text-text-secondary">
              GET /v1/content/{type.api_id}
            </p>
          </div>
          <Pill tone="neutral">schema v{type.schema_version}</Pill>
        </div>

        <p className="text-xs text-text-secondary">
          The API ID is fixed at creation. Renaming it would break every site reading this type.
        </p>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Fields</h3>
          {editable && (
            <Button variant="secondary" onClick={() => setAddingField(true)}>
              ＋ Add field
            </Button>
          )}
        </div>

        {type.fields.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No fields yet. Entries of this type have nothing to store until you add one.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {type.fields.map((field) =>
              editingFieldId === field.id ? (
                <li key={field.id} className="py-2.5">
                  <FieldForm
                    existing={field}
                    contentTypes={allTypes}
                    base={`${base}/${type.id}/fields`}
                    onCancel={() => setEditingFieldId(null)}
                    onSaved={() => {
                      setEditingFieldId(null);
                      onChanged();
                    }}
                  />
                </li>
              ) : (
                <li key={field.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-text">
                      {field.name}
                      {field.required && <Pill tone="warning">required</Pill>}
                      {field.unique_value && <Pill tone="neutral">unique</Pill>}
                      {field.localised && <Pill tone="neutral">translatable</Pill>}
                      {field.group && <Pill tone="neutral">{field.group}</Pill>}
                      {field.deprecated && <Pill tone="neutral">deprecated</Pill>}
                    </p>
                    <p className="font-mono text-xs text-text-secondary">
                      {field.api_id} · {field.type}
                      {/* Surfaced in the list because a rule you cannot see is a
                          rule you rediscover through a failed publish. */}
                      {summariseRules(field) && (
                        <span className="font-sans"> · {summariseRules(field)}</span>
                      )}
                    </p>
                  </div>

                  {editable && (
                    <div className="flex shrink-0 gap-3 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setAddingField(false);
                          setEditingFieldId(field.id);
                        }}
                        className="text-text-secondary hover:text-text"
                      >
                        Edit
                      </button>
                      {!field.deprecated && (
                        <button
                          type="button"
                          onClick={() => deprecate.mutate(field.id)}
                          className="text-text-secondary hover:text-text"
                          title="Hide from the editor but keep serving it through the API"
                        >
                          Deprecate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeField.mutate(field.id)}
                        className="text-danger hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}

        {addingField && (
          <FieldForm
            contentTypes={allTypes}
            base={`${base}/${type.id}/fields`}
            onCancel={() => setAddingField(false)}
            onSaved={() => {
              setAddingField(false);
              onChanged();
            }}
          />
        )}
      </Card>

      {actionError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-text">{actionError.message}</p>
          {actionError.detail && (
            <p className="mt-1 text-xs text-text-secondary">{actionError.detail}</p>
          )}
        </div>
      )}

      {editable && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 p-5">
          <h3 className="text-sm font-semibold text-danger">Delete this content type</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Deletes the type and all {type.entry_count ?? 0} of its entries. Any site reading{' '}
            <code className="font-mono">/v1/content/{type.api_id}</code> will start receiving 404s.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={`Type "${type.name}" to confirm`}
            />
            <Button
              variant="danger"
              disabled={confirmName !== type.name}
              loading={removeType.isPending}
              onClick={() => removeType.mutate()}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A one-line digest of a field's rules, for the list.
 *
 * Rules were previously invisible once set — you found out a field had a
 * 60-character limit when a publish failed. Only rules the API enforces appear
 * here, and the order is fixed so the same field always reads the same way.
 */
function summariseRules(field: FieldDto): string {
  const rules = (field.validation ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  if (rules.minLength !== undefined || rules.maxLength !== undefined) {
    parts.push(`${rules.minLength ?? 0}–${rules.maxLength ?? '∞'} chars`);
  }
  if (rules.min !== undefined || rules.max !== undefined) {
    parts.push(`${rules.min ?? '−∞'} to ${rules.max ?? '∞'}`);
  }
  if (rules.minItems !== undefined || rules.maxItems !== undefined) {
    parts.push(`${rules.minItems ?? 0}–${rules.maxItems ?? '∞'} items`);
  }
  if (rules.regex) parts.push('pattern');

  const options = field.config?.options?.length;
  if (options) parts.push(`${options} option${options === 1 ? '' : 's'}`);

  if (field.config?.relationTypeApiId) parts.push(`→ ${field.config.relationTypeApiId}`);

  return parts.join(' · ');
}
