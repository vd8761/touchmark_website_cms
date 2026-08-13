import { Injectable, NestMiddleware } from '@nestjs/common';
import { encodePublicId } from '@cms/shared';
import type { NextFunction, Request, Response } from 'express';

import { withLogContext } from '../observability/log-context';
import { newId } from './uuid';

/**
 * §14.1: "Every response carries X-Request-Id; quote it in support tickets."
 *
 * Set as early as possible so it is available to the error filter even when a
 * request fails before reaching a handler.
 *
 * This is also where the logging correlation scope opens. It has to be the
 * outermost thing in the request, because a line written by a guard that
 * rejects the request — the most interesting lines there are — is written
 * before any interceptor has run.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = encodePublicId('request', newId());
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    // `next` is called *inside* the scope, so everything downstream — guards,
    // interceptors, handlers, and anything they await — inherits it.
    withLogContext({ requestId, method: req.method }, () => next());
  }
}
