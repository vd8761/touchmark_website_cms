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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
 * A 401 anywhere means the access token expired. One refresh attempt is made
 * and the original call replayed; a second failure sends the user to sign-in.
 * Kept here rather than in an interceptor so the retry is visible at the call
 * site that owns it.
 */
export async function withRefresh<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;

    await api.post('/admin/v1/auth/refresh');
    return work();
  }
}
