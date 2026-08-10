import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORKSPACE_ROLES, type WorkspaceRole } from '@cms/shared';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The starter content models of §6.2. Provisioning lands in Phase 1. */
export const STARTER_MODELS = ['marketing', 'blog', 'saas', 'docs', 'blank'] as const;
export type StarterModel = (typeof STARTER_MODELS)[number];

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Marketing Site', description: 'Shown as the site name in the switcher.' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'marketing', description: 'Derived from the name when omitted.' })
  @IsOptional()
  @Matches(SLUG_PATTERN, { message: 'Use lowercase letters, numbers and hyphens only.' })
  @MaxLength(60)
  slug?: string;

  @ApiPropertyOptional({
    example: 'https://acme.com',
    description: 'Informational only — the live site URL is never verified or fetched.',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  primary_url?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata', default: 'UTC' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ example: 'en', default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  default_locale?: string;

  @ApiPropertyOptional({ example: '#4F46E5', description: 'Chip colour in the site switcher.' })
  @IsOptional()
  @Matches(HEX_COLOUR, { message: 'Use a hex colour such as #4F46E5.' })
  colour?: string;

  @ApiPropertyOptional({ enum: STARTER_MODELS, default: 'blank' })
  @IsOptional()
  @IsIn(STARTER_MODELS)
  starter_model?: StarterModel;
}

export class UpdateWorkspaceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(HEX_COLOUR)
  colour?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  primary_url?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  default_locale?: string;

  @ApiPropertyOptional({ type: [String], example: ['en', 'de'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  locales?: string[];
}

export class AddWorkspaceMemberDto {
  @ApiProperty({ description: 'A user who is already a member of this organisation.' })
  @IsUUID()
  user_id!: string;

  @ApiProperty({ enum: WORKSPACE_ROLES })
  @IsIn(WORKSPACE_ROLES)
  role!: WorkspaceRole;
}

export class UpdateWorkspaceMemberDto {
  @ApiProperty({ enum: WORKSPACE_ROLES })
  @IsIn(WORKSPACE_ROLES)
  role!: WorkspaceRole;
}

export class DeleteWorkspaceDto {
  @ApiProperty({
    description:
      'The exact site name, typed to confirm. §6.3 requires this for an irreversible action.',
    example: 'Marketing Site',
  })
  @IsString()
  confirm_name!: string;

  @ApiPropertyOptional({
    description: 'Reserved for support-led immediate purges. Ignored for normal callers.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skip_grace_period?: boolean;
}
