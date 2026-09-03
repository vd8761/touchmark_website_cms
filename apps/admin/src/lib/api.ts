import type { ApiErrorBody, CollectionResponse, SingleResponse } from '@cms/shared';

/**
 * The single fetch wrapper the portal uses.
 *
 * Two things it does that matter:
 *  - unwraps the `{ data, meta }` envelope so components never touch it;
 *  - turns the `{ error }` envelope into a typed ApiError carrying `code` and
 *    `request_id`, which the error states of §17.18 display verbatim.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: string | undefined,
    readonly requestId: string,
    readonly status: number,
    readonly fields?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Endpoints that must never trigger a refresh-and-retry.
 *
 * Refreshing in response to a failed refresh is an infinite loop, and retrying
 * a failed sign-in would double every rate-limited attempt.
 */
const NO_RETRY = ['/admin/v1/auth/refresh', '/admin/v1/auth/login', '/admin/v1/auth/logout'];

/**
 * One shared refresh, not one per caller.
 *
 * A screen typically has several queries in flight; when the access token
 * expires they all 401 within milliseconds of each other. Without this they
 * would each POST to /auth/refresh, and because refresh tokens *rotate*, the
 * first would succeed and the rest would present a token that had just been
 * superseded — which the API correctly reads as replay of a stolen token and
 * answers by revoking the entire session family (§6.1). The user would be
 * signed out precisely because their session was renewed.
 */
let refreshInFlight: Promise<void> | null = null;

/**
 * Serialises the refresh across *tabs*, not just within one.
 *
 * The in-process guard below is not enough on its own. Refresh tokens rotate,
 * and two tabs whose tokens expire together will read the same cookie and post
 * it at the same moment: the first rotates it, the second presents a token that
 * has just been superseded, and the API — correctly — treats a replayed refresh
 * token as theft and revokes the whole session family (§6.1). The user is
 * signed out of both tabs for the crime of having two tabs open.
 *
 * A Web Lock makes the second tab wait, by which point the cookie holds the new
 * token and its refresh is an ordinary rotation. Falls back to running directly
 * where the API is unavailable — worse, but no worse than before.
 */
async function withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return work();
  return (await navigator.locks.request('cms-auth-refresh', work)) as T;
}

function refreshOnce(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = withRefreshLock(() =>
      call<void>('/admin/v1/auth/refresh', { method: 'POST' }, false).then(() => undefined),
    ).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function call<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // Session cookies are HttpOnly, so every call must opt in to sending them.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;

    /**
     * An expired access token is refreshed here, for every call — not only the
     * ones that remembered to ask.
     *
     * This used to live in `withRefresh`, which exactly one caller used (the
     * session query). Everything else — saving an entry, publishing, uploading,
     * editing the content model — failed outright once the 15-minute access
     * token expired, showing "You are not signed in" to someone who was. With
     * autosave that is worse than an inconvenience: work silently stops being
     * saved while the editor still looks healthy.
     */
    if (
      response.status === 401 &&
      allowRetry &&
      !NO_RETRY.some((endpoint) => path.startsWith(endpoint))
    ) {
      try {
        await refreshOnce();
        return await call<T>(path, init, false);
      } catch {
        // Refresh failed — the session is genuinely gone. Fall through and
        // report the original 401 so the session provider can sign the user out.
      }
    }

    throw new ApiError(
      error?.code ?? 'internal_error',
      error?.message ?? 'Something went wrong.',
      error?.detail,
      error?.request_id ?? response.headers.get('X-Request-Id') ?? 'unknown',
      response.status,
      error?.fields?.map((f) => ({ field: f.field, message: f.message })),
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => call<SingleResponse<T>>(path, { method: 'GET' }).then((r) => r.data),

  list: <T>(path: string) =>
    call<CollectionResponse<T>>(path, { method: 'GET' }).then((r) => ({
      items: r.data,
      meta: r.meta,
    })),

  post: <T>(path: string, body?: unknown) =>
    call<SingleResponse<T>>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r?.data),

  patch: <T>(path: string, body: unknown) =>
    call<SingleResponse<T>>(path, { method: 'PATCH', body: JSON.stringify(body) }).then(
      (r) => r.data,
    ),

  delete: (path: string, body?: unknown) =>
    call<void>(path, {
      method: 'DELETE',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};

/**
 * Retained for call sites that read better with the retry stated explicitly.
 *
 * `call()` now refreshes for every request, so this adds nothing on its own —
 * it is a no-op wrapper kept so the session query still reads as "this one
 * tolerates an expired token". Do not reach for it expecting behaviour the
 * client does not already have.
 */
export async function withRefresh<T>(work: () => Promise<T>): Promise<T> {
  return work();
}
