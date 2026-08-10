import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RequireOrgPermission, RequirePermission } from '../auth/permissions.decorator';
import { PrismaService } from '../common/prisma.service';
import {
  CreateEmailConfigurationDto,
  CreateSenderIdentityDto,
  SelectEmailConfigurationDto,
  UpdateEmailConfigurationDto,
} from './dto/email-config.dto';
import { EmailConfigService } from './email-config.service';
import { SenderIdentityService } from './sender-identity.service';

/**
 * Organisation-level provider configuration.
 *
 * An organisation may hold several: one Resend account per brand, per region,
 * or a separate one for testing. Each carries its own credentials and its own
 * inbound webhook.
 */
@ApiTags('Email')
@Controller('admin/v1/orgs/:orgId/email-configurations')
export class EmailConfigurationsController {
  constructor(
    private readonly configs: EmailConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequireOrgPermission('org.email.manage')
  @ApiParam({ name: 'orgId' })
  @ApiOperation({
    summary: 'List this organisation’s email configurations',
    description:
      'API keys are never returned — only the last four characters, for identification. ' +
      'Each entry reports its verified sending domains and recent webhook activity.',
  })
  async list(@Param('orgId') orgId: string) {
    const data = await this.configs.list(orgId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  @RequireOrgPermission('org.email.manage')
  @ApiOperation({
    summary: 'Add an email configuration',
    description:
      'The API key is verified against Resend before anything is saved, then encrypted at ' +
      'rest. The response includes the webhook URL and signing secret — **the secret is shown ' +
      'once and never again**, so store it before closing the dialog.',
  })
  @ApiResponse({ status: 201, description: 'Configuration created and verified.' })
  @ApiResponse({ status: 422, description: 'Resend rejected the API key.' })
  @ApiResponse({ status: 503, description: 'Resend was unreachable; nothing was saved.' })
  async create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateEmailConfigurationDto,
    @Req() req: Request,
  ) {
    const config = await this.configs.create(req.ctx!, orgId, dto);

    // The one-time reveal. Read straight from the row rather than returned by
    // the service, so the secret cannot leak into any other response shape.
    const secret = await this.prisma.asSystem((tx) =>
      tx.emailConfiguration.findUniqueOrThrow({
        where: { id: config.id },
        select: { webhookSecret: true },
      }),
    );

    return {
      data: {
        ...config,
        webhook_signing_secret: secret.webhookSecret,
        webhook_secret_notice:
          'Copy this into your Resend webhook settings now. It is not shown again.',
      },
    };
  }

  @Patch(':configId')
  @RequireOrgPermission('org.email.manage')
  @ApiOperation({
    summary: 'Rename, rotate the key for, or disable a configuration',
    description: 'A replacement API key is verified before it takes effect.',
  })
  async update(
    @Param('orgId') orgId: string,
    @Param('configId') configId: string,
    @Body() dto: UpdateEmailConfigurationDto,
    @Req() req: Request,
  ) {
    return { data: await this.configs.update(req.ctx!, orgId, configId, dto) };
  }

  @Post(':configId/refresh')
  @HttpCode(200)
  @RequireOrgPermission('org.email.manage')
  @ApiOperation({
    summary: 'Re-check the key and refresh verified domains',
    description:
      'Call this after verifying a new domain in Resend. Also marks the configuration invalid ' +
      'if the key has since been revoked, so the UI can explain why sending stopped.',
  })
  async refresh(@Param('orgId') orgId: string, @Param('configId') configId: string) {
    return { data: await this.configs.refresh(orgId, configId) };
  }

  @Delete(':configId')
  @HttpCode(204)
  @RequireOrgPermission('org.email.manage')
  @ApiOperation({
    summary: 'Delete a configuration',
    description:
      'Refused while any site still sends through it — detach those sites first, so losing the ' +
      'ability to send is a decision rather than a surprise.',
  })
  @ApiResponse({ status: 409, description: 'Still attached to one or more sites.' })
  async remove(
    @Param('orgId') orgId: string,
    @Param('configId') configId: string,
    @Req() req: Request,
  ) {
    await this.configs.remove(req.ctx!, orgId, configId);
  }
}

/**
 * The workspace half: choose one of the organisation's configurations, then add
 * the from-addresses this site sends as.
 */
@ApiTags('Email')
@Controller('admin/v1/workspaces/:workspaceId/email')
export class WorkspaceEmailController {
  constructor(private readonly senders: SenderIdentityService) {}

  @Get('configurations')
  @RequirePermission('workspace.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({
    summary: 'Email configurations this site can choose from',
    description:
      'The dropdown for Site settings → Email. Each option lists the domains it can send from, ' +
      'so an unusable configuration is visible before it is selected.',
  })
  async configurations(@Param('workspaceId') workspaceId: string) {
    const data = await this.senders.availableConfigurations(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Patch('configuration')
  @RequirePermission('senderidentity.manage')
  @ApiOperation({
    summary: 'Select the email configuration for this site',
    description:
      'Site Admin only. Switching to a different configuration removes this site’s existing ' +
      'from-addresses: they belong to the previous provider account and would not send.',
  })
  @ApiResponse({ status: 404, description: 'No such configuration in this organisation.' })
  async selectConfiguration(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SelectEmailConfigurationDto,
    @Req() req: Request,
  ) {
    await this.senders.selectConfiguration(req.ctx!, workspaceId, dto.email_configuration_id);
    return { data: { email_configuration_id: dto.email_configuration_id } };
  }

  @Get('senders')
  @RequirePermission('workspace.view')
  @ApiOperation({ summary: 'From-addresses configured for this site' })
  async listSenders(@Param('workspaceId') workspaceId: string) {
    const data = await this.senders.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post('senders')
  @RequirePermission('senderidentity.manage')
  @ApiOperation({
    summary: 'Add a from-address',
    description:
      'The address’s domain must be verified in the selected configuration; this is checked ' +
      'against Resend’s domain list rather than assumed. The first address added becomes the ' +
      'site’s preferred sender automatically.',
  })
  @ApiResponse({ status: 422, description: 'Domain not verified, or no configuration selected.' })
  async createSender(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateSenderIdentityDto,
    @Req() req: Request,
  ) {
    return { data: await this.senders.create(req.ctx!, workspaceId, dto) };
  }

  @Post('senders/:id/default')
  @HttpCode(200)
  @RequirePermission('senderidentity.manage')
  @ApiOperation({ summary: 'Set the site’s preferred from-address' })
  async setDefault(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.senders.setDefault(req.ctx!, workspaceId, id);
    return { data: { default_sender_identity_id: id } };
  }

  @Delete('senders/:id')
  @HttpCode(204)
  @RequirePermission('senderidentity.manage')
  @ApiOperation({ summary: 'Remove a from-address' })
  async removeSender(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.senders.remove(req.ctx!, workspaceId, id);
  }
}
