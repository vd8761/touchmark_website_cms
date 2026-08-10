import { createHmac, randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../common/crypto.service';
import { parseDomains } from './email-config.service';
import { ResendApiError, verifyResendSignature } from './resend.client';

function cryptoWith(env: Record<string, string | undefined>): CryptoService {
  const service = new CryptoService({ get: (key: string) => env[key] } as ConfigService);
  service.onModuleInit();
  return service;
}

const KEY_V1 = `v1:${randomBytes(32).toString('base64')}`;
const KEY_V2 = `v2:${randomBytes(32).toString('base64')}`;

describe('CryptoService — provider credentials at rest', () => {
  it('round-trips a value', () => {
    const crypto = cryptoWith({ ENCRYPTION_KEYS: KEY_V1 });
    const secret = 're_abc123_a_resend_api_key';
    expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
  });

  it('produces different ciphertext each time for the same input', () => {
    // A deterministic ciphertext would let anyone holding the database tell
    // which organisations share an API key.
    const crypto = cryptoWith({ ENCRYPTION_KEYS: KEY_V1 });
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const crypto = cryptoWith({ ENCRYPTION_KEYS: KEY_V1 });
    const encoded = crypto.encrypt('re_secret');
    const parts = encoded.split('.');
    // Flip a byte of the ciphertext; GCM's auth tag must catch it.
    parts[3] = Buffer.from(
      Buffer.from(parts[3], 'base64url').map((b, i) => (i === 0 ? b ^ 0xff : b)),
    ).toString('base64url');

    expect(() => crypto.decrypt(parts.join('.'))).toThrow();
  });

  it('decrypts values written under an older key after rotation', () => {
    // Rotation must not require re-encrypting everything in one step.
    const before = cryptoWith({ ENCRYPTION_KEYS: KEY_V1 });
    const encoded = before.encrypt('re_old_key_value');

    const after = cryptoWith({ ENCRYPTION_KEYS: `${KEY_V2},${KEY_V1}` });
    expect(after.decrypt(encoded)).toBe('re_old_key_value');
    expect(after.needsRotation(encoded)).toBe(true);
    expect(after.needsRotation(after.encrypt('new'))).toBe(false);
  });

  it('explains itself when the key that encrypted a value is gone', () => {
    const before = cryptoWith({ ENCRYPTION_KEYS: KEY_V1 });
    const encoded = before.encrypt('orphaned');
    const after = cryptoWith({ ENCRYPTION_KEYS: KEY_V2 });

    expect(() => after.decrypt(encoded)).toThrow(/not loaded/);
  });

  it('refuses to start in production without an explicit key', () => {
    expect(() =>
      cryptoWith({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }),
    ).toThrow(/ENCRYPTION_KEYS is required in production/);
  });
});

describe('Resend webhook signature verification', () => {
  const secret = `whsec_${randomBytes(24).toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } });

  function sign(id: string, timestamp: string, payload: string, withSecret = secret): string {
    const key = Buffer.from(withSecret.replace(/^whsec_/, ''), 'base64');
    return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
  }

  const now = () => Math.floor(Date.now() / 1000).toString();

  it('accepts a correctly signed payload', () => {
    const id = 'msg_1';
    const ts = now();
    expect(
      verifyResendSignature(secret, { id, timestamp: ts, signature: sign(id, ts, body) }, body),
    ).toEqual({ valid: true });
  });

  it('rejects a payload signed with a different secret', () => {
    const id = 'msg_2';
    const ts = now();
    const other = `whsec_${randomBytes(24).toString('base64')}`;

    expect(
      verifyResendSignature(
        secret,
        { id, timestamp: ts, signature: sign(id, ts, body, other) },
        body,
      ).valid,
    ).toBe(false);
  });

  it('rejects a modified body', () => {
    const id = 'msg_3';
    const ts = now();
    const signature = sign(id, ts, body);
    const tampered = body.replace('delivered', 'bounced');

    expect(verifyResendSignature(secret, { id, timestamp: ts, signature }, tampered).valid).toBe(
      false,
    );
  });

  it('rejects a replayed request outside the timestamp tolerance', () => {
    // Without this, a captured request stays valid forever — the signature over
    // it never stops matching.
    const id = 'msg_4';
    const old = (Math.floor(Date.now() / 1000) - 3600).toString();

    const result = verifyResendSignature(
      secret,
      { id, timestamp: old, signature: sign(id, old, body) },
      body,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it('accepts either signature while a secret is being rotated', () => {
    const id = 'msg_5';
    const ts = now();
    const stale = sign(id, ts, body, `whsec_${randomBytes(24).toString('base64')}`);
    const current = sign(id, ts, body);

    expect(
      verifyResendSignature(secret, { id, timestamp: ts, signature: `${stale} ${current}` }, body)
        .valid,
    ).toBe(true);
  });

  it('rejects a request with headers missing', () => {
    expect(verifyResendSignature(secret, {}, body).valid).toBe(false);
  });
});

describe('parseDomains', () => {
  it('keeps well-formed entries', () => {
    expect(
      parseDomains([
        { id: '1', name: 'acme.com', status: 'verified' },
        { id: '2', name: 'staging.acme.com', status: 'pending' },
      ]),
    ).toHaveLength(2);
  });

  it('degrades to empty rather than throwing on a malformed cache', () => {
    // The column caches Resend's state. A bad cache should be fixed by a
    // refresh, not break the settings page.
    expect(parseDomains(null)).toEqual([]);
    expect(parseDomains('nonsense')).toEqual([]);
    expect(parseDomains([{ nope: true }, null, 42])).toEqual([]);
  });
});

describe('ResendApiError classification', () => {
  it('treats Resend’s 400 "API key is invalid" as a credential problem', () => {
    // Verified against the live API: Resend answers a bad key with 400
    // validation_error, not 401. Classifying on status alone would give the
    // user a vague "could not verify" instead of "check your key".
    expect(new ResendApiError(400, 'API key is invalid', 'validation_error').isCredentialError).toBe(
      true,
    );
  });

  it('still treats 401 and 403 as credential problems', () => {
    expect(new ResendApiError(401, 'Unauthorized').isCredentialError).toBe(true);
    expect(new ResendApiError(403, 'Forbidden').isCredentialError).toBe(true);
  });

  it('does not misclassify an ordinary validation failure as a bad key', () => {
    // A malformed from-address is the caller's mistake, not a credential fault;
    // marking the configuration invalid for it would be wrong.
    expect(
      new ResendApiError(400, 'The from field must be a valid email', 'validation_error')
        .isCredentialError,
    ).toBe(false);
  });

  it('does not treat an unreachable provider as a bad key', () => {
    expect(new ResendApiError(503, 'Could not reach Resend: timeout').isCredentialError).toBe(false);
  });
});
