import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { enrichLogContext } from './log-context';
import { MetricsService } from './metrics.service';

/**
 * One access-log line and one metric observation per request.
 *
 * It runs after the guards, which is what makes it useful: by this point the
 * request context has been resolved, so the workspace and user are known and go
 * into both the log line and the correlation store. A middleware could not do
 * that — it runs before anyone has been identified.
 *
 * Errors are logged here too, with the same shape as successes, so an error
 * rate can be computed from one stream rather than by joining two.
 */
@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Http');

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    // The matched *pattern*, never the raw path: labelling by raw path would
    // create a metric series per entry id.
    const route = routePattern(request);

    enrichLogContext({
      workspaceId: request.ctx?.workspaceId ?? null,
      orgId: request.ctx?.orgId ?? null,
      userId: request.ctx?.userId ?? null,
      method: request.method,
      route,
    });

    const finish = (status: number, error?: Error) => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      this.metrics.observeRequest(request.method, route, status, durationMs);

      const line = {
        message: `${request.method} ${route} ${status}`,
        method: request.method,
        route,
        status,
        duration_ms: Math.round(durationMs * 10) / 10,
      };

      // 5xx is ours, 4xx is theirs. Logging a client's 404 at error level is how
      // an error-rate alert ends up firing on someone typo'ing a URL.
      if (error || status >= 500) {
        this.logger.error({ ...line, error: error?.message }, error?.stack, 'Http');
      } else if (status >= 400) {
        this.logger.warn(line, 'Http');
      } else {
        this.logger.log(line, 'Http');
      }
    };

    return next.handle().pipe(
      tap({
        next: () => finish(response.statusCode),
        error: (error: Error & { status?: number; getStatus?: () => number }) => {
          // The exception filter has not run yet, so the response still carries
          // its default status — take the status the error itself declares.
          const status = error.getStatus?.() ?? error.status ?? 500;
          finish(status, error);
        },
      }),
    );
  }
}

/**
 * `/admin/v1/workspaces/:workspaceId/content/:typeRef`, not the request's path.
 *
 * Express fills `req.route` once a handler has matched. When nothing matched —
 * a 404 — there is no pattern to report, and using the raw path would let any
 * scanner hitting random URLs create unbounded label cardinality.
 */
function routePattern(request: Request): string {
  const matched = (request as Request & { route?: { path?: string } }).route?.path;
  if (!matched) return 'unmatched';

  const base = request.baseUrl ?? '';
  const full = `${base}${matched}`.replace(/\/+$/, '');
  return full || '/';
}
