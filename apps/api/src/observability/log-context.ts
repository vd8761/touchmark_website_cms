import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request correlation fields, carried without threading them through every
 * call signature.
 *
 * The problem this solves is specific. A support question is almost always
 * "what happened to *this* request, for *this* customer" — and until now the
 * answer had to be reconstructed by eye from unstructured lines that shared no
 * key. `X-Request-Id` was already on every response (§14.1); it just never
 * reached the log.
 *
 * `AsyncLocalStorage` propagates through promises and timers, so a line written
 * four awaits deep inside a service still carries the request it belongs to
 * without that service knowing anything about HTTP.
 *
 * The store is mutable on purpose: the request id exists from the first
 * middleware, but the workspace and user are not known until the auth guard has
 * run, and log lines written in between should not be dropped for it.
 */
export interface LogContext {
  requestId?: string;
  workspaceId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  apiKeyId?: string | null;
  method?: string;
  route?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `work` with a fresh context. Called once per request. */
export function withLogContext<T>(seed: LogContext, work: () => T): T {
  return storage.run({ ...seed }, work);
}

/** Adds fields to the active context, if there is one. A no-op outside a request. */
export function enrichLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}
