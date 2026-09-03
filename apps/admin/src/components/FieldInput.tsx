import { lazy, Suspense, useMemo, useRef, useState } from 'react';

import type { FieldDto } from '../lib/content-types';
import { EntryPicker } from './EntryPicker';
import { MediaPicker, MediaThumbnails } from './MediaPicker';
import { Button, Field, Input, cx } from './primitives';
/**
 * Loaded on demand.
 *
 * TipTap and ProseMirror are ~430KB raw, and eagerly importing them put that in
 * the entry bundle every visitor downloads — including on the login screen, for
 * an editor most sessions never open. Split out, it arrives only when an entry
 * actually has a rich-text field.
 */
const RichTextEditor = lazy(() =>
  import('./rich-text/RichTextEditor').then((module) => ({ default: module.RichTextEditor })),
);

/** A value the block editor can open: a ProseMirror document, or nothing yet. */
function isRichTextDocument(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: string }).type === 'doc'
  );
}

/**
 * Renders one schema-defined field as an input (§17.5, centre column).
 *
 * The switch is on `field.type`, so adding a field type to the backend means
 * adding one branch here — there is no per-content-type UI code anywhere.
 */
export function FieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FieldDto;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = field.required ? `${field.name} *` : field.name;

  // A deprecated field is hidden from the editor but still served by the API
  // (§7.1), so it must not render an input at all.
  if (field.deprecated) return null;

  return (
    <Field label={label} hint={field.help_text ?? undefined} error={error}>
      {renderControl()}
    </Field>
  );

  function renderControl() {
    switch (field.type) {
      case 'long_text':
      case 'markdown':
      case 'code':
        return (
          <textarea
            value={asString(value)}
            disabled={disabled}
            rows={field.type === 'code' ? 10 : 5}
            onChange={(event) => onChange(event.target.value)}
            className={cx(
              'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text',
              field.type === 'code' && 'font-mono',
            )}
          />
        );

      case 'rich_text':
        // Structured JSON per Open Decision #3, now edited as blocks. The
        // stored shape is unchanged — the editor reads and writes the same
        // document the textarea did.
        //
        // A value that is not a `doc` can exist: the old textarea accepted any
        // JSON, and kept the raw string while you were mid-keystroke. Rather
        // than silently discarding that content by opening an empty editor, it
        // falls back to the raw view so it can be recovered.
        return isRichTextDocument(value) || value == null || value === '' ? (
          <Suspense
            fallback={
              <div className="min-h-[16rem] animate-pulse rounded-lg border border-border bg-surface-subtle" />
            }
          >
            <RichTextEditor value={value} disabled={disabled} onChange={onChange} />
          </Suspense>
        ) : (
          <div className="space-y-1">
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-text-secondary">
              This value is not a rich-text document, so the block editor cannot open it. Fix it
              here — or clear it — and the editor takes over.
            </p>
            <textarea
              value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
              disabled={disabled}
              rows={8}
              onChange={(event) => {
                try {
                  onChange(event.target.value ? JSON.parse(event.target.value) : null);
                } catch {
                  onChange(event.target.value);
                }
              }}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
              placeholder='{ "type": "doc", "content": [] }'
            />
          </div>
        );

      case 'number':
      case 'decimal':
        return (
          <Input
            type="number"
            step={field.type === 'decimal' ? 'any' : '1'}
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            onChange={(event) =>
              onChange(event.target.value === '' ? null : Number(event.target.value))
            }
          />
        );

      case 'boolean':
        return (
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked)}
            />
            {value === true ? 'Yes' : 'No'}
          </label>
        );

      case 'date':
        return (
          <DateInput
            value={value}
            disabled={disabled}
            onChange={(val) => onChange(val)}
          />
        );

      case 'datetime':
        return (
          <DateTimeInput
            value={value}
            disabled={disabled}
            onChange={(val) => onChange(val)}
          />
        );

      case 'enum':
        return (
          <select
            value={asString(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
          >
            <option value="">— None —</option>
            {(field.config.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        );

      case 'multi_enum': {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div className="flex flex-wrap gap-2">
            {(field.config.options ?? []).map((option) => {
              const on = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      on ? selected.filter((v) => v !== option.value) : [...selected, option.value],
                    )
                  }
                  className={cx(
                    'rounded-full border px-3 py-1 text-xs',
                    on
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:bg-surface-subtle',
                  )}
                >
                  {option.label ?? option.value}
                </button>
              );
            })}
          </div>
        );
      }

      case 'colour':
        return (
          <div className="flex gap-2">
            <input
              type="color"
              value={asString(value) || '#000000'}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className="h-9 w-12 rounded border border-border"
            />
            <Input
              value={asString(value)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              placeholder="#4F46E5"
            />
          </div>
        );

      case 'json':
        return (
          <textarea
            value={value === null || value === undefined ? '' : JSON.stringify(value, null, 2)}
            disabled={disabled}
            rows={6}
            onChange={(event) => {
              try {
                onChange(event.target.value ? JSON.parse(event.target.value) : null);
              } catch {
                onChange(event.target.value);
              }
            }}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
          />
        );

      case 'geo': {
        const point = (value ?? {}) as { lat?: number; lng?: number };
        return (
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              step="any"
              value={point.lat ?? ''}
              disabled={disabled}
              placeholder="Latitude"
              onChange={(event) => onChange({ ...point, lat: Number(event.target.value) })}
            />
            <Input
              type="number"
              step="any"
              value={point.lng ?? ''}
              disabled={disabled}
              placeholder="Longitude"
              onChange={(event) => onChange({ ...point, lng: Number(event.target.value) })}
            />
          </div>
        );
      }

      case 'media':
      case 'media_list':
        return (
          <MediaField
            multiple={field.type === 'media_list'}
            value={value}
            disabled={disabled}
            onChange={onChange}
          />
        );

      case 'relation_one':
      case 'relation_many':
        return (
          <EntryPicker
            value={(value as string | string[] | null) ?? null}
            multiple={field.type === 'relation_many'}
            typeApiId={field.config?.relationTypeApiId}
            disabled={disabled}
            onChange={(next) => onChange(next)}
          />
        );

      case 'email':
        return (
          <Input
            type="email"
            value={asString(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
          />
        );

      case 'url':
        return (
          <Input
            type="url"
            value={asString(value)}
            disabled={disabled}
            placeholder="https://"
            onChange={(event) => onChange(event.target.value || null)}
          />
        );

      case 'text':
      case 'slug':
      default:
        return (
          <Input
            value={asString(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
          />
        );
    }
  }
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Media field: thumbnails plus a picker, rather than a raw id box. */
function MediaField({
  multiple,
  value,
  disabled,
  onChange,
}: {
  multiple: boolean;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const [picking, setPicking] = useState(false);

  // A single media field stores a bare id; a list stores an array. The picker
  // works in arrays either way, so the shape is normalised at this boundary.
  const ids = multiple
    ? Array.isArray(value)
      ? (value as string[])
      : []
    : typeof value === 'string' && value
      ? [value]
      : [];

  function commit(next: string[]) {
    onChange(multiple ? next : (next[0] ?? null));
  }

  return (
    <div className="space-y-2">
      <MediaThumbnails ids={ids} onRemove={(id) => commit(ids.filter((v) => v !== id))} />

      {!disabled && (
        <Button variant="secondary" type="button" onClick={() => setPicking(true)}>
          {ids.length === 0 ? 'Choose media' : multiple ? 'Add more' : 'Replace'}
        </Button>
      )}

      {picking && (
        <MediaPicker
          value={ids}
          multiple={multiple}
          onChange={commit}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function DateInput({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (val: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const localValue = useMemo(() => {
    if (!value) return '';
    const str = String(value).trim();
    if (!str) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return str.slice(0, 10);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value || null);
  };

  const handleSetToday = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    onChange(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  };

  const handleClear = () => {
    onChange(null);
  };

  const handleTriggerPicker = () => {
    if (inputRef.current && 'showPicker' in inputRef.current) {
      try {
        inputRef.current.showPicker();
      } catch {
        inputRef.current.focus();
      }
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <input
          ref={inputRef}
          type="date"
          value={localValue}
          disabled={disabled}
          onChange={handleChange}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={handleTriggerPicker}
        title="Open calendar picker"
        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text-secondary hover:bg-surface-subtle hover:text-text disabled:opacity-50"
      >
        📅 Pick
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={handleSetToday}
        title="Set to today"
        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text-secondary hover:bg-surface-subtle hover:text-text disabled:opacity-50"
      >
        Today
      </button>
      {Boolean(value) && !disabled && (
        <button
          type="button"
          onClick={handleClear}
          title="Clear date"
          className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-danger hover:bg-danger/10"
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}

function DateTimeInput({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (val: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Convert stored ISO/UTC string (e.g. "2026-09-15T04:30:00.000Z") to local "YYYY-MM-DDTHH:mm"
  const localValue = useMemo(() => {
    if (!value) return '';
    const str = String(value).trim();
    if (!str) return '';
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (!raw) {
      onChange(null);
      return;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return;
    }
    // Store ISO 8601 UTC string
    onChange(d.toISOString());
  };

  const handleSetNow = () => {
    onChange(new Date().toISOString());
  };

  const handleClear = () => {
    onChange(null);
  };

  const handleTriggerPicker = () => {
    if (inputRef.current && 'showPicker' in inputRef.current) {
      try {
        inputRef.current.showPicker();
      } catch {
        inputRef.current.focus();
      }
    }
  };

  // Human-readable formatted preview in local timezone
  const preview = useMemo(() => {
    if (!value) return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }, [value]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="datetime-local"
            value={localValue}
            disabled={disabled}
            onChange={handleChange}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={handleTriggerPicker}
          title="Open calendar picker"
          className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text-secondary hover:bg-surface-subtle hover:text-text disabled:opacity-50"
        >
          📅 Pick
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={handleSetNow}
          title="Set to current date and time"
          className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text-secondary hover:bg-surface-subtle hover:text-text disabled:opacity-50"
        >
          Now
        </button>
        {Boolean(value) && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            title="Clear date"
            className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-medium text-danger hover:bg-danger/10"
          >
            ✕ Clear
          </button>
        )}
      </div>
      {preview && (
        <p className="text-xs text-text-secondary">
          Selected: <span className="font-medium text-text">{preview}</span>
        </p>
      )}
    </div>
  );
}

