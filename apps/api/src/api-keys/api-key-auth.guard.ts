import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AppError } from '../common/errors';
import { ApiKeysService, type ApiKeyAuthContext } from './api-keys.service';
import type { ApiKeyScope } from './api-key-scopes';

export const REQUIRED_API_SCOPE = 'required_api_scope';

export const RequireApiScope = (scope: ApiKeyScope) =>
  applyDecorators(SetMetadata(REQUIRED_API_SCOPE, scope), ApiExtension('x-required-api-scope', scope));

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope>(
      REQUIRED_API_SCOPE,
      targets,
    );
    const request = context.switchToHttp().getRequest<Request>();
    const plaintext = extractApiKey(request);

    if (!plaintext) {
      throw new AppError('missing_api_key', 'This endpoint requires an API key.', {
        detail: 'Send it in the Authorization header as Bearer <api_key>.',
      });
    }

    const key = await this.apiKeys.authenticate(plaintext, {
      origin: headerValue(request.headers.origin),
      ip: request.ip ?? null,
    });
    request.apiKey = key;

    if (requiredScope && !key.scopes.includes(requiredScope)) {
      throw new AppError('insufficient_scope', 'This API key does not have the required scope.', {
        detail: `Required scope: ${requiredScope}.`,
      });
    }

    const rate = await this.apiKeys.consumeRateLimit(key, {
      scope: requiredScope,
      ip: request.ip ?? null,
    });
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('X-RateLimit-Limit', String(rate.limit));
    response.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt.getTime() / 1000)));

    if (!rate.allowed) {
      throw new AppError('rate_limit_exceeded', 'API key rate limit exceeded.', {
        detail: `Limit is ${rate.limit} requests per minute for this key.`,
      });
    }

    return true;
  }
}

function extractApiKey(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  return scheme === 'Bearer' && value ? value : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

declare module 'express' {
  interface Request {
    apiKey?: ApiKeyAuthContext;
    apiErrorCode?: string;
  }
}
