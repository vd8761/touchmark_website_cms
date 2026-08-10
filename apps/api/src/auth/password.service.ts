import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { AppError } from '../common/errors';

/**
 * Password hashing and policy (§6.1, §18.2).
 *
 * argon2id with parameters chosen for ~100ms on a modern server core. If these
 * change, existing hashes remain verifiable — argon2 encodes its parameters in
 * the hash string — and are transparently upgraded on next successful login.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

const MIN_LENGTH = 12;

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(private readonly config: ConfigService) {}

  async hash(plaintext: string): Promise<string> {
    return argonHash(plaintext, ARGON_OPTIONS);
  }

  async verify(hashValue: string, plaintext: string): Promise<boolean> {
    try {
      return await argonVerify(hashValue, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * §6.1: "12+ chars, checked against the HaveIBeenPwned k-anonymity range API."
   *
   * k-anonymity means only the first five characters of the SHA-1 hash leave
   * this process — the password itself is never transmitted anywhere.
   */
  async assertAcceptable(plaintext: string, context: { email?: string } = {}): Promise<void> {
    if (plaintext.length < MIN_LENGTH) {
      throw new AppError('validation_failed', 'That password is too short.', {
        detail: `Passwords must be at least ${MIN_LENGTH} characters. Length matters far more than mixing symbols.`,
        fields: [{ field: 'password', code: 'too_short', message: `Use ${MIN_LENGTH} or more characters.` }],
      });
    }

    if (plaintext.length > 256) {
      throw new AppError('validation_failed', 'That password is too long.', {
        fields: [{ field: 'password', code: 'too_long', message: 'Maximum 256 characters.' }],
      });
    }

    if (context.email && plaintext.toLowerCase().includes(context.email.split('@')[0].toLowerCase())) {
      throw new AppError('validation_failed', 'That password contains your email address.', {
        fields: [
          { field: 'password', code: 'contains_email', message: 'Choose something unrelated to your email.' },
        ],
      });
    }

    if (this.config.get('PASSWORD_PWNED_CHECK') === 'false') return;
    if (await this.isBreached(plaintext)) {
      throw new AppError('validation_failed', 'That password has appeared in a data breach.', {
        detail:
          'This password appears in public breach corpora, so it is already in attackers’ ' +
          'wordlists. Choose a different one — a passphrase of a few unrelated words works well.',
        fields: [
          { field: 'password', code: 'breached', message: 'This password is known to be compromised.' },
        ],
      });
    }
  }

  private async isBreached(plaintext: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(plaintext).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'cms-platform' },
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return false;

      const body = await response.text();
      return body
        .split('\n')
        .some((line) => line.split(':')[0]?.trim() === suffix && line.split(':')[1]?.trim() !== '0');
    } catch (error) {
      // Availability of a third-party service must not block signup. Failing
      // open here is the deliberate exception to §1.2's "fail closed": the
      // length and reuse checks still applied.
      this.logger.warn(`HaveIBeenPwned check unavailable, skipping: ${(error as Error).message}`);
      return false;
    }
  }
}
