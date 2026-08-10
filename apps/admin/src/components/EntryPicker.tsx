import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import {
  STATUS_LABEL,
  STATUS_TONE,
  entryTitle,
  type ContentTypeDto,
  type EntryDto,
} from '../lib/content-types';
import { Pill, cx } from './primitives';
import { useSession } from '../lib/session';

/**
 * Searchable picker for entry references (§17.5).
 *
 * Two things make this more than a text box. It shows each candidate's *status*,
 * because relating a published page to a draft is a mistake you want to catch
 * while choosing rather than after publishing. And it resolves ids that are
 * already stored back into titles, so an entry saved last month does not read as
 * a row of UUIDs.
 */
export function EntryPicker({
  value,
  multiple,
  typeApiId,
  disabled,
  onChange,
}: {
  /** An entry id, or a list of them when `multiple`. */
  value: string | string[] | null;
  multiple: boolean;
  /** Which content type to search. When absent, the picker cannot know. */
  typeApiId: string | undefined;
  disabled?: boolean;
  onChange: (value: string | string[] | null) => void;
}) {
  const { currentWorkspace } = useSession();
  const workspaceId = currentWorkspace?.id;

  const selectedIds = useMemo(
    () => (multiple ? ((value as string[] | null) ?? []) : value ? [value as string] : []),
    [multiple, value],
  );

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced so typing does not fire a request per keystroke.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const { data: type } = useQuery({
    queryKey: ['content-type', workspaceId, typeApiId],
    queryFn: () =>
      api.get<ContentTypeDto>(`/admin/v1/workspaces/${workspaceId}/content-types/${typeApiId}`),
    enabled: Boolean(workspaceId && typeApiId),
  });

  const { data: results, isFetching } = useQuery({
    queryKey: ['entry-picker', workspaceId, typeApiId, debounced],
    queryFn: () =>
      api.list<EntryDto>(
        `/admin/v1/workspaces/${workspaceId}/content/${typeApiId}?limit=10` +
          (debounced ? `&search=${encodeURIComponent(debounced)}` : ''),
      ),
    enabled: Boolean(workspaceId && typeApiId && open),
  });

  // Stored ids are resolved individually: a saved reference may not be in the
  // first ten search results, and showing a bare id would be worse than a fetch.
  const { data: selectedEntries } = useQuery({
    queryKey: ['entry-picker-selected', workspaceId, selectedIds],
    queryFn: async () =>
      Promise.all(
        selectedIds.map((id) =>
          api
            .get<EntryDto>(`/admin/v1/workspaces/${workspaceId}/content/entries/${id}`)
            .catch(() => null),
        ),
      ),
    enabled: Boolean(workspaceId) && selectedIds.length > 0,
  });

  if (!typeApiId) {
    return (
      <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-text">
        This field does not say which content type it links to. Set it in the content type builder
        and the picker will appear here.
      </p>
    );
  }

  const fields = type?.fields ?? [];
  const options = (results?.items ?? []).filter((entry) => !selectedIds.includes(entry.id));

  function select(entry: EntryDto) {
    if (multiple) {
      onChange([...selectedIds, entry.id]);
    } else {
      onChange(entry.id);
      setOpen(false);
    }
    setQuery('');
  }

  function remove(id: string) {
    if (multiple) {
      const next = selectedIds.filter((selected) => selected !== id);
      onChange(next.length ? next : []);
    } else {
      onChange(null);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlighted((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && open && options[highlighted]) {
      event.preventDefault();
      select(options[highlighted]);
      setHighlighted(0);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Backspace' && !query && selectedIds.length > 0) {
      remove(selectedIds[selectedIds.length - 1]);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {selectedIds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedIds.map((id, index) => {
            const entry = selectedEntries?.[index] ?? null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-subtle py-1 pl-2 pr-1 text-sm"
              >
                <span className="text-text">
                  {entry ? (
                    entryTitle(entry, fields)
                  ) : (
                    // A reference whose target was deleted must not look normal.
                    <span className="text-danger" title={id}>
                      Missing entry
                    </span>
                  )}
                </span>
                {entry && (
                  <Pill tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Pill>
                )}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(id)}
                    aria-label="Remove"
                    className="rounded px-1 text-text-secondary hover:text-danger"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {(multiple || selectedIds.length === 0) && !disabled && (
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls="entry-picker-list"
          placeholder={`Search ${type?.name?.toLowerCase() ?? 'entries'}…`}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-text-secondary focus:border-accent"
        />
      )}

      {open && !disabled && (
        <div
          id="entry-picker-list"
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-surface-raised shadow-lg"
        >
          {isFetching && options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text-secondary">Searching…</p>
          ) : options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text-secondary">
              {debounced ? 'Nothing matches that.' : 'No entries of this type yet.'}
            </p>
          ) : (
            options.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => select(entry)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left',
                  index === highlighted ? 'bg-surface-subtle' : '',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text">
                    {entryTitle(entry, fields)}
                  </span>
                  {entry.slug && (
                    <span className="block truncate font-mono text-xs text-text-secondary">
                      /{entry.slug}
                    </span>
                  )}
                </span>
                <Pill tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Pill>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
