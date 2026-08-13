import { Controller, Get, Header, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/permissions.decorator';
import { AppError } from '../common/errors';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Unauthenticated in the session sense — a scraper has no user — but not open.
 * Metrics leak operational shape: route names, traffic volume, error rates and
 * queue depth. `METRICS_TOKEN` gates it with a bearer token, and when the
 * variable is unset the endpoint refuses to serve rather than serving to
 * everyone. Failing closed is the right default for something whose whole
 * purpose is describing the inside of the system.
 *
 * Excluded from the OpenAPI documents: it is not part of either API's contract
 * and has no business appearing in a customer-facing reference.
 */
@Controller()
export class MetricsController {
  private readonly token: string | undefined;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('METRICS_TOKEN') || undefined;
  }

  @Public()
  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() request: Request): Promise<string> {
    if (!this.token) {
      throw new AppError('resource_not_found', 'Metrics are not enabled.', {
        detail: 'Set METRICS_TOKEN to enable the Prometheus endpoint.',
      });
    }

    const presented = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(presented, this.token)) {
      throw new AppError('resource_not_found', 'Metrics are not enabled.');
    }

    return this.metrics.render();
  }
}

/**
 * Constant-time comparison.
 *
 * A scrape endpoint is low-value as targets go, but the token is a shared
 * secret compared on every request from a source that can retry freely, and a
 * short-circuiting `===` is exactly the shape that leaks one byte at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
