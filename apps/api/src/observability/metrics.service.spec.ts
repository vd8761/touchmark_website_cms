import { MetricsService } from './metrics.service';

/** Queue gauges need a database; everything else is arithmetic and formatting. */
const prisma = {
  asSystem: async () => {
    throw new Error('no database in unit tests');
  },
} as never;

function build(): MetricsService {
  return new MetricsService(prisma);
}

describe('MetricsService', () => {
  it('counts requests per method, route and status', async () => {
    const metrics = build();
    metrics.observeRequest('GET', '/v1/content/:type', 200, 12);
    metrics.observeRequest('GET', '/v1/content/:type', 200, 18);
    metrics.observeRequest('GET', '/v1/content/:type', 404, 3);

    const output = await metrics.render();

    expect(output).toContain(
      'cms_http_requests_total{method="GET",route="/v1/content/:type",status="200"} 2',
    );
    expect(output).toContain(
      'cms_http_requests_total{method="GET",route="/v1/content/:type",status="404"} 1',
    );
  });

  it('emits cumulative, monotonic histogram buckets', async () => {
    const metrics = build();
    for (const ms of [3, 30, 300, 3000]) {
      metrics.observeRequest('GET', '/v1/health', 200, ms);
    }

    const output = await metrics.render();
    const buckets = [...output.matchAll(/le="([^"]+)"} (\d+)/g)].map(([, le, count]) => ({
      le: le === '+Inf' ? Infinity : Number(le),
      count: Number(count),
    }));

    // Prometheus rejects a histogram whose buckets decrease; getting this wrong
    // produces a scrape that parses and then silently misreports every quantile.
    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i].count).toBeGreaterThanOrEqual(buckets[i - 1].count);
    }
    expect(buckets[buckets.length - 1].count).toBe(4);

    expect(output).toContain('cms_http_request_duration_seconds_count{method="GET",route="/v1/health"} 4');
    // 3 + 30 + 300 + 3000 ms
    expect(output).toContain('cms_http_request_duration_seconds_sum{method="GET",route="/v1/health"} 3.333000');
  });

  it('collapses unbounded route labels instead of growing forever', async () => {
    const metrics = build();

    // A scanner hitting 500 distinct paths must not create 500 time series.
    for (let i = 0; i < 500; i += 1) {
      metrics.observeRequest('GET', `/scanned/${i}`, 404, 1);
    }

    const output = await metrics.render();
    const series = [...output.matchAll(/cms_http_requests_total\{/g)].length;

    expect(series).toBeLessThanOrEqual(301);
    expect(output).toContain('route="other"');
  });

  it('keeps tracking a route it already knows once the ceiling is reached', async () => {
    const metrics = build();
    metrics.observeRequest('GET', '/v1/health', 200, 1);
    for (let i = 0; i < 500; i += 1) {
      metrics.observeRequest('GET', `/scanned/${i}`, 404, 1);
    }
    metrics.observeRequest('GET', '/v1/health', 200, 1);

    const output = await metrics.render();
    // The important route must not lose its history to a burst of junk.
    expect(output).toContain(
      'cms_http_requests_total{method="GET",route="/v1/health",status="200"} 2',
    );
  });

  it('still serves HTTP metrics when the queue gauges cannot be read', async () => {
    const metrics = build();
    metrics.observeRequest('GET', '/v1/health', 200, 1);

    // asSystem throws here; a scrape must degrade rather than fail.
    const output = await metrics.render();

    expect(output).toContain('cms_http_requests_total');
    expect(output).toContain('cms_process_uptime_seconds');
    expect(output).not.toContain('cms_jobs{');
  });

  it('escapes label values so one bad route cannot corrupt the payload', async () => {
    const metrics = build();
    metrics.observeRequest('GET', 'we"ird', 200, 1);

    const output = await metrics.render();
    expect(output).toContain('route="we\\"ird"');
  });
});
