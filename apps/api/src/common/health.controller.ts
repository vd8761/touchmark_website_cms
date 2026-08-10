import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/permissions.decorator';
import { PrismaService } from './prisma.service';

@ApiTags('Utility')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('v1/health')
  @ApiOperation({
    summary: 'Liveness and dependency check',
    description:
      'Unauthenticated (§14.4). Reports `ok` only when the database is reachable — a process ' +
      'that is running but cannot serve a request should not be kept in the load balancer.',
  })
  async health() {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unavailable';
    }

    return {
      data: {
        status: database === 'ok' ? 'ok' : 'degraded',
        database,
        version: process.env.npm_package_version ?? '0.1.0',
        time: new Date().toISOString(),
      },
    };
  }
}
