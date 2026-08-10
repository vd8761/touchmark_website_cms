/**
 * The error vocabulary from spec §14.2 (envelope) and §14.3 (code table).
 *
 * Shared so the admin portal can switch on `error.code` without duplicating
 * string literals, and so the OpenAPI generator has one source for the enum.
 */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'api_error';

export const ERROR_CODES = {
  invalid_request: { status: 400, type: 'invalid_request_error' },
  validation_failed: { status: 400, type: 'invalid_request_error' },

  missing_api_key: { status: 401, type: 'authentication_error' },
  invalid_api_key: { status: 401, type: 'authentication_error' },
  key_revoked: { status: 401, type: 'authentication_error' },
  key_expired: { status: 401, type: 'authentication_error' },
  invalid_credentials: { status: 401, type: 'authentication_error' },
  session_expired: { status: 401, type: 'authentication_error' },
  mfa_required: { status: 401, type: 'authentication_error' },

  insufficient_scope: { status: 403, type: 'permission_error' },
  insufficient_permission: { status: 403, type: 'permission_error' },
  origin_not_allowed: { status: 403, type: 'permission_error' },
  ip_not_allowed: { status: 403, type: 'permission_error' },
  workspace_archived: { status: 403, type: 'permission_error' },
  workspace_suspended: { status: 403, type: 'permission_error' },
  email_not_verified: { status: 403, type: 'permission_error' },

  resource_not_found: { status: 404, type: 'not_found_error' },

  conflict: { status: 409, type: 'conflict_error' },

  resource_gone: { status: 410, type: 'not_found_error' },
  payload_too_large: { status: 413, type: 'invalid_request_error' },
  unprocessable: { status: 422, type: 'invalid_request_error' },
  rate_limit_exceeded: { status: 429, type: 'rate_limit_error' },
  internal_error: { status: 500, type: 'api_error' },
  service_unavailable: { status: 503, type: 'api_error' },
} as const satisfies Record<string, { status: number; type: ErrorType }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    type: ErrorType;
    code: ErrorCode;
    message: string;
    detail?: string;
    fields?: FieldError[];
    docs_url: string;
    request_id: string;
  };
}

export const DOCS_ERROR_BASE = 'https://docs.yourcms.com/errors';

export function docsUrlFor(code: ErrorCode): string {
  return `${DOCS_ERROR_BASE}/${code}`;
}
