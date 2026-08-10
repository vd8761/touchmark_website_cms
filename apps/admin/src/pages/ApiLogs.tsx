import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError, api } from '../lib/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PermissionDenied,
  Pill,
  Skeleton,
} from '../components/primitives';
import { useSession } from '../lib/session';
import type { ApiKeyDto } from './ApiKeys';

const RANGES = [
  { id: '24h', label: 'Last 24 hours', hours: 24, granularity: 'hour' as const },
  { id: '7d', label: 'Last 7 days', hours: 24 * 7, granularity: 'day' as const },
  { id: '30d', label: 'Last 30 days', hours: 24 * 30, granularity: 'day' as const },
];

interface SummaryDto {
  range: { since: string; until: string; granularity: 'hour' | 'day' };
  totals: {
    requests: number;
    errors: number;
    error_rate: number;
    avg_duration_ms: number | null;
    p50_duration_ms: number | null;
    p95_duration_ms: number | null;
    p99_duration_ms: number | null;
  };
  by_status: { status_class: string; requests: number }[];
  top_paths: { path: string; requests: number; errors: number; avg_duration_ms: number | null }[];
  top_keys: {
    api_key_id: string | null;
    api_key_name: string | null;
    requests: number;
    errors: number;
  }[];
  timeseries: { bucket: string; requests: number; errors: number }[];
}

interface RequestLogDto {
  id: string;
  api_key_id: string;
  method: string;
  path: string;
  status_code: number;
  error_code: string | null;
  ip: string | null;
  origin: string | null;
  user_agent: string | null;
  duration_ms: number;
  occurred_at: string;
}

/**
 * Site → Logs.
 *
 * Delivery API traffic. Requests and errors are deliberately *two* charts on two
 * axes of their own rather than one chart with two y-scales: a healthy workspace
 * has thousands of requests and single-digit errors, so a shared axis would flatten
 * the error line onto zero and hide exactly the thing this screen exists to show.
 */
export function ApiLogs() {
  const { currentWorkspace, can } = useSession();
  const workspaceId = currentWorkspace?.id;

  const [rangeId, setRangeId] = useState('24h');
  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[0];

  const since = useMemo(
    () => new Date(Date.now() - range.hours * 3600_000).toISOString(),
    [range.hours],
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['api-log-summary', workspaceId, rangeId],
    queryFn: () =>
      api.get<SummaryDto>(
        `/admin/v1/workspaces/${workspaceId}/api-logs/summary?since=${encodeURIComponent(since)}&granularity=${range.granularity}`,
      ),
    enabled: Boolean(workspaceId) && can('apilog.view'),
  });

  if (!can('apilog.view')) return <PermissionDenied requiredRole="Site Admin" />;
  if (isLoading) return <Skeleton rows={6} />;

  if (error) {
    const apiError = error as ApiError;
    return (
      <ErrorState
        message="Couldn’t load API logs"
        detail={apiError.detail}
        code={apiError.code}
        requestId={apiError.requestId}
        onRetry={() => void refetch()}
      />
    );
  }

  const summary = data!;
  const hasTraffic = summary.totals.requests > 0;

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text">Logs</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Every Delivery API request your sites make, and how fast it came back.
          </p>
        </div>

        {/* Filters in one row above the charts. */}
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRangeId(option.id)}
              className={
                option.id === rangeId
                  ? 'rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg'
                  : 'rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {!hasTraffic ? (
        <EmptyState
          title="No API traffic yet"
          description="Once a site starts fetching content with an API key, its requests, error rate and response times appear here."
        />
      ) : (
        <>
          <StatTiles totals={summary.totals} />

          <div className="grid gap-4 lg:grid-cols-2">
            <TimeChart
              title="Requests"
              series={summary.timeseries.map((point) => ({
                bucket: point.bucket,
                value: point.requests,
              }))}
              granularity={summary.range.granularity}
              tone="accent"
              format={(value) => value.toLocaleString()}
            />
            <TimeChart
              title="Error rate"
              series={summary.timeseries.map((point) => ({
                bucket: point.bucket,
                value: point.requests > 0 ? (point.errors / point.requests) * 100 : 0,
              }))}
              granularity={summary.range.granularity}
              tone="danger"
              format={(value) => `${value.toFixed(1)}%`}
              maxHint={100}
            />
          </div>

          <StatusBreakdown byStatus={summary.by_status} total={summary.totals.requests} />
          <TopPaths paths={summary.top_paths} />
          <TopKeys keys={summary.top_keys} />
          <RecentRequests workspaceId={workspaceId!} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Latency percentiles are single headline numbers, not a chart — there are three
 * of them and they do not move over the range being displayed.
 */
function StatTiles({ totals }: { totals: SummaryDto['totals'] }) {
  const errorRate = totals.error_rate * 100;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label="Requests" value={totals.requests.toLocaleString()} />
      <Tile
        label="Error rate"
        value={`${errorRate.toFixed(1)}%`}
        note={`${totals.errors.toLocaleString()} failed`}
        // A rising error rate is bad, so it earns the status colour; volume does not.
        tone={errorRate >= 5 ? 'danger' : errorRate >= 1 ? 'warning' : 'neutral'}
      />
      <Tile label="p50" value={formatMs(totals.p50_duration_ms)} />
      <Tile label="p95" value={formatMs(totals.p95_duration_ms)} />
      <Tile label="p99" value={formatMs(totals.p99_duration_ms)} />
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  const valueClass =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text';

  return (
    <Card className="p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-text-secondary">{note}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------

const CHART_WIDTH = 480;
const CHART_HEIGHT = 140;
const PAD = { top: 8, right: 8, bottom: 20, left: 36 };

/**
 * One measure over time. Single series, so the title names it and no legend box
 * is needed. Hover gives a crosshair and the exact value — the axis alone can
 * never answer "what was it at 14:00".
 */
function TimeChart({
  title,
  series,
  granularity,
  tone,
  format,
  maxHint,
}: {
  title: string;
  series: { bucket: string; value: number }[];
  granularity: 'hour' | 'day';
  tone: 'accent' | 'danger';
  format: (value: number) => string;
  maxHint?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const stroke = tone === 'danger' ? 'rgb(var(--danger))' : 'rgb(var(--accent))';

  // One bucket is a number, not a trend. Drawing a "line" through a single point
  // implies a shape that the data does not have; the stat tiles above already
  // carry the value honestly.
  if (series.length < 2) {
    return (
      <Card>
        <h2 className="text-sm font-medium text-text">{title}</h2>
        <p className="mt-2 text-sm text-text-secondary">
          {series.length === 1
            ? `${format(series[0].value)} so far. A trend needs at least two ${granularity === 'day' ? 'days' : 'hours'} of traffic.`
            : 'No traffic in this range.'}
        </p>
      </Card>
    );
  }
  const plotWidth = CHART_WIDTH - PAD.left - PAD.right;
  const plotHeight = CHART_HEIGHT - PAD.top - PAD.bottom;

  const rawMax = Math.max(...series.map((point) => point.value), 0);
  const max = niceCeiling(rawMax === 0 ? (maxHint ? 1 : 1) : rawMax);

  const x = (index: number) =>
    PAD.left + (series.length <= 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth);
  const y = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight;

  const line = series.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const area = `${PAD.left},${PAD.top + plotHeight} ${line} ${x(series.length - 1)},${PAD.top + plotHeight}`;

  const active = hover === null ? null : series[hover];

  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        {active && (
          <p className="text-xs tabular-nums text-text-secondary">
            {formatBucket(active.bucket, granularity)} · {format(active.value)}
          </p>
        )}
      </div>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="mt-2 w-full"
        role="img"
        aria-label={`${title} over time`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive grid: two reference lines, no box, no tick forest. */}
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1={PAD.left}
            x2={CHART_WIDTH - PAD.right}
            y1={PAD.top + plotHeight * fraction}
            y2={PAD.top + plotHeight * fraction}
            stroke="rgb(var(--border))"
            strokeWidth={1}
          />
        ))}

        <text x={2} y={PAD.top + 4} className="fill-current text-[9px] text-text-secondary">
          {format(max)}
        </text>
        <text
          x={2}
          y={PAD.top + plotHeight + 4}
          className="fill-current text-[9px] text-text-secondary"
        >
          {format(0)}
        </text>

        <polygon points={area} fill={stroke} opacity={0.12} />
        <polyline
          points={line}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke="rgb(var(--text-secondary))"
              strokeWidth={1}
            />
            {/* 2px surface ring keeps the marker readable on top of the line. */}
            <circle
              cx={x(hover)}
              cy={y(series[hover].value)}
              r={4}
              fill={stroke}
              stroke="rgb(var(--surface))"
              strokeWidth={2}
            />
          </>
        )}

        {/* Hit targets are full-height bands, far bigger than the marks. */}
        {series.map((point, index) => (
          <rect
            key={point.bucket}
            x={x(index) - plotWidth / Math.max(series.length - 1, 1) / 2}
            y={PAD.top}
            width={plotWidth / Math.max(series.length - 1, 1)}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}

        <text
          x={PAD.left}
          y={CHART_HEIGHT - 6}
          className="fill-current text-[9px] text-text-secondary"
        >
          {formatBucket(series[0]?.bucket, granularity)}
        </text>
        <text
          x={CHART_WIDTH - PAD.right}
          y={CHART_HEIGHT - 6}
          textAnchor="end"
          className="fill-current text-[9px] text-text-secondary"
        >
          {formatBucket(series[series.length - 1]?.bucket, granularity)}
        </text>
      </svg>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function StatusBreakdown({
  byStatus,
  total,
}: {
  byStatus: SummaryDto['by_status'];
  total: number;
}) {
  return (
    <Card>
      <h2 className="text-sm font-medium text-text">Responses by status</h2>

      <div className="mt-3 flex gap-0.5 overflow-hidden rounded-md">
        {byStatus.map((bucket) => (
          <div
            key={bucket.status_class}
            className={`h-2 ${statusFill(bucket.status_class)}`}
            style={{ width: `${(bucket.requests / total) * 100}%` }}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {byStatus.map((bucket) => (
          <div key={bucket.status_class} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${statusFill(bucket.status_class)}`} />
            <span className="font-mono text-xs text-text">{bucket.status_class}</span>
            <span className="text-xs tabular-nums text-text-secondary">
              {bucket.requests.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TopPaths({ paths }: { paths: SummaryDto['top_paths'] }) {
  if (paths.length === 0) return null;
  const busiest = Math.max(...paths.map((path) => path.requests));

  return (
    <Card>
      <h2 className="text-sm font-medium text-text">Top endpoints</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        What your sites actually fetch — useful for deciding what to cache.
      </p>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-secondary">
            <th className="pb-2 font-normal">Path</th>
            <th className="pb-2 text-right font-normal">Requests</th>
            <th className="pb-2 text-right font-normal">Errors</th>
            <th className="pb-2 text-right font-normal">Avg</th>
          </tr>
        </thead>
        <tbody>
          {paths.map((path) => (
            <tr key={path.path} className="border-t border-border">
              <td className="py-2 pr-3">
                <div className="truncate font-mono text-xs text-text">{path.path}</div>
                <div
                  className="mt-1 h-1 rounded-full bg-accent/60"
                  style={{ width: `${(path.requests / busiest) * 100}%` }}
                />
              </td>
              <td className="py-2 text-right tabular-nums">{path.requests.toLocaleString()}</td>
              <td
                className={`py-2 text-right tabular-nums ${path.errors > 0 ? 'text-danger' : 'text-text-secondary'}`}
              >
                {path.errors.toLocaleString()}
              </td>
              <td className="py-2 text-right tabular-nums text-text-secondary">
                {formatMs(path.avg_duration_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function TopKeys({ keys }: { keys: SummaryDto['top_keys'] }) {
  if (keys.length === 0) return null;

  return (
    <Card>
      <h2 className="text-sm font-medium text-text">Traffic by key</h2>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-secondary">
            <th className="pb-2 font-normal">Key</th>
            <th className="pb-2 text-right font-normal">Requests</th>
            <th className="pb-2 text-right font-normal">Errors</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.api_key_id ?? 'deleted'} className="border-t border-border">
              <td className="py-2 pr-3 text-text">
                {key.api_key_name ?? (
                  <span className="text-text-secondary">Deleted key</span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums">{key.requests.toLocaleString()}</td>
              <td
                className={`py-2 text-right tabular-nums ${key.errors > 0 ? 'text-danger' : 'text-text-secondary'}`}
              >
                {key.errors.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Individual requests, per key.
 *
 * The API exposes recent requests only per key and only the newest 50, so the
 * key selector is a real constraint rather than a design choice, and the status
 * and path filters run over those 50 rows in the browser. A workspace-wide,
 * server-filtered log needs an endpoint that does not exist yet.
 */
function RecentRequests({ workspaceId }: { workspaceId: string }) {
  const [keyId, setKeyId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [pathFilter, setPathFilter] = useState('');

  const { data: keys } = useQuery({
    queryKey: ['api-keys', workspaceId],
    queryFn: () => api.list<ApiKeyDto>(`/admin/v1/workspaces/${workspaceId}/api-keys`),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['api-key-logs', workspaceId, keyId],
    queryFn: () =>
      api.list<RequestLogDto>(
        `/admin/v1/workspaces/${workspaceId}/api-keys/${keyId}/request-logs`,
      ),
    enabled: Boolean(keyId),
  });

  const rows = (data?.items ?? []).filter((row) => {
    if (statusFilter === 'errors' && row.status_code < 400) return false;
    if (statusFilter === 'ok' && row.status_code >= 400) return false;
    if (pathFilter && !row.path.toLowerCase().includes(pathFilter.toLowerCase())) return false;
    return true;
  });

  return (
    <Card>
      <h2 className="text-sm font-medium text-text">Recent requests</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        The 50 most recent requests for one key.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <select
          value={keyId}
          onChange={(event) => setKeyId(event.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text"
        >
          <option value="">Choose a key…</option>
          {(keys?.items ?? []).map((key) => (
            <option key={key.id} value={key.id}>
              {key.name} ({key.prefix}_…{key.last_four})
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          disabled={!keyId}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text disabled:opacity-50"
        >
          <option value="all">All statuses</option>
          <option value="ok">Successful only</option>
          <option value="errors">Errors only</option>
        </select>

        <input
          value={pathFilter}
          onChange={(event) => setPathFilter(event.target.value)}
          disabled={!keyId}
          placeholder="Filter by path…"
          className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-secondary disabled:opacity-50"
        />

        {keyId && (
          <Button variant="ghost" onClick={() => void refetch()}>
            Refresh
          </Button>
        )}
      </div>

      {!keyId ? (
        <p className="mt-4 text-sm text-text-secondary">
          Choose a key above to see its individual requests.
        </p>
      ) : isLoading ? (
        <div className="mt-4">
          <Skeleton rows={3} />
        </div>
      ) : error ? (
        <div className="mt-4">
          <ErrorState
            message="Couldn’t load requests"
            detail={(error as ApiError).detail}
            code={(error as ApiError).code}
            requestId={(error as ApiError).requestId}
            onRetry={() => void refetch()}
          />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
          {(data?.items ?? []).length === 0
            ? 'This key has not been used yet.'
            : 'No requests match those filters.'}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-secondary">
                <th className="pb-2 font-normal">When</th>
                <th className="pb-2 font-normal">Request</th>
                <th className="pb-2 text-right font-normal">Status</th>
                <th className="pb-2 text-right font-normal">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-text-secondary">
                    {new Date(row.occurred_at).toLocaleTimeString()}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-text">
                      {row.method} {row.path}
                    </span>
                    {row.error_code && (
                      <span className="ml-2">
                        <Pill tone="danger">{row.error_code}</Pill>
                      </span>
                    )}
                    {row.origin && (
                      <div className="mt-0.5 truncate text-xs text-text-secondary">
                        {row.origin}
                      </div>
                    )}
                  </td>
                  <td
                    className={`py-2 text-right tabular-nums ${row.status_code >= 400 ? 'text-danger' : 'text-text-secondary'}`}
                  >
                    {row.status_code}
                  </td>
                  <td className="py-2 text-right tabular-nums text-text-secondary">
                    {row.duration_ms} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function statusFill(statusClass: string): string {
  if (statusClass.startsWith('2')) return 'bg-success';
  if (statusClass.startsWith('3')) return 'bg-accent';
  if (statusClass.startsWith('4')) return 'bg-warning';
  return 'bg-danger';
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function formatBucket(iso: string | undefined, granularity: 'hour' | 'day'): string {
  if (!iso) return '';
  const date = new Date(iso);
  return granularity === 'day'
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Rounds an axis maximum up to something a person would choose. */
function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}
