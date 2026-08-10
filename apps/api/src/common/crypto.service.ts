import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Envelope encryption for provider credentials (§18.2: "Secrets — ESP
 * credentials, MFA seeds, webhook secrets — envelope encryption via KMS,
 * rotatable").
 *
 * This is the local implementation of that contract: AES-256-GCM under a master
 * key from the environment. The ciphertext carries a key id, so rotating to a
 * new master key does not require re-encrypting everything at once — old
 * ciphertexts keep decrypting under the previous key while new writes use the
 * current one.
 *
 * Swapping this for AWS KMS or Vault means reimplementing `encrypt`/`decrypt`
 * against their APIs; the stored format and every call site stay as they are.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);

  /** keyId → 32-byte key. The first entry is the current write key. */
  private keys = new Map<string, Buffer>();
  private currentKeyId = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // ENCRYPTION_KEYS is `keyId:base64key` entries, newest first.
    const raw = this.config.get<string>('ENCRYPTION_KEYS');

    if (!raw) {
      // Falling back to the JWT secret keeps development working without a
      // second variable, but must never happen in production: it would tie
      // credential confidentiality to a token-signing secret that is rotated
      // on a completely different schedule.
      if (this.config.get('NODE_ENV') === 'production') {
        throw new Error(
          'ENCRYPTION_KEYS is required in production. Generate one with: ' +
            'node -e "console.log(\'v1:\' + require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
        );
      }

      const derived = createHash('sha256')
        .update(`enc:${this.config.getOrThrow<string>('JWT_SECRET')}`)
        .digest();

      this.keys.set('dev', derived);
      this.currentKeyId = 'dev';
      this.logger.warn('ENCRYPTION_KEYS not set — using a key derived from JWT_SECRET (development only).');
      return;
    }

    for (const entry of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
      const separator = entry.indexOf(':');
      const keyId = entry.slice(0, separator);
      const key = Buffer.from(entry.slice(separator + 1), 'base64');

      if (key.length !== 32) {
        throw new Error(`Encryption key '${keyId}' must be 32 bytes (base64-encoded).`);
      }

      this.keys.set(keyId, key);
      if (!this.currentKeyId) this.currentKeyId = keyId;
    }

    if (!this.currentKeyId) throw new Error('ENCRYPTION_KEYS contained no usable keys.');
  }

  /** Returns `keyId.iv.authTag.ciphertext`, all base64url. */
  encrypt(plaintext: string): string {
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      this.currentKeyId,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(encoded: string): string {
    const [keyId, iv, authTag, ciphertext] = encoded.split('.');
    const key = this.keys.get(keyId);

    if (!key) {
      throw new Error(
        `Cannot decrypt: encryption key '${keyId}' is not loaded. It was removed from ` +
          'ENCRYPTION_KEYS before the values encrypted under it were re-encrypted.',
      );
    }

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when `encoded` was produced under a key that is no longer current. */
  needsRotation(encoded: string): boolean {
    return encoded.split('.')[0] !== this.currentKeyId;
  }

  /** Constant-time comparison, for signature and secret checks. */
  static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
