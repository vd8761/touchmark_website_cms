import { HttpException } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, type FieldError } from '@cms/shared';

/**
 * The one exception type the API throws. Carrying the §14.3 error code rather
 * than a bare HTTP status means the filter can emit the full §14.2 envelope —
 * type, code, message, detail, docs_url, request_id — without guessing.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly fields?: FieldError[];

  constructor(
    code: ErrorCode,
    message: string,
    options: { detail?: string; fields?: FieldError[] } = {},
  ) {
    super(message, ERROR_CODES[code].status);
    this.code = code;
    this.detail = options.detail;
    this.fields = options.fields;
  }
}

/**
 * Deliberately reports "not found" rather than "forbidden" for resources the
 * caller may not see. Distinguishing the two leaks the existence of other
 * tenants' records — a 403 on a workspace id confirms that workspace exists.
 */
export function notFound(resource: string, id?: string): AppError {
  return new AppError('resource_not_found', `${resource} not found.`, {
    detail: id ? `No ${resource.toLowerCase()} with id '${id}' is visible to you.` : undefined,
  });
}

export function conflict(message: string, detail?: string): AppError {
  return new AppError('conflict', message, { detail });
}

export function invalid(message: string, detail?: string): AppError {
  return new AppError('invalid_request', message, { detail });
}

export function unprocessable(message: string, detail?: string): AppError {
  return new AppError('unprocessable', message, { detail });
}
