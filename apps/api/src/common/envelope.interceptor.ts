import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';

/**
 * Applies the §14.2 response envelope.
 *
 * Handlers return `{ data }` (plus optional `meta`); this fills in `request_id`
 * and any pagination meta so no handler has to remember to. A handler returning
 * undefined (204) is passed through untouched.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((payload) => {
        if (payload === undefined || payload === null) return payload;
        if (typeof payload !== 'object') return payload;

        const body = payload as { data?: unknown; meta?: Record<string, unknown> };
        if (!('data' in body)) return payload;

        return {
          data: body.data,
          meta: { request_id: request.requestId, ...(body.meta ?? {}) },
        };
      }),
    );
  }
}
