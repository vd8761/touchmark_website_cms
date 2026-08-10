import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type ApiErrorBody,
  docsUrlFor,
  ERROR_CODES,
  type ErrorCode,
  type FieldError,
} from '@cms/shared';
import type { Request, Response } from 'express';

import { AppError } from './errors';

/**
 * Translates every thrown thing into the §14.2 error envelope. One filter, so
 * there is exactly one shape a client ever has to parse, and no internal
 * message can escape by accident.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = request.requestId ?? 'req_unknown';

    const { code, message, detail, fields, status, logLevel } = this.classify(exception);
    request.apiErrorCode = code;

    if (logLevel === 'error') {
      this.logger.error(
        `${request.method} ${request.originalUrl} → ${status} ${code} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(`${request.method} ${request.originalUrl} → ${status} ${code} [${requestId}]`);
    }

    const body: ApiErrorBody = {
      error: {
        type: ERROR_CODES[code].type,
        code,
        message,
        ...(detail ? { detail } : {}),
        ...(fields?.length ? { fields } : {}),
        docs_url: docsUrlFor(code),
        request_id: requestId,
      },
    };

    response.status(status).json(body);
  }

  private classify(exception: unknown): {
    code: ErrorCode;
    message: string;
    detail?: string;
    fields?: FieldError[];
    status: number;
    logLevel: 'error' | 'debug';
  } {
    if (exception instanceof AppError) {
      return {
        code: exception.code,
        message: exception.message,
        detail: exception.detail,
        fields: exception.fields,
        status: ERROR_CODES[exception.code].status,
        logLevel: ERROR_CODES[exception.code].status >= 500 ? 'error' : 'debug',
      };
    }

    // class-validator failures arrive as a BadRequestException carrying an
    // array of messages. Reshape them into error.fields[] (§14.3).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (status === 400 && typeof payload === 'object' && Array.isArray((payload as any).message)) {
        return {
          code: 'validation_failed',
          message: 'Some fields need attention.',
          fields: ((payload as any).message as string[]).map((m) => ({
            field: m.split(' ')[0],
            code: 'invalid',
            message: m,
          })),
          status: 400,
          logLevel: 'debug',
        };
      }

      const code = STATUS_TO_CODE[status] ?? 'internal_error';
      const message =
        typeof payload === 'object' && typeof (payload as any).message === 'string'
          ? (payload as any).message
          : exception.message;

      return { code, message, status, logLevel: status >= 500 ? 'error' : 'debug' };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        const target = (exception.meta?.target as string[] | undefined)?.join(', ');
        return {
          code: 'conflict',
          message: 'That value is already taken.',
          detail: target ? `A record with the same ${target} already exists.` : undefined,
          status: 409,
          logLevel: 'debug',
        };
      }
      if (exception.code === 'P2025') {
        return {
          code: 'resource_not_found',
          message: 'Not found.',
          status: 404,
          logLevel: 'debug',
        };
      }
    }

    // Anything unrecognised is a bug. The client gets the request id and
    // nothing else; the detail goes to the logs.
    return {
      code: 'internal_error',
      message: 'Something went wrong on our side.',
      detail: 'Quote the request_id when contacting support.',
      status: 500,
      logLevel: 'error',
    };
  }
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'invalid_request',
  401: 'session_expired',
  403: 'insufficient_permission',
  404: 'resource_not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'unprocessable',
  429: 'rate_limit_exceeded',
  500: 'internal_error',
  503: 'service_unavailable',
};
