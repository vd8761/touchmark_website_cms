import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/permissions.decorator';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';
import { verifyResendSignature } from './resend.client';

/**
 * Inbound provider events, one endpoint per organisation configuration.
 *
 * `/webhooks/email/:configId` is the URL an organisation pastes into Resend.
 * Because the path names the configuration, the signing secret is looked up
 * per configuration: rotating or leaking one organisation's secret cannot be
 * used to forge events for another.
 *
 * Behaviour is chosen for the caller's benefit, which here is Resend:
 *   * Signature failures return 401 so a misconfigured secret is loud.
 *   * Anything else — unknown event type, malformed payload, our own bug —
 *     returns 200. Resend retries non-2xx, and a bug on our side must not turn
 *     into an ever-growing retry backlog. The event is recorded either way.
 */
@ApiTags('Utility')
@Controller('webhooks/email')
export class EmailWebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post(':configId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive email provider events for one organisation configuration',
    description:
      'Set this URL in your Resend dashboard. The signing secret is shown once when the ' +
      'configuration is created and can be rotated from organisation settings.',
  })
  @ApiExcludeEndpoint()
  async receive(@Param('configId') configId: string, @Req() req: Request) {
    const config = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findFirst({
        where: { id: configId, deletedAt: null },
        select: { id: true, organisationId: true, webhookSecret: true },
      }),
    );

    // Same response for an unknown configuration as for a bad signature: a
    // distinguishable 404 would let anyone probe which configuration ids exist.
    if (!config) {
      throw new AppError('invalid_api_key', 'Unknown or unauthorised webhook endpoint.');
    }

    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const result = verifyResendSignature(
      config.webhookSecret,
      {
        id: req.headers['svix-id'] as string | undefined,
        timestamp: req.headers['svix-timestamp'] as string | undefined,
        signature: req.headers['svix-signature'] as string | undefined,
      },
      rawBody,
    );

    if (!result.valid) {
      throw new AppError('invalid_api_key', 'Webhook signature verification failed.', {
        detail: result.reason,
      });
    }

    const payload = req.body as { type?: string; data?: Record<string, unknown> };

    await this.prisma.asSystem(async (tx) => {
      await tx.emailConfiguration.update({
        where: { id: config.id },
        data: { webhookLastEventAt: new Date(), webhookEventCount: { increment: 1 } },
      });

      // Parked on the outbox until the campaign module consumes it (Phase 4).
      // Recording now rather than later means events that arrive during the
      // build are not lost.
      await tx.domainEvent.create({
        data: {
          id: newId(),
          type: `email.${payload.type ?? 'unknown'}`,
          orgId: config.organisationId,
          payload: {
            configuration_id: config.id,
            provider: 'resend',
            provider_event: payload.type ?? null,
            data: (payload.data ?? {}) as object,
          },
        },
      });
    });

    return { data: { received: true } };
  }
}
