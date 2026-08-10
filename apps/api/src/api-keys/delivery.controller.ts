import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/permissions.decorator';
import { ApiKeyGuard } from './api-key-auth.guard';

@ApiTags('Delivery')
@Controller('v1')
export class DeliveryController {
  @Get('me')
  @Public()
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('deliveryApiKey')
  @ApiOperation({
    summary: 'Inspect the current API key',
    description: 'Unauthenticated by session; authenticated by API key. Any valid key may call it.',
  })
  async me(@Req() req: Request) {
    const key = req.apiKey!;
    return {
      data: {
        api_key: {
          id: key.id,
          name: key.name,
          type: key.type,
          environment: key.environment,
          scopes: key.scopes,
        },
        workspace: {
          id: key.workspaceId,
          organisation_id: key.organisationId,
          status: key.workspaceStatus,
        },
        limits: key.limits,
      },
    };
  }
}
