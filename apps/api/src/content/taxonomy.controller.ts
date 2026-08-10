import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';

import { RequirePermission } from '../auth/permissions.decorator';
import { MenusService } from './menus.service';
import { TaxonomiesService } from './taxonomies.service';

// -- DTOs --------------------------------------------------------------------

export class CreateTaxonomyDto {
  @ApiProperty({ example: 'Category' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: 'category', description: 'Derived from the name when omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  api_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ default: false, description: 'Allows terms to nest under one another.' })
  @IsOptional()
  @IsBoolean()
  is_hierarchical?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Content type ids this applies to; empty means all.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applies_to?: string[];
}

export class CreateTermDto {
  @ApiProperty({ example: 'Engineering' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ description: 'Derived from the name when omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Only valid on a hierarchical taxonomy.' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;
}

export class UpdateTermDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  position?: number;
}

export class MergeTermDto {
  @ApiProperty({ description: 'The term to merge into. Must be in the same taxonomy.' })
  @IsUUID()
  target_id!: string;
}

export class CreateMenuDto {
  @ApiProperty({ example: 'Main navigation' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: 'main_navigation' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  api_id?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}

export class MenuItemDto {
  @ApiProperty({ example: 'About us' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @ApiProperty({ enum: ['entry', 'url', 'term', 'none'] })
  @IsIn(['entry', 'url', 'term', 'none'])
  link_type!: 'entry' | 'url' | 'term' | 'none';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  entry_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  term_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string | null;

  @ApiPropertyOptional({ enum: ['_self', '_blank'], default: '_self' })
  @IsOptional()
  @IsIn(['_self', '_blank'])
  target?: '_self' | '_blank';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @ApiPropertyOptional({ type: () => [MenuItemDto], description: 'Up to three levels deep.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MenuItemDto)
  children?: MenuItemDto[];
}

export class ReplaceMenuItemsDto {
  @ApiProperty({ type: [MenuItemDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MenuItemDto)
  items!: MenuItemDto[];
}

// -- Controllers -------------------------------------------------------------

@ApiTags('Taxonomies')
@Controller('admin/v1/workspaces/:workspaceId/taxonomies')
export class TaxonomiesController {
  constructor(private readonly taxonomies: TaxonomiesService) {}

  @Get()
  @RequirePermission('taxonomy.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({ summary: 'List taxonomies with their term counts' })
  async list(@Param('workspaceId') workspaceId: string) {
    const data = await this.taxonomies.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  @RequirePermission('taxonomy.manage')
  @ApiOperation({
    summary: 'Create a taxonomy',
    description: 'The api_id appears in Delivery API URLs and must be unique within the site.',
  })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateTaxonomyDto,
    @Req() req: Request,
  ) {
    return { data: await this.taxonomies.create(req.ctx!, workspaceId, dto) };
  }

  @Delete(':taxonomyId')
  @HttpCode(204)
  @RequirePermission('taxonomy.manage')
  @ApiOperation({ summary: 'Delete a taxonomy and its terms' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('taxonomyId') taxonomyId: string,
    @Req() req: Request,
  ) {
    await this.taxonomies.remove(req.ctx!, workspaceId, taxonomyId);
  }

  @Get(':taxonomyId/terms')
  @RequirePermission('taxonomy.view')
  @ApiOperation({
    summary: 'List terms',
    description:
      'Returned as a nested tree for a hierarchical taxonomy and a flat list for a flat one, so ' +
      'the client does not have to reassemble it.',
  })
  async listTerms(
    @Param('workspaceId') workspaceId: string,
    @Param('taxonomyId') taxonomyId: string,
  ) {
    const data = await this.taxonomies.listTerms(workspaceId, taxonomyId);
    return { data, meta: { total: data.length } };
  }

  @Post(':taxonomyId/terms')
  @RequirePermission('taxonomy.manage')
  @ApiOperation({ summary: 'Create a term' })
  @ApiResponse({ status: 422, description: 'Tried to nest a term in a flat taxonomy.' })
  async createTerm(
    @Param('workspaceId') workspaceId: string,
    @Param('taxonomyId') taxonomyId: string,
    @Body() dto: CreateTermDto,
    @Req() req: Request,
  ) {
    return { data: await this.taxonomies.createTerm(req.ctx!, workspaceId, taxonomyId, dto) };
  }
}

@ApiTags('Taxonomies')
@Controller('admin/v1/workspaces/:workspaceId/terms')
export class TermsController {
  constructor(private readonly taxonomies: TaxonomiesService) {}

  @Patch(':termId')
  @RequirePermission('taxonomy.manage')
  @ApiOperation({ summary: 'Rename or reorder a term' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('termId') termId: string,
    @Body() dto: UpdateTermDto,
    @Req() req: Request,
  ) {
    return { data: await this.taxonomies.updateTerm(req.ctx!, workspaceId, termId, dto) };
  }

  @Delete(':termId')
  @HttpCode(204)
  @RequirePermission('taxonomy.manage')
  @ApiOperation({
    summary: 'Delete a term',
    description: 'Refused while it has children — deleting a whole branch by mis-click is too easy.',
  })
  @ApiResponse({ status: 409, description: 'The term has child terms.' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('termId') termId: string,
    @Req() req: Request,
  ) {
    await this.taxonomies.removeTerm(req.ctx!, workspaceId, termId);
  }

  @Post(':termId/merge')
  @HttpCode(200)
  @RequirePermission('taxonomy.manage')
  @ApiOperation({
    summary: 'Merge this term into another',
    description:
      'Reassigns every entry to the target term, re-parents any children, then deletes this one. ' +
      'Useful for cleaning up near-duplicates after an import.',
  })
  async merge(
    @Param('workspaceId') workspaceId: string,
    @Param('termId') termId: string,
    @Body() dto: MergeTermDto,
    @Req() req: Request,
  ) {
    return { data: await this.taxonomies.mergeTerm(req.ctx!, workspaceId, termId, dto.target_id) };
  }
}

@ApiTags('Menus')
@Controller('admin/v1/workspaces/:workspaceId/menus')
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @Get()
  @RequirePermission('taxonomy.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({ summary: 'List menus' })
  async list(@Param('workspaceId') workspaceId: string) {
    const data = await this.menus.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Get(':menuId')
  @RequirePermission('taxonomy.view')
  @ApiOperation({
    summary: 'Fetch one menu as a nested tree',
    description: 'The same shape `GET /v1/menus/{api_id}` will return on the Delivery API.',
  })
  async get(@Param('workspaceId') workspaceId: string, @Param('menuId') menuId: string) {
    return { data: await this.menus.get(workspaceId, menuId) };
  }

  @Post()
  @RequirePermission('menu.manage')
  @ApiOperation({ summary: 'Create a menu' })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateMenuDto,
    @Req() req: Request,
  ) {
    return { data: await this.menus.create(req.ctx!, workspaceId, dto) };
  }

  @Post(':menuId/items')
  @HttpCode(200)
  @RequirePermission('menu.manage')
  @ApiOperation({
    summary: 'Replace a menu’s items',
    description:
      'Atomic whole-tree replace rather than per-item edits, so the menu is never observed ' +
      'half-rebuilt. Entry and term references are verified against this site first. Maximum ' +
      'three levels deep.',
  })
  @ApiResponse({ status: 400, description: 'A referenced entry or term does not exist.' })
  @ApiResponse({ status: 422, description: 'Nested deeper than three levels.' })
  async replaceItems(
    @Param('workspaceId') workspaceId: string,
    @Param('menuId') menuId: string,
    @Body() dto: ReplaceMenuItemsDto,
    @Req() req: Request,
  ) {
    return { data: await this.menus.replaceItems(req.ctx!, workspaceId, menuId, dto.items) };
  }

  @Delete(':menuId')
  @HttpCode(204)
  @RequirePermission('menu.manage')
  @ApiOperation({ summary: 'Delete a menu' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('menuId') menuId: string,
    @Req() req: Request,
  ) {
    await this.menus.remove(req.ctx!, workspaceId, menuId);
  }
}
