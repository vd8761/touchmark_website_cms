import { Injectable, Logger, NestMiddleware, OnModuleDestroy } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ApiKeysService } from './api-keys.service';

@Injectable()
export class ApiRequestLogMiddleware implements NestMiddleware, OnModuleDestroy {
  private readonly logger = new Logger(ApiRequestLogMiddleware.name);
  private readonly pending = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly apiKeys: ApiKeysService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const key = req.apiKey;
      if (!key) return;

      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const write = this.apiKeys
        .recordRequest({
          key,
          method: req.method,
          path: req.originalUrl ?? req.path,
          statusCode: res.statusCode,
          errorCode: req.apiErrorCode ?? null,
          ip: req.ip ?? null,
          origin: headerValue(req.headers.origin),
          userAgent: headerValue(req.headers['user-agent']),
          durationMs,
        })
        .catch((error) => {
          if (this.closing) return;
          this.logger.error(`Failed to record API request log: ${(error as Error).message}`);
        })
        .finally(() => {
          this.pending.delete(write);
        });
      this.pending.add(write);
    });

    next();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
