import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { RequirePermission } from '../auth/permissions.decorator';
import { Public } from '../auth/permissions.decorator';
import { PreviewService } from './preview.service';

@ApiTags('Content')
@Controller('admin/v1/workspaces/:workspaceId/content/entries/:entryId/preview-token')
export class AdminPreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Post()
  @RequirePermission('content.edit')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'entryId' })
  @ApiOperation({ summary: 'Mint a short-lived entry preview token' })
  async create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
  ) {
    return { data: await this.preview.createToken(req.ctx!, workspaceId, entryId) };
  }
}

@ApiTags('Delivery')
@Public()
@Controller('v1/preview')
export class DeliveryPreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Get(':token')
  @ApiParam({ name: 'token' })
  @ApiOperation({ summary: 'Resolve a short-lived entry preview token' })
  async resolve(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    return { data: await this.preview.resolve(token) };
  }
}
