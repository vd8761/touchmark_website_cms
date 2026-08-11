import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import { Button, EmptyState, ErrorState, Field, Input, Skeleton } from '../components/primitives';
import { useSession } from '../lib/session';

export interface MediaAssetDto {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  caption: string | null;
  credit: string | null;
  tags: string[];
  folder_id: string | null;
  url?: string;
  usage_count?: number;
  uploaded_at: string | null;
}

interface UsageDto {
  entry_id: string;
  field_api_id: string;
  slug: string | null;
  content_type: string;
}

/**
 * The media library (§17.7).
 *
 * Uploads go direct to storage: the browser asks for a presigned URL, PUTs the
 * file to it, then confirms. File bytes never pass through the API.
 */
export function MediaLibrary() {
  const { currentWorkspace, can } = useSession();
  const queryClient = useQueryClient();
  const ws = currentWorkspace?.id;
  const base = `/admin/v1/workspaces/${ws}/media`;

  const [selected, setSelected] = useState<MediaAssetDto | null>(null);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['media', ws, unusedOnly, search],
    queryFn: () =>
      api.list<MediaAssetDto>(
        `${base}?${new URLSearchParams({
          ...(unusedOnly ? { unused: 'true' } : {}),
          ...(search ? { search } : {}),
        })}`,
      ),
    enabled: Boolean(ws),
  });

  const canUpload = can('media.upload');

  if (isLoading) return <Skeleton rows={6} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load the media library"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const assets = data?.items ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Media</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {data?.meta.total ?? 0} file{(data?.meta.total ?? 0) === 1 ? '' : 's'}
          </p>
        </div>
        {canUpload && (
          <Uploader
            base={base}
            onUploaded={() => {
              void queryClient.invalidateQueries({ queryKey: ['media', ws] });
              void queryClient.invalidateQueries({ queryKey: ['media-picker', ws] });
            }}
          />
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search filenames…"
          className="max-w-xs"
        />
        <button
          type="button"
          onClick={() => setUnusedOnly((value) => !value)}
          className={`rounded-full border px-3 py-1 text-sm ${
            unusedOnly
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-text-secondary hover:bg-surface-subtle'
          }`}
        >
          Unused only
        </button>
      </div>

      {assets.length === 0 ? (
        <EmptyState
          title={search || unusedOnly ? 'No files match' : 'No media yet'}
          description={
            search || unusedOnly
              ? 'Try a different search, or clear the filter.'
              : 'Upload images, video or documents here, then reference them from your content.'
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelected(asset)}
              className="group overflow-hidden rounded-xl border border-border bg-surface text-left hover:border-accent"
            >
              <div className="grid aspect-square place-items-center bg-surface-subtle">
                {asset.mime_type.startsWith('image/') && asset.url ? (
                  <img
                    src={asset.url}
                    alt={asset.alt_text ?? ''}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-xs uppercase text-text-secondary">
                    {asset.mime_type.split('/')[1] ?? 'file'}
                  </span>
                )}
              </div>
              <div className="p-2">
                <p className="truncate text-xs text-text">{asset.filename}</p>
                <p className="text-[10px] text-text-secondary">
                  {asset.width ? `${asset.width}×${asset.height} · ` : ''}
                  {formatBytes(asset.size_bytes)}
                </p>
                {/* Missing alt text is a real accessibility problem, so it is
                    surfaced in the grid rather than hidden in a detail panel. */}
                {asset.mime_type.startsWith('image/') && !asset.alt_text && (
                  <p className="mt-0.5 text-[10px] text-warning">No alt text</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <AssetDrawer
          asset={selected}
          base={base}
          editable={canUpload}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ['media', ws] });
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The three-step upload, done in the browser:
 *   1. ask the API to reserve an asset and presign a URL
 *   2. PUT the bytes straight to storage
 *   3. tell the API it finished, so it can verify what landed
 */
export function Uploader({
  base,
  label = '⬆ Upload',
  multiple = true,
  onUploaded,
}: {
  base: string;
  label?: string;
  multiple?: boolean;
  /** The assets that completed, so a caller can select what was just uploaded. */
  onUploaded: (assetIds: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);

    const completed: string[] = [];

    try {
      for (const file of Array.from(files)) {
        const reserved = await api.post<{
          asset_id: string;
          upload_url: string;
          method: string;
          headers: Record<string, string>;
        }>(`${base}/upload-url`, {
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        });

        const uploaded = await fetch(reserved.upload_url, {
          method: reserved.method,
          headers: reserved.headers,
          body: file,
        });

        if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status}).`);

        await api.post(`${base}/${reserved.asset_id}/complete`);
        completed.push(reserved.asset_id);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : String(caught));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
      // Reported even when a later file failed: the ones that did land are
      // already in the library, and hiding them would look like data loss.
      if (completed.length > 0) onUploaded(completed);
    }
  }

  return (
    <div className="text-right">
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <Button variant="primary" loading={busy} onClick={() => inputRef.current?.click()}>
        {label}
      </Button>
      {error && <p className="mt-1 max-w-xs text-xs text-danger">{error}</p>}
    </div>
  );
}

function AssetDrawer({
  asset,
  base,
  editable,
  onClose,
  onChanged,
}: {
  asset: MediaAssetDto;
  base: string;
  editable: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    alt_text: asset.alt_text ?? '',
    caption: asset.caption ?? '',
    credit: asset.credit ?? '',
  });
  const [error, setError] = useState<ApiError | null>(null);

  const usages = useQuery({
    queryKey: ['media-usages', asset.id],
    queryFn: () => api.list<UsageDto>(`${base}/${asset.id}/usages`),
  });

  const save = useMutation({
    mutationFn: () => api.patch(`${base}/${asset.id}`, form),
    onSuccess: onChanged,
    onError: (e) => setError(e as ApiError),
  });

  const remove = useMutation({
    mutationFn: (force: boolean) => api.delete(`${base}/${asset.id}${force ? '?force=true' : ''}`),
    onSuccess: onChanged,
    onError: (e) => setError(e as ApiError),
  });

  const usageList = usages.data?.items ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-surface p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="truncate text-lg font-semibold text-text">{asset.filename}</h2>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text">
            ✕
          </button>
        </div>

        {asset.mime_type.startsWith('image/') && asset.url && (
          <img
            src={asset.url}
            alt={asset.alt_text ?? ''}
            className="mt-4 w-full rounded-lg border border-border"
          />
        )}

        <dl className="mt-4 space-y-1 text-xs text-text-secondary">
          <div className="flex justify-between">
            <dt>Type</dt>
            <dd className="font-mono">{asset.mime_type}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Size</dt>
            <dd>{formatBytes(asset.size_bytes)}</dd>
          </div>
          {asset.width && (
            <div className="flex justify-between">
              <dt>Dimensions</dt>
              <dd>
                {asset.width} × {asset.height}
              </dd>
            </div>
          )}
        </dl>

        {asset.url && (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">URL</p>
            <div className="mt-1 flex gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg border border-border bg-surface-subtle px-2 py-1.5 text-xs">
                {asset.url}
              </code>
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(asset.url!)}
              >
                Copy
              </Button>
            </div>
          </div>
        )}

        <div className="mt-5 space-y-3">
          <Field
            label="Alt text"
            hint="Describes the image for screen readers and when it fails to load."
          >
            <Input
              value={form.alt_text}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, alt_text: event.target.value })}
            />
          </Field>
          <Field label="Caption">
            <Input
              value={form.caption}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, caption: event.target.value })}
            />
          </Field>
          <Field label="Credit">
            <Input
              value={form.credit}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, credit: event.target.value })}
            />
          </Field>
          {editable && (
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </div>

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-text">
            Used in {usageList.length} place{usageList.length === 1 ? '' : 's'}
          </h3>
          {usageList.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-text-secondary">
              {usageList.map((usage) => (
                <li key={`${usage.entry_id}-${usage.field_api_id}`}>
                  {usage.content_type}
                  {usage.slug ? ` /${usage.slug}` : ''} ·{' '}
                  <span className="font-mono">{usage.field_api_id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3">
            <p className="text-sm text-text">{error.message}</p>
            {error.detail && <p className="mt-1 text-xs text-text-secondary">{error.detail}</p>}
          </div>
        )}

        {editable && (
          <div className="mt-6 border-t border-border pt-4">
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(usageList.length > 0)}
            >
              {usageList.length > 0 ? 'Delete anyway' : 'Delete'}
            </Button>
            {usageList.length > 0 && (
              <p className="mt-1 text-xs text-text-secondary">
                This will leave broken references in {usageList.length} entr
                {usageList.length === 1 ? 'y' : 'ies'}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
