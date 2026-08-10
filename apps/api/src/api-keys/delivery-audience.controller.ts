import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { Request, Response } from 'express';

import { Public } from '../auth/permissions.decorator';
import { ApiKeyGuard, RequireApiScope } from './api-key-auth.guard';
import { DeliveryAudienceService } from './delivery-audience.service';

class SubscriberDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  list_api_ids?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;
}

class SubscriberPatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  first_name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string | null;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  list_api_ids?: string[];
}

class SubmitFormDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

@ApiTags('Delivery')
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard)
@ApiSecurity('deliveryApiKey')
export class DeliveryAudienceController {
  constructor(private readonly audience: DeliveryAudienceService) {}

  @Post('subscribers')
  @RequireApiScope('subscriber.write')
  @ApiOperation({ summary: 'Create or update a subscriber' })
  async upsertSubscriber(@Req() req: Request, @Body() dto: SubscriberDto) {
    return { data: await this.audience.upsertSubscriber(req.apiKey!, dto) };
  }

  @Get('subscribers/:email')
  @RequireApiScope('subscriber.read')
  @ApiParam({ name: 'email', description: 'URL-encoded email address.' })
  @ApiOperation({ summary: 'Fetch one subscriber by email' })
  async getSubscriber(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('email') email: string,
  ) {
    noStore(res);
    return { data: await this.audience.getSubscriberByEmail(req.apiKey!, email) };
  }

  @Patch('subscribers/:email')
  @RequireApiScope('subscriber.write')
  @ApiParam({ name: 'email', description: 'URL-encoded email address.' })
  @ApiOperation({ summary: 'Update one subscriber by email' })
  async updateSubscriber(
    @Req() req: Request,
    @Param('email') email: string,
    @Body() dto: SubscriberPatchDto,
  ) {
    return { data: await this.audience.updateSubscriber(req.apiKey!, email, dto) };
  }

  @Post('subscribers/:email/unsubscribe')
  @HttpCode(200)
  @RequireApiScope('subscriber.write')
  @ApiParam({ name: 'email', description: 'URL-encoded email address.' })
  @ApiOperation({ summary: 'Unsubscribe one email address' })
  async unsubscribe(@Req() req: Request, @Param('email') email: string) {
    return { data: await this.audience.unsubscribe(req.apiKey!, email) };
  }

  @Get('lists')
  @RequireApiScope('subscriber.read')
  @ApiOperation({ summary: 'List subscriber lists' })
  async listLists(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    const data = await this.audience.listLists(req.apiKey!);
    return { data, meta: { total: data.length } };
  }

  @Post('forms/:apiId/submit')
  @RequireApiScope('form.submit')
  @ApiParam({ name: 'apiId', description: 'Form API ID.' })
  @ApiOperation({ summary: 'Submit a public form' })
  async submitForm(
    @Req() req: Request,
    @Param('apiId') apiId: string,
    @Body() dto: SubmitFormDto,
  ) {
    return {
      data: await this.audience.submitForm(req.apiKey!, apiId, dto, {
        ip: req.ip ?? null,
        userAgent: headerValue(req.headers['user-agent']),
        referrer: headerValue(req.headers.referer ?? req.headers.referrer),
      }),
    };
  }

  @Get('forms/:apiId')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'apiId', description: 'Form API ID.' })
  @ApiOperation({ summary: 'Fetch one public form schema' })
  async getForm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('apiId') apiId: string,
  ) {
    return cached(res, { data: await this.audience.getForm(req.apiKey!, apiId) });
  }
}

function cached<T extends object>(res: Response, body: T): T {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('ETag', weakEtag(body));
  return body;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}

function weakEtag(value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('base64url');
  return `W/"${hash.slice(0, 24)}"`;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
