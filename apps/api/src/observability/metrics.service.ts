import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';

/**
 * Prometheus metrics, without a Prometheus client library.
 *
 * The exposition format is a few lines of text, and the alternative is another
 * dependency in a tree that already fails `npm audit`. What is here is the
 * subset that answers the four questions an on-call engineer actually asks:
 * is it up, is it slow, is it erroring, and is the queue keeping up.
 *
 * **Label cardinality is the thing to be careful with.** A metrics endpoint that
 * labels by raw URL path creates one time series per entry id and takes the
 * scraper down with it. Routes are therefore recorded as their *patterns*
 * (`/admin/v1/workspaces/:workspaceId/content/:typeRef`), and even then the
 * distinct set is capped — an unrecognised route collapses into `other` rather
 * than growing the map without limit.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private readonly knownRoutes = new Set<string>();
  private readonly startedAt = Date.now();

  /** Beyond this many distinct route labels, everything new becomes `other`. */
  private static readonly MAX_SERIES = 300;

  /** Seconds. Tuned for an API where anything past 2s is already a problem. */
  private static readonly BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

  constructor(private readonly prisma: PrismaService) {}

  observeRequest(method: string, route: string, status: number, durationMs: number): void {
    const safeRoute = this.boundRoute(route);

    const counterKey = `${method}|${safeRoute}|${status}`;
    this.requests.set(counterKey, (this.requests.get(counterKey) ?? 0) + 1);

    const durationKey = `${method}|${safeRoute}`;
    let histogram = this.durations.get(durationKey);
    if (!histogram) {
      histogram = new Histogram(MetricsService.BUCKETS);
      this.durations.set(durationKey, histogram);
    }
    histogram.observe(durationMs / 1000);
  }

  /** The exposition text served at `/metrics`. */
  async render(): Promise<string> {
    const lines: string[] = [];

    lines.push('# HELP cms_http_requests_total Delivery and Admin API requests served.');
    lines.push('# TYPE cms_http_requests_total counter');
    for (const [key, value] of this.requests) {
      const [method, route, status] = key.split('|');
      lines.push(
        `cms_http_requests_total{method="${escape(method)}",route="${escape(route)}",status="${escape(status)}"} ${value}`,
      );
    }

    lines.push('# HELP cms_http_request_duration_seconds Request latency.');
    lines.push('# TYPE cms_http_request_duration_seconds histogram');
    for (const [key, histogram] of this.durations) {
      const [method, route] = key.split('|');
      const labels = `method="${escape(method)}",route="${escape(route)}"`;
      lines.push(...histogram.render('cms_http_request_duration_seconds', labels));
    }

    lines.push(...(await this.queueMetrics()));

    lines.push('# HELP cms_process_uptime_seconds Seconds since this instance started.');
    lines.push('# TYPE cms_process_uptime_seconds gauge');
    lines.push(`cms_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);

    const memory = process.memoryUsage();
    lines.push('# HELP cms_process_memory_bytes Resident and heap memory.');
    lines.push('# TYPE cms_process_memory_bytes gauge');
    lines.push(`cms_process_memory_bytes{kind="rss"} ${memory.rss}`);
    lines.push(`cms_process_memory_bytes{kind="heap_used"} ${memory.heapUsed}`);

    return `${lines.join('\n')}\n`;
  }

  /**
   * Queue depth and the oldest due job.
   *
   * Depth alone is a poor alert: a queue holding 10,000 jobs it is working
   * through quickly is healthy, while one holding three jobs that have been due
   * for an hour is not. The age of the oldest due job is what distinguishes
   * them, and it is the number worth paging on.
   */
  private async queueMetrics(): Promise<string[]> {
    try {
      const rows = await this.prisma.asSystem((tx) =>
        tx.$queryRaw<Array<{ status: string; count: bigint; oldest_seconds: number | null }>>`
          SELECT status,
                 COUNT(*) AS count,
                 EXTRACT(EPOCH FROM (NOW() - MIN(run_at)))::float8 AS oldest_seconds
            FROM jobs
           GROUP BY status
        `,
      );

      const lines = [
        '# HELP cms_jobs Job rows by status.',
        '# TYPE cms_jobs gauge',
        '# HELP cms_jobs_oldest_due_seconds Age of the oldest job in each status.',
        '# TYPE cms_jobs_oldest_due_seconds gauge',
      ];

      for (const row of rows) {
        lines.push(`cms_jobs{status="${escape(row.status)}"} ${Number(row.count)}`);
        if (row.oldest_seconds !== null) {
          lines.push(
            `cms_jobs_oldest_due_seconds{status="${escape(row.status)}"} ${row.oldest_seconds.toFixed(1)}`,
          );
        }
      }

      return lines;
    } catch (error) {
      // A scrape must never fail because one gauge could not be read; the HTTP
      // metrics above are still worth serving, and a missing series is itself
      // visible on a dashboard.
      this.logger.warn(`Queue metrics unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Keeps the label set finite.
   *
   * A route already being tracked always stays tracked; only genuinely new ones
   * are refused once the ceiling is reached. The alternative — dropping the
   * oldest — would make a dashboard's history vanish whenever a burst of
   * unmatched paths arrived, which is exactly when you want to look at it.
   */
  private boundRoute(route: string): string {
    if (this.knownRoutes.has(route)) return route;
    if (this.knownRoutes.size >= MetricsService.MAX_SERIES) return 'other';

    this.knownRoutes.add(route);
    return route;
  }
}

/** Cumulative buckets, as the exposition format requires. */
class Histogram {
  private readonly counts: number[];
  private sum = 0;
  private total = 0;

  constructor(private readonly bounds: number[]) {
    this.counts = new Array(bounds.length).fill(0);
  }

  observe(value: number): void {
    this.sum += value;
    this.total += 1;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= this.bounds[i]) this.counts[i] += 1;
    }
  }

  render(name: string, labels: string): string[] {
    const lines: string[] = [];

    // Already cumulative and therefore monotonic: `observe` increments every
    // bucket whose bound the value falls under, which is what the format wants.
    for (let i = 0; i < this.bounds.length; i += 1) {
      lines.push(`${name}_bucket{${labels},le="${this.bounds[i]}"} ${this.counts[i]}`);
    }

    lines.push(`${name}_bucket{${labels},le="+Inf"} ${this.total}`);
    lines.push(`${name}_sum{${labels}} ${this.sum.toFixed(6)}`);
    lines.push(`${name}_count{${labels}} ${this.total}`);
    return lines;
  }
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
