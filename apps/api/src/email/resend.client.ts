import { createHmac } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { CryptoService } from '../common/crypto.service';

/**
 * Thin Resend adapter.
 *
 * Deliberately a hand-rolled fetch client rather than the `resend` SDK: the SDK
 * assumes one API key for the process, and here the key varies per request
 * because each organisation brings its own account. It is also a small enough
 * surface that owning it is cheaper than adapting around the SDK's assumptions.
 *
 * Open Decision #2 asks for the provider to be replaceable. Everything
 * Resend-specific is in this file; the services above it speak only in the
 * types declared here.
 */

const API_BASE = 'https://api.resend.com';
const TIMEOUT_MS = 10_000;

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region?: string;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Deduplication key. Resend honours this to make retries safe. */
  idempotencyKey?: string;
}

export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'ResendApiError';
  }

  /**
   * True when the key itself is the problem, not this particular request.
   *
   * Resend answers an invalid key with **400 `validation_error`**, not the 401
   * you would expect, so status alone is not enough to tell "your key is wrong"
   * from "your request was wrong" — and the difference decides whether the user
   * is told to check their key or told something unhelpful. Verified against the
   * live API: `GET /domains` with a bad key returns
   * `{"statusCode":400,"message":"API key is invalid","name":"validation_error"}`.
   */
  get isCredentialError(): boolean {
    if (this.status === 401 || this.status === 403) return true;
    return this.status === 400 && /api key/i.test(this.message);
  }
}

export class ResendClient {
  private readonly logger = new Logger(ResendClient.name);

  constructor(private readonly apiKey: string) {}

  /**
   * Cheapest authenticated call Resend offers. Used to validate a key at the
   * moment it is entered, so a bad key is reported in the form rather than
   * discovered when the first campaign fails.
   */
  async listDomains(): Promise<ResendDomain[]> {
    const body = await this.request<{ data: ResendDomain[] }>('GET', '/domains');
    return body.data ?? [];
  }

  async sendEmail(input: SendEmailInput): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      'POST',
      '/emails',
      {
        from: input.from,
        to: input.to,
        subject: input.subject,
        ...(input.html ? { html: input.html } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      },
      input.idempotencyKey,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // A network failure is not a credential failure — mapping it to 401 would
      // wrongly mark a working configuration as invalid.
      throw new ResendApiError(503, `Could not reach Resend: ${(error as Error).message}`);
    }

    const payload = (await response.json().catch(() => null)) as
      | { message?: string; name?: string }
      | null;

    if (!response.ok) {
      throw new ResendApiError(
        response.status,
        payload?.message ?? `Resend returned ${response.status}.`,
        payload?.name,
      );
    }

    return payload as T;
  }
}

/**
 * Verifies an inbound Resend webhook.
 *
 * Resend delivers through Svix, which signs `${id}.${timestamp}.${body}` with
 * HMAC-SHA256 under a base64 secret prefixed `whsec_`. The signature header can
 * carry several space-separated values during a secret rotation, so every one
 * is checked.
 *
 * The raw body must be the exact bytes received — re-serialising parsed JSON
 * changes key order and whitespace and breaks the signature.
 */
export function verifyResendSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
): { valid: boolean; reason?: string } {
  const { id, timestamp, signature } = headers;

  if (!id || !timestamp || !signature) {
    return { valid: false, reason: 'Missing svix-id, svix-timestamp or svix-signature header.' };
  }

  // Reject stale timestamps: without this, a captured request stays replayable
  // forever, since the signature over it remains valid.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) {
    return { valid: false, reason: 'Timestamp is outside the five-minute tolerance.' };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // Header format: "v1,<sig> v1,<sig>" — one per active secret during rotation.
  for (const candidate of signature.split(' ')) {
    const value = candidate.startsWith('v1,') ? candidate.slice(3) : candidate;
    if (CryptoService.safeEqual(value, expected)) return { valid: true };
  }

  return { valid: false, reason: 'No signature matched.' };
}
