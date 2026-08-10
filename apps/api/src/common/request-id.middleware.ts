import { Injectable, NestMiddleware } from '@nestjs/common';
import { encodePublicId } from '@cms/shared';
import type { NextFunction, Request, Response } from 'express';

import { newId } from './uuid';

/**
 * §14.1: "Every response carries X-Request-Id; quote it in support tickets."
 *
 * Set as early as possible so it is available to the error filter even when a
 * request fails before reaching a handler.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = encodePublicId('request', newId());
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
