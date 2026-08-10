import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Skeleton, cx } from './primitives';
import { formatBytes, type MediaAssetDto } from '../pages/MediaLibrary';

/**
 * Picker for `media` and `media_list` fields (§17.5: "Media fields show a
 * thumbnail with Replace/Remove and open the media library in a picker modal").
 *
 * Values are asset ids, exactly as the API stores them — the picker only
 * changes how they are chosen.
 */
export function MediaPicker({
  value,
  multiple,
  onChange,
  onClose,
}: {
  value: string[];
  multiple: boolean;
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { currentWorkspace } = useSession();
  const base = `/admin/v1/workspaces/${currentWorkspace?.id}/media`;

  const { data, isLoading } = useQuery({
    queryKey: ['media-picker', currentWorkspace?.id],
    queryFn: () => api.list<MediaAssetDto>(`${base}?limit=100`),
    enabled: Boolean(currentWorkspace?.id),
  });

  function toggle(assetId: string) {
    if (!multiple) {
      onChange([assetId]);
      onClose();
      return;
    }
    onChange(value.includes(assetId) ? value.filter((id) => id !== assetId) : [...value, assetId]);
  }

  const assets = data?.items ?? [];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-surface p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Choose media</h2>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text">
            ✕
          </button>
        </div>

        {isLoading ? (
          <div className="mt-4">
            <Skeleton rows={4} />
          </div>
        ) : assets.length === 0 ? (
          <p className="mt-6 text-sm text-text-secondary">
            No media yet. Upload files from the Media page first.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
            {assets.map((asset) => {
              const chosen = value.includes(asset.id);
              return (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => toggle(asset.id)}
                  className={cx(
                    'overflow-hidden rounded-lg border text-left',
                    chosen ? 'border-accent ring-2 ring-accent' : 'border-border hover:border-accent',
                  )}
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
                      <span className="text-[10px] uppercase text-text-secondary">
                        {asset.mime_type.split('/')[1] ?? 'file'}
                      </span>
                    )}
                  </div>
                  <p className="truncate p-1.5 text-[11px] text-text">{asset.filename}</p>
                </button>
              );
            })}
          </div>
        )}

        {multiple && (
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done ({value.length} selected)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Thumbnails for the ids currently held by a media field. */
export function MediaThumbnails({
  ids,
  onRemove,
}: {
  ids: string[];
  onRemove: (id: string) => void;
}) {
  const { currentWorkspace } = useSession();
  const base = `/admin/v1/workspaces/${currentWorkspace?.id}/media`;

  const { data } = useQuery({
    queryKey: ['media-picker', currentWorkspace?.id],
    queryFn: () => api.list<MediaAssetDto>(`${base}?limit=100`),
    enabled: Boolean(currentWorkspace?.id) && ids.length > 0,
  });

  if (ids.length === 0) return null;

  const byId = new Map((data?.items ?? []).map((asset) => [asset.id, asset]));

  return (
    <ul className="flex flex-wrap gap-2">
      {ids.map((id) => {
        const asset = byId.get(id);
        return (
          <li
            key={id}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface p-1.5"
          >
            {asset?.mime_type.startsWith('image/') && asset.url ? (
              <img
                src={asset.url}
                alt={asset.alt_text ?? ''}
                className="h-10 w-10 rounded object-cover"
              />
            ) : (
              <span className="grid h-10 w-10 place-items-center rounded bg-surface-subtle text-[9px] uppercase text-text-secondary">
                {asset?.mime_type.split('/')[1] ?? '?'}
              </span>
            )}
            <span className="max-w-[10rem] truncate text-xs text-text">
              {/* An id with no asset behind it means the asset was deleted —
                  showing that is more useful than rendering a blank tile. */}
              {asset?.filename ?? 'Missing asset'}
              {asset && (
                <span className="block text-[10px] text-text-secondary">
                  {formatBytes(asset.size_bytes)}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onRemove(id)}
              className="px-1 text-text-secondary hover:text-danger"
              aria-label="Remove"
            >
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}
