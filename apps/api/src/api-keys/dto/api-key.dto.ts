import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { API_KEY_SCOPES, type ApiKeyScope } from '../api-key-scopes';

export const API_KEY_ROTATION_GRACE_PERIODS = ['immediate', '1h', '24h', '7d'] as const;
export type ApiKeyRotationGracePeriod = (typeof API_KEY_ROTATION_GRACE_PERIODS)[number];

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Website production' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ enum: ['publishable', 'secret'] })
  @IsIn(['publishable', 'secret'])
  type!: 'publishable' | 'secret';

  @ApiPropertyOptional({ enum: ['live', 'test'], default: 'live' })
  @IsOptional()
  @IsIn(['live', 'test'])
  environment?: 'live' | 'test';

  @ApiProperty({ enum: API_KEY_SCOPES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes!: ApiKeyScope[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Required for publishable keys. Exact origins, e.g. https://example.com.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowed_origins?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Secret-key IP restrictions. Exact IPv4/IPv6 addresses or IPv4 CIDRs.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowed_ips?: string[];

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601()
  expires_at?: string;

  @ApiPropertyOptional({
    example: 300,
    minimum: 1,
    maximum: 60000,
    description: 'Optional per-key override. Defaults depend on key type.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60000)
  rate_limit_per_minute?: number;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ example: 'Website production' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: API_KEY_SCOPES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes?: ApiKeyScope[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowed_origins?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  allowed_ips?: string[];

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601()
  expires_at?: string;

  @ApiPropertyOptional({
    example: 300,
    minimum: 1,
    maximum: 60000,
    description: 'Optional per-key override. Defaults depend on key type.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60000)
  rate_limit_per_minute?: number;
}

export class RotateApiKeyDto {
  @ApiPropertyOptional({ enum: API_KEY_ROTATION_GRACE_PERIODS, default: '24h' })
  @IsOptional()
  @IsIn(API_KEY_ROTATION_GRACE_PERIODS)
  grace_period?: ApiKeyRotationGracePeriod;

  @ApiPropertyOptional({
    example: 'Website production replacement',
    description: 'Name for the replacement key. A unique rotation name is generated when omitted.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

export class RevokeApiKeyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
