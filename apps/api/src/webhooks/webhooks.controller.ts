import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import type { Request } from 'express';

import { RequirePermission } from '../auth/permissions.decorator';
import { WebhooksService } from './webhooks.service';

class CreateWebhookDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

@ApiTags('Webhooks')
@Controller('admin/v1/workspaces/:workspaceId/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({ summary: 'List webhook endpoints' })
  async list(@Param('workspaceId') workspaceId: string) {
    const data = await this.webhooks.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({
    summary: 'Create a webhook endpoint',
    description: 'Returns the signing secret exactly once.',
  })
  async create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return { data: await this.webhooks.create(req.ctx!, workspaceId, dto) };
  }

  @Delete(':webhookId')
  @HttpCode(204)
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'webhookId' })
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  async remove(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('webhookId') webhookId: string,
  ) {
    await this.webhooks.remove(req.ctx!, workspaceId, webhookId);
  }

  @Get(':webhookId/deliveries')
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'webhookId' })
  @ApiOperation({
    summary: 'List webhook deliveries',
    description:
      'Newest first. Cursor pagination via `?cursor=` and `?limit=`. Retention is set by ' +
      '`WEBHOOK_DELIVERY_RETENTION_DAYS`; pending attempts are never purged.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Rows per page, 1–100. Default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `next_cursor` of the last page.' })
  async deliveries(
    @Param('workspaceId') workspaceId: string,
    @Param('webhookId') webhookId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.webhooks.listDeliveries(workspaceId, webhookId, { limit, cursor });
    return { data: page.items, meta: page.meta };
  }

  @Post(':webhookId/test')
  @HttpCode(200)
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'webhookId' })
  @ApiOperation({ summary: 'Queue a test webhook delivery' })
  @ApiResponse({ status: 409, description: 'The webhook is disabled.' })
  async test(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('webhookId') webhookId: string,
  ) {
    return { data: await this.webhooks.sendTest(req.ctx!, workspaceId, webhookId) };
  }

  @Post('deliveries/:deliveryId/replay')
  @HttpCode(200)
  @RequirePermission('webhook.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'deliveryId' })
  @ApiOperation({ summary: 'Replay a webhook delivery' })
  async replay(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return { data: await this.webhooks.replay(req.ctx!, workspaceId, deliveryId) };
  }
}
