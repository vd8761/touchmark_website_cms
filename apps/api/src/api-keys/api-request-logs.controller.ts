import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/permissions.decorator';
import { ApiKeysService } from './api-keys.service';

@ApiTags('API request logs')
@Controller('admin/v1/workspaces/:workspaceId/api-logs')
export class ApiRequestLogsController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get('summary')
  @RequirePermission('apilog.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp. Defaults to 24h ago.' })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp. Defaults to now.' })
  @ApiQuery({ name: 'granularity', required: false, enum: ['hour', 'day'] })
  @ApiOperation({ summary: 'Summarise Delivery API request logs' })
  async summary(
    @Param('workspaceId') workspaceId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('granularity') granularity?: string,
  ) {
    return {
      data: await this.apiKeys.requestLogSummary(workspaceId, { since, until, granularity }),
    };
  }
}
