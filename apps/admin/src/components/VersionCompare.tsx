import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type ApiError } from '../lib/api';
import { diffEntryData, diffWords, valueToText, type FieldDiff } from '../lib/diff';
import type { FieldDto, VersionDto } from '../lib/content-types';
import { Button, Card, ErrorState, Pill, Skeleton, cx } from './primitives';

/**
 * Side-by-side version comparison (§7.4).
 *
 * Restoring already worked; seeing *what* you would be restoring did not. That
 * gap got more expensive with autosave, which produces far more history than a
 * person clicking Save ever did, so "which of these is the one I want" became
 * a question the UI could not answer.
 *
 * Unchanged fields are collapsed by default. A diff whose job is to show what
 * moved should not open with twelve identical rows above the one that did.
 */

interface VersionContent extends VersionDto {
  data: Record<string, unknown>;
}

export function VersionCompare({
  entryPath,
  versions,
  fields,
  currentVersion,
  onClose,
  onRestore,
  canRestore,
}: {
  entryPath: string;
  versions: VersionDto[];
  fields: FieldDto[];
  currentVersion: number;
  onClose: () => void;
  onRestore: (version: number) => void;
  canRestore: boolean;
}) {
  // Defaults to "the previous version against the newest", which is the
  // comparison people want the overwhelming majority of the time.
  const [leftVersion, setLeftVersion] = useState<number | null>(versions[1]?.version ?? null);
  const [rightVersion, setRightVersion] = useState<number>(versions[0]?.version ?? currentVersion);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const left = useVersionContent(entryPath, leftVersion);
  const right = useVersionContent(entryPath, rightVersion);

  const fieldOrder = useMemo(() => fields.map((field) => field.api_id), [fields]);
  const labels = useMemo(
    () => new Map(fields.map((field) => [field.api_id, field] as const)),
    [fields],
  );

  const diffs = useMemo(() => {
    if (!left.data || !right.data) return [];
    return diffEntryData(left.data.data ?? {}, right.data.data ?? {}, fieldOrder);
  }, [left.data, right.data, fieldOrder]);

  const changed = diffs.filter((diff) => diff.change !== 'unchanged');
  const visible = showUnchanged ? diffs : changed;

  const error = (left.error ?? right.error) as ApiError | null;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text">Compare versions</h3>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <VersionSelect
          label="From"
          versions={versions}
          value={leftVersion}
          onChange={setLeftVersion}
        />
        <span className="pb-2 text-text-secondary">→</span>
        <VersionSelect
          label="To"
          versions={versions}
          value={rightVersion}
          onChange={(value) => value !== null && setRightVersion(value)}
        />

        {canRestore && leftVersion !== null && (
          <Button variant="secondary" onClick={() => onRestore(leftVersion)}>
            Restore v{leftVersion}
          </Button>
        )}
      </div>

      {error ? (
        <ErrorState
          message="Couldn’t load that version"
          detail={error.detail}
          code={error.code}
          requestId={error.requestId}
        />
      ) : left.isLoading || right.isLoading ? (
        <Skeleton rows={4} />
      ) : leftVersion === null ? (
        <p className="text-sm text-text-secondary">
          There is only one version so far — nothing to compare it against yet.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-border pb-2 text-xs text-text-secondary">
            <span>
              {changed.length === 0
                ? 'No differences in field values between these versions.'
                : `${changed.length} field${changed.length === 1 ? '' : 's'} changed`}
            </span>
            {diffs.length > changed.length && (
              <button
                type="button"
                onClick={() => setShowUnchanged((current) => !current)}
                className="text-accent hover:underline"
              >
                {showUnchanged
                  ? 'Hide unchanged'
                  : `Show ${diffs.length - changed.length} unchanged`}
              </button>
            )}
          </div>

          <div className="space-y-4">
            {visible.map((diff) => (
              <FieldComparison
                key={diff.apiId}
                diff={diff}
                label={labels.get(diff.apiId)?.name ?? diff.apiId}
                // A field removed from the content type still appears when it
                // held a value in either version — otherwise old versions look
                // emptier than they actually were.
                orphaned={!labels.has(diff.apiId)}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function useVersionContent(entryPath: string, version: number | null) {
  return useQuery({
    queryKey: ['entry-version', entryPath, version],
    queryFn: () => api.get<VersionContent>(`${entryPath}/versions/${version}`),
    enabled: version !== null,
    // Versions are immutable once written; refetching one can only ever return
    // the same bytes.
    staleTime: Infinity,
  });
}

function VersionSelect({
  label,
  versions,
  value,
  onChange,
}: {
  label: string;
  versions: VersionDto[];
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="block text-xs text-text-secondary">
      {label}
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
        className="mt-1 block rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
      >
        {versions.map((version) => (
          <option key={version.id} value={version.version}>
            v{version.version}
            {version.was_published ? ' · published' : ''}
            {version.change_note ? ` · ${version.change_note}` : ''} ·{' '}
            {new Date(version.created_at).toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  );
}

function FieldComparison({
  diff,
  label,
  orphaned,
}: {
  diff: FieldDiff;
  label: string;
  orphaned: boolean;
}) {
  const before = valueToText(diff.before);
  const after = valueToText(diff.after);
  const tokens = useMemo(() => diffWords(before, after), [before, after]);

  return (
    <div>
      <p className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium text-text">
        {label}
        <span className="font-mono text-xs font-normal text-text-secondary">{diff.apiId}</span>
        {diff.change === 'added' && <Pill tone="success">added</Pill>}
        {diff.change === 'removed' && <Pill tone="danger">cleared</Pill>}
        {orphaned && <Pill tone="neutral">no longer in the schema</Pill>}
      </p>

      {diff.change === 'unchanged' ? (
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-secondary">
          {before || <span className="italic">empty</span>}
        </p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <DiffPane
            heading="Before"
            tokens={tokens.filter((token) => token.op !== 'added')}
            tone="removed"
            empty={!before}
          />
          <DiffPane
            heading="After"
            tokens={tokens.filter((token) => token.op !== 'removed')}
            tone="added"
            empty={!after}
          />
        </div>
      )}
    </div>
  );
}

function DiffPane({
  heading,
  tokens,
  tone,
  empty,
}: {
  heading: string;
  tokens: { op: string; text: string }[];
  tone: 'added' | 'removed';
  empty: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <p className="border-b border-border px-3 py-1 text-[11px] uppercase tracking-wide text-text-secondary">
        {heading}
      </p>
      <p className="whitespace-pre-wrap px-3 py-2 text-sm text-text">
        {empty ? (
          <span className="italic text-text-secondary">empty</span>
        ) : (
          tokens.map((token, index) => (
            <span
              key={index}
              className={cx(
                token.op === 'same' && 'text-text-secondary',
                token.op === 'added' && tone === 'added' && 'rounded bg-success/20 text-text',
                token.op === 'removed' && tone === 'removed' && 'rounded bg-danger/20 text-text',
              )}
            >
              {token.text}
            </span>
          ))
        )}
      </p>
    </div>
  );
}
