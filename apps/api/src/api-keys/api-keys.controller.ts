import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RequirePermission } from '../auth/permissions.decorator';
import { ApiKeysService } from './api-keys.service';
import {
  CreateApiKeyDto,
  RevokeApiKeyDto,
  RotateApiKeyDto,
  UpdateApiKeyDto,
} from './dto/api-key.dto';

@ApiTags('API keys')
@Controller('admin/v1/workspaces/:workspaceId/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @RequirePermission('apikey.manage')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({
    summary: 'List API keys',
    description: 'Secrets are never returned. The plaintext key is shown only once on creation.',
  })
  async list(@Param('workspaceId') workspaceId: string) {
    const data = await this.apiKeys.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  @RequirePermission('apikey.manage')
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'Creates a publishable or secret key. Only the SHA-256 hash is stored; the plaintext is ' +
      'included in this response and never returned again.',
  })
  @ApiResponse({ status: 422, description: 'A publishable key requested a server-only scope.' })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request,
  ) {
    return { data: await this.apiKeys.create(req.ctx!, workspaceId, dto) };
  }

  @Patch(':keyId')
  @RequirePermission('apikey.manage')
  @ApiOperation({
    summary: 'Update an API key',
    description: 'Updates non-secret API key settings and invalidates the key auth cache.',
  })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
    @Body() dto: UpdateApiKeyDto,
    @Req() req: Request,
  ) {
    return { data: await this.apiKeys.update(req.ctx!, workspaceId, keyId, dto) };
  }

  @Post(':keyId/rotate')
  @HttpCode(200)
  @RequirePermission('apikey.manage')
  @ApiOperation({
    summary: 'Rotate an API key',
    description:
      'Creates a replacement key and keeps the old key usable only through the selected grace window.',
  })
  async rotate(
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
    @Body() dto: RotateApiKeyDto,
    @Req() req: Request,
  ) {
    return { data: await this.apiKeys.rotate(req.ctx!, workspaceId, keyId, dto) };
  }

  @Get(':keyId/request-logs')
  @RequirePermission('apilog.view')
  @ApiOperation({
    summary: 'List API key request logs',
    description:
      'Delivery API requests recorded for this key, newest first. Cursor pagination via ' +
      '`?cursor=` and `?limit=`. Retention is set by `API_REQUEST_LOG_RETENTION_DAYS`.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Rows per page, 1–100. Default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `next_cursor` of the last page.' })
  async logs(
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.apiKeys.listRequestLogs(workspaceId, keyId, { limit, cursor });
    return { data: page.items, meta: page.meta };
  }

  @Post(':keyId/revoke')
  @HttpCode(200)
  @RequirePermission('apikey.manage')
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Revocation is synchronous: the key stops authenticating immediately.',
  })
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
    @Body() dto: RevokeApiKeyDto,
    @Req() req: Request,
  ) {
    return { data: await this.apiKeys.revoke(req.ctx!, workspaceId, keyId, dto) };
  }
}
