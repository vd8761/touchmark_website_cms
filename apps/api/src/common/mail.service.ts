import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

/**
 * Transactional system email — verification, reset, invitations, and the
 * security notifications of §6.1.
 *
 * This is NOT the campaign sending path. Campaigns go through the ESP adapter
 * in Phase 4 with its own throttling, suppression checks and event ingestion.
 * Keeping them separate means a campaign backlog can never delay a password
 * reset, and a system email can never be suppressed by an unsubscribe.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;
  private readonly appUrl: string;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.appUrl = config.get<string>('APP_URL') ?? 'http://localhost:5173';
    this.from = config.get<string>('SMTP_FROM') ?? 'CMS Platform <no-reply@localhost>';
    this.transport = createTransport({
      host: config.get<string>('SMTP_HOST') ?? 'localhost',
      port: Number(config.get('SMTP_PORT') ?? 1025),
      secure: false,
      ignoreTLS: true,
    });
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const url = `${this.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send(to, 'Confirm your email address', [
      'Welcome. Confirm your email address to finish setting up your account:',
      url,
      'This link is valid for 24 hours. If you did not create an account, ignore this email.',
    ]);
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const url = `${this.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send(to, 'Reset your password', [
      'Someone asked to reset the password for this account. If it was you, use this link:',
      url,
      'The link is valid for 30 minutes and can be used once. If it was not you, no action ' +
        'is needed — your password has not changed.',
    ]);
  }

  async sendPasswordChanged(to: string): Promise<void> {
    await this.send(to, 'Your password was changed', [
      'Your password has just been changed and every other signed-in session was ended.',
      'If this was not you, reset your password immediately and contact support.',
    ]);
  }

  async sendInvitation(
    to: string,
    token: string,
    context: { orgName: string; inviterName: string | null },
  ): Promise<void> {
    const url = `${this.appUrl}/invitations/${encodeURIComponent(token)}`;
    const who = context.inviterName ?? 'Someone';
    await this.send(to, `${who} invited you to ${context.orgName}`, [
      `${who} has invited you to join ${context.orgName}.`,
      url,
      'This invitation expires in 7 days.',
    ]);
  }

  async sendWorkspaceDeletionNotice(
    to: string[],
    context: { workspaceName: string; action: 'archived' | 'deleted'; actorName: string | null },
  ): Promise<void> {
    // §6.3: "An email is sent to all Org Owners on both actions."
    const verb = context.action === 'archived' ? 'archived' : 'scheduled for deletion';
    for (const recipient of to) {
      await this.send(recipient, `Site "${context.workspaceName}" was ${verb}`, [
        `${context.actorName ?? 'A site admin'} has ${verb} the site "${context.workspaceName}".`,
        context.action === 'deleted'
          ? 'It can be restored for the next 30 days, after which it is permanently purged ' +
            'including all media in object storage.'
          : 'The site is now read-only and its API keys have stopped working. This is reversible.',
      ]);
    }
  }

  async sendApiKeyRevokedNotice(
    to: string[],
    context: { workspaceName: string; keyName: string; actorName: string | null; reason?: string | null },
  ): Promise<void> {
    for (const recipient of to) {
      await this.send(recipient, `API key revoked for "${context.workspaceName}"`, [
        `${context.actorName ?? 'A site admin'} revoked the API key "${context.keyName}".`,
        context.reason
          ? `Reason: ${context.reason}`
          : 'If this was unexpected, create a replacement key and review recent API request logs.',
      ]);
    }
  }

  private async send(to: string, subject: string, paragraphs: string[]): Promise<void> {
    const text = paragraphs.join('\n\n');
    try {
      await this.transport.sendMail({ from: this.from, to, subject, text });
    } catch (error) {
      // A failed system email must not fail the request that triggered it —
      // the account was still created, the password was still reset. It is
      // logged loudly and, from Phase 2, retried by the job queue.
      this.logger.error(`Failed to send "${subject}" to ${to}: ${(error as Error).message}`);
    }
  }
}
