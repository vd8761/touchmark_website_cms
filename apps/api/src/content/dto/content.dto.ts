import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const FIELD_TYPES = [
  'text',
  'long_text',
  'rich_text',
  'markdown',
  'number',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'enum',
  'multi_enum',
  'slug',
  'url',
  'email',
  'colour',
  'json',
  'media',
  'media_list',
  'relation_one',
  'relation_many',
  'geo',
  'code',
] as const;

export const ENTRY_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'scheduled',
  'published',
  'archived',
] as const;

export class CreateContentTypeDto {
  @ApiProperty({ example: 'Blog Post' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    example: 'blog_post',
    description:
      'Singular snake_case. Derived from the name when omitted. **Immutable after creation** — ' +
      'it appears in every Delivery API URL.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  api_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    enum: ['collection', 'single'],
    default: 'collection',
    description: 'A single has exactly one entry — a Homepage, an About page.',
  })
  @IsOptional()
  @IsIn(['collection', 'single'])
  kind?: 'collection' | 'single';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_localised?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enable_versioning?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enable_scheduling?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Require review before an entry can publish.' })
  @IsOptional()
  @IsBoolean()
  require_review?: boolean;
}

export class UpdateContentTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_localised?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enable_versioning?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enable_scheduling?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  require_review?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class DeleteContentTypeDto {
  @ApiPropertyOptional({ description: 'Required when the type still has entries.' })
  @IsOptional()
  @IsString()
  confirm_name?: string;

  @ApiPropertyOptional({ description: 'Must be true to delete a type that still has entries.' })
  @IsOptional()
  @IsBoolean()
  delete_entries?: boolean;
}

export class CreateFieldDto {
  @ApiProperty({ example: 'Hero Image' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: 'hero_image', description: 'snake_case. Immutable after creation.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  api_id?: string;

  @ApiProperty({ enum: FIELD_TYPES })
  @IsIn(FIELD_TYPES)
  type!: (typeof FIELD_TYPES)[number];

  @ApiPropertyOptional({
    default: false,
    description:
      'Adding a required field marks every existing entry incomplete and blocks re-publishing ' +
      'until it is filled. The already-published version stays live.',
  })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  unique_value?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  localised?: boolean;

  @ApiPropertyOptional({ description: 'Supplying a default avoids marking existing entries incomplete.' })
  @IsOptional()
  default_value?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  help_text?: string;

  @ApiPropertyOptional({ description: 'min, max, minLength, maxLength, regex, allowedValues, minItems, maxItems.' })
  @IsOptional()
  @IsObject()
  validation?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Type-specific: enum options, relation target, media constraints.' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  group?: string;
}

export class UpdateFieldDto extends CreateFieldDto {
  @ApiPropertyOptional({ enum: FIELD_TYPES, description: 'Only safe widenings are permitted.' })
  @IsOptional()
  @IsIn(FIELD_TYPES)
  declare type: (typeof FIELD_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  declare name: string;
}

export class ReorderFieldsDto {
  @ApiProperty({ type: [String], description: 'Every field id, in the order they should appear.' })
  @IsArray()
  @IsUUID('all', { each: true })
  field_ids!: string[];
}

export class CreateEntryDto {
  @ApiPropertyOptional({ description: 'Derived from the title field when omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @ApiPropertyOptional({ description: 'Field values, keyed by field api_id.' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'title, description, og_image, canonical, no_index.' })
  @IsOptional()
  @IsObject()
  seo?: Record<string, unknown>;
}

export class UpdateEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({
    description: 'Merged into the existing values — omitted fields are left untouched.',
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  seo?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Shown in the version history.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  change_note?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Marks this as an editor autosave. Autosaves amend the author’s current working snapshot ' +
      'instead of adding a new one, so a few minutes of typing does not evict the version ' +
      'history. An explicit save always commits its own restore point.',
  })
  @IsOptional()
  @IsBoolean()
  autosave?: boolean;

  @ApiPropertyOptional({
    description:
      'The version you loaded. Supplying it turns a concurrent overwrite into a 409 instead of ' +
      'silently discarding the other editor’s work.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expected_version?: number;
}

export class PublishEntryDto {
  @ApiPropertyOptional({
    description: 'Publish at this time instead of now. Must be in the future.',
    example: '2026-09-01T09:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduled_at?: string;

  @ApiPropertyOptional({ description: 'Automatically unpublish at this time.' })
  @IsOptional()
  @IsISO8601()
  unpublish_at?: string;
}

export class RestoreVersionDto {
  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  version!: number;
}
