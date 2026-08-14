import { createHash } from 'node:crypto';

import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../auth/permissions.decorator';
import { ApiKeyGuard, RequireApiScope } from './api-key-auth.guard';
import {
  DeliveryContentService,
  type DeliveryEntryFilters,
  type DeliveryEntryQuery,
} from './delivery-content.service';

@ApiTags('Delivery')
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard)
@ApiSecurity('deliveryApiKey')
export class DeliveryContentController {
  constructor(private readonly delivery: DeliveryContentService) {}

  @Get('content-types')
  @RequireApiScope('content.read')
  @ApiOperation({ summary: 'List Delivery content types' })
  async listContentTypes(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const data = await this.delivery.listContentTypes(req.apiKey!);
    return cached(res, { data, meta: { total: data.length } });
  }

  @Get('content-types/:apiId')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'apiId', description: 'Content type API ID.' })
  @ApiOperation({ summary: 'Fetch one Delivery content type schema' })
  async getContentType(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('apiId') apiId: string,
  ) {
    return cached(res, { data: await this.delivery.getContentType(req.apiKey!, apiId) });
  }

  @Get('content/id/:id')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'id', description: 'Entry ID.' })
  @ApiQuery({ name: 'expand', required: false, description: 'Comma-separated relation or media fields to resolve inline, e.g. `data.author,data.hero_image`. One level deep.' })
  @ApiOperation({ summary: 'Fetch a published entry by ID' })
  async getEntryById(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return cached(res, {
      data: await this.delivery.getEntryById(req.apiKey!, id, parseEntryQuery(query)),
    });
  }

  @Get('search')
  @RequireApiScope('search.read')
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'type', required: false, enum: ['all', 'content', 'media'] })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 25, maximum 50.' })
  @ApiOperation({ summary: 'Search published content and media' })
  async search(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('q') q?: string,
    @Query('type') type?: 'all' | 'content' | 'media',
    @Query('limit') limit?: string,
  ) {
    const result = await this.delivery.search(req.apiKey!, {
      q,
      type,
      limit: limit ? Number(limit) : undefined,
    });
    return cached(res, { data: result.items, meta: result.meta });
  }

  @Get('content/:type')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'type', description: 'Content type API ID.' })
  @ApiQuery({ name: 'locale', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 25, maximum 100.' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, description: 'e.g. `-published_at,slug`.' })
  @ApiQuery({ name: 'expand', required: false, description: 'Comma-separated relation or media fields to resolve inline, e.g. `data.author,data.hero_image`. One level deep.' })
  @ApiOperation({ summary: 'List published entries for a content type' })
  async listEntries(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('type') type: string,
    @Query() query: Record<string, unknown>,
  ) {
    const result = await this.delivery.listEntries(req.apiKey!, type, parseEntryQuery(query));
    return cached(res, { data: result.items, meta: result.meta });
  }

  @Get('content/:type/:slug/related')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'type', description: 'Content type API ID.' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'locale', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 10, maximum 50.' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, description: 'e.g. `-published_at,slug`.' })
  @ApiQuery({ name: 'expand', required: false, description: 'Comma-separated relation or media fields to resolve inline, e.g. `data.author,data.hero_image`. One level deep.' })
  @ApiOperation({ summary: 'List published entries related by shared taxonomy terms' })
  async listRelatedEntries(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ) {
    const result = await this.delivery.listRelatedEntries(
      req.apiKey!,
      type,
      slug,
      parseEntryQuery(query),
    );
    return cached(res, { data: result.items, meta: result.meta });
  }

  @Get('content/:type/:slug')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'type', description: 'Content type API ID.' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'locale', required: false })
  @ApiQuery({ name: 'expand', required: false, description: 'Comma-separated relation or media fields to resolve inline, e.g. `data.author,data.hero_image`. One level deep.' })
  @ApiOperation({ summary: 'Fetch a published entry by slug' })
  async getEntryBySlug(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ) {
    return cached(res, {
      data: await this.delivery.getEntryBySlug(req.apiKey!, type, slug, parseEntryQuery(query)),
    });
  }

  @Get('taxonomies')
  @RequireApiScope('content.read')
  @ApiOperation({ summary: 'List Delivery taxonomies' })
  async listTaxonomies(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const data = await this.delivery.listTaxonomies(req.apiKey!);
    return cached(res, { data, meta: { total: data.length } });
  }

  @Get('taxonomies/:apiId/terms')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'apiId', description: 'Taxonomy API ID.' })
  @ApiOperation({ summary: 'List Delivery taxonomy terms' })
  async listTaxonomyTerms(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('apiId') apiId: string,
  ) {
    const result = await this.delivery.listTaxonomyTerms(req.apiKey!, apiId);
    return cached(res, { data: result.items, meta: { total: result.total } });
  }

  @Get('menus')
  @RequireApiScope('content.read')
  @ApiOperation({ summary: 'List Delivery menus' })
  async listMenus(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const data = await this.delivery.listMenus(req.apiKey!);
    return cached(res, { data, meta: { total: data.length } });
  }

  @Get('menus/:apiId')
  @RequireApiScope('content.read')
  @ApiParam({ name: 'apiId', description: 'Menu API ID.' })
  @ApiQuery({ name: 'locale', required: false })
  @ApiOperation({ summary: 'Fetch one Delivery menu as a resolved nested tree' })
  async getMenu(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('apiId') apiId: string,
    @Query('locale') locale?: string,
  ) {
    return cached(res, { data: await this.delivery.getMenu(req.apiKey!, apiId, locale) });
  }

  @Get('media')
  @RequireApiScope('media.read')
  @ApiQuery({ name: 'folder_id', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'type', required: false, description: 'MIME type prefix, e.g. `image/`.' })
  @ApiQuery({ name: 'tag', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, maximum 100.' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOperation({ summary: 'List Delivery media assets' })
  async listMedia(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('folder_id') folderId?: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const result = await this.delivery.listMedia(req.apiKey!, {
      folder_id: folderId,
      search,
      type,
      tag,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
    return cached(res, { data: result.items, meta: result.meta });
  }

  @Get('media/:id')
  @RequireApiScope('media.read')
  @ApiParam({ name: 'id', description: 'Media asset ID.' })
  @ApiOperation({ summary: 'Fetch one Delivery media asset' })
  async getMedia(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ) {
    return cached(res, { data: await this.delivery.getMedia(req.apiKey!, id) });
  }
}

function cached<T extends object>(res: Response, body: T): T {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.setHeader('ETag', weakEtag(body));
  return body;
}

function weakEtag(value: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('base64url');
  return `W/"${hash.slice(0, 24)}"`;
}

function parseEntryQuery(query: Record<string, unknown>): DeliveryEntryQuery {
  return {
    locale: stringParam(query.locale),
    limit: numberParam(query.limit),
    cursor: stringParam(query.cursor),
    sort: stringParam(query.sort),
    fields: stringParam(query.fields),
    expand: stringParam(query.expand),
    localeFallback: stringParam(query.locale_fallback) !== 'false',
    filters: parseFilters(query),
  };
}

function parseFilters(query: Record<string, unknown>): DeliveryEntryFilters | undefined {
  const filters: DeliveryEntryFilters = {};
  const nested = query.filter;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    filters.status = stringParam(record.status);
    filters.slug = stringParam(record.slug);
    filters.locale = stringParam(record.locale);
    filters.published_at_gte = stringParam((record.published_at as Record<string, unknown>)?.gte);
    filters.published_at_lte = stringParam((record.published_at as Record<string, unknown>)?.lte);
    filters.updated_at_gte = stringParam((record.updated_at as Record<string, unknown>)?.gte);
    filters.updated_at_lte = stringParam((record.updated_at as Record<string, unknown>)?.lte);
    if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
      filters.data = Object.fromEntries(
        Object.entries(record.data as Record<string, unknown>)
          .map(([key, value]) => [key, stringParam(value)])
          .filter((entry): entry is [string, string] => !!entry[1]),
      );
    }
    for (const [key, value] of Object.entries(record)) {
      const raw = stringParam(value);
      if (raw) assignFilter(filters, key, raw);
    }
  }

  for (const [key, value] of Object.entries(query)) {
    const raw = stringParam(value);
    if (!raw) continue;
    const simple = /^filter\[([^\]]+)\]$/.exec(key);
    if (simple) {
      assignFilter(filters, simple[1], raw);
      continue;
    }
    const nestedKey = /^filter\[([^\]]+)\]\[([^\]]+)\]$/.exec(key);
    if (nestedKey) assignNestedFilter(filters, nestedKey[1], nestedKey[2], raw);
  }

  if (
    !filters.status &&
    !filters.slug &&
    !filters.locale &&
    !filters.published_at_gte &&
    !filters.published_at_lte &&
    !filters.updated_at_gte &&
    !filters.updated_at_lte &&
    !Object.keys(filters.data ?? {}).length
  ) {
    return undefined;
  }
  return filters;
}

function assignFilter(filters: DeliveryEntryFilters, key: string, value: string): void {
  if (key === 'status') filters.status = value;
  else if (key === 'slug') filters.slug = value;
  else if (key === 'locale') filters.locale = value;
  else if (key === 'published_at.gte') filters.published_at_gte = value;
  else if (key === 'published_at.lte') filters.published_at_lte = value;
  else if (key === 'updated_at.gte') filters.updated_at_gte = value;
  else if (key === 'updated_at.lte') filters.updated_at_lte = value;
  else if (key.startsWith('data.')) {
    filters.data = { ...(filters.data ?? {}), [key.slice('data.'.length)]: value };
  }
}

function assignNestedFilter(
  filters: DeliveryEntryFilters,
  key: string,
  operator: string,
  value: string,
): void {
  if (key === 'published_at' && operator === 'gte') filters.published_at_gte = value;
  else if (key === 'published_at' && operator === 'lte') filters.published_at_lte = value;
  else if (key === 'updated_at' && operator === 'gte') filters.updated_at_gte = value;
  else if (key === 'updated_at' && operator === 'lte') filters.updated_at_lte = value;
  else if (key === 'data') filters.data = { ...(filters.data ?? {}), [operator]: value };
}

function stringParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringParam(value[0]);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberParam(value: unknown): number | undefined {
  const raw = stringParam(value);
  if (!raw) return undefined;
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}
