import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request, Response } from 'express';

import { Public, RequirePermission } from '../auth/permissions.decorator';
import { AppError } from '../common/errors';
import { sniffMimeType } from './image-metadata';
import { MediaService } from './media.service';
import { StorageService } from './storage';

export class CreateUploadUrlDto {
  @ApiProperty({ example: 'hero.jpg' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  mime_type!: string;

  @ApiProperty({ example: 248_301, description: 'Checked again against the stored object on complete.' })
  @IsInt()
  @Min(1)
  size_bytes!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  folder_id?: string;
}

export class UpdateAssetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({ description: 'Screen-reader description. Empty alt text is flagged in the UI.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  alt_text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  credit?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

export class CreateFolderDto {
  @ApiProperty({ example: 'Blog images' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_id?: string;
}

/**
 * The media library (§5.3, §17.7).
 *
 * Uploads are two-step and go direct to storage: `POST /upload-url` reserves the
 * asset and returns a presigned URL, the client uploads to it, then
 * `POST /:id/complete` verifies what actually landed. The API never proxies file
 * bytes.
 */
@ApiTags('Media')
@Controller('admin/v1/workspaces/:workspaceId/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @RequirePermission('media.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiQuery({ name: 'unused', required: false, description: 'Only assets not referenced by any entry.' })
  @ApiOperation({
    summary: 'List media assets',
    description: 'Incomplete uploads are excluded — they have no bytes behind them yet.',
  })
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('folder_id') folderId?: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('unused') unused?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.media.list(workspaceId, {
      folder_id: folderId,
      search,
      type,
      unused: unused === 'true',
      limit: limit ? Number(limit) : undefined,
    });
    return { data: result.items, meta: result.meta };
  }

  @Post('upload-url')
  @RequirePermission('media.upload')
  @ApiOperation({
    summary: 'Reserve an asset and get a presigned upload URL',
    description:
      'Upload the file to `upload_url` with the given method and headers, then call ' +
      '`POST /media/{id}/complete`. The asset does not appear in the library until you do.',
  })
  @ApiResponse({ status: 413, description: 'Larger than this site’s upload limit.' })
  @ApiResponse({ status: 422, description: 'MIME type not allowed by this site.' })
  async createUploadUrl(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateUploadUrlDto,
    @Req() req: Request,
  ) {
    return { data: await this.media.createUploadUrl(req.ctx!, workspaceId, dto) };
  }

  @Post(':assetId/complete')
  @HttpCode(200)
  @RequirePermission('media.upload')
  @ApiOperation({
    summary: 'Confirm an upload finished',
    description:
      'Verifies the stored object: real size, magic-byte type check against the declared MIME ' +
      'type, and image dimensions. A file whose contents disagree with its declared type is ' +
      'deleted rather than stored — serving it would be stored XSS.',
  })
  @ApiResponse({ status: 422, description: 'Nothing was uploaded, or the contents fail the type check.' })
  async complete(
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Req() req: Request,
  ) {
    return { data: await this.media.completeUpload(req.ctx!, workspaceId, assetId) };
  }

  @Get('folders')
  @RequirePermission('media.view')
  @ApiOperation({ summary: 'List media folders' })
  async listFolders(@Param('workspaceId') workspaceId: string) {
    const data = await this.media.listFolders(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post('folders')
  @RequirePermission('media.upload')
  @ApiOperation({ summary: 'Create a folder' })
  async createFolder(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateFolderDto,
    @Req() req: Request,
  ) {
    return { data: await this.media.createFolder(req.ctx!, workspaceId, dto) };
  }

  @Delete('folders/:folderId')
  @HttpCode(204)
  @RequirePermission('media.delete')
  @ApiOperation({ summary: 'Delete an empty folder' })
  @ApiResponse({ status: 409, description: 'The folder still has files or subfolders.' })
  async deleteFolder(
    @Param('workspaceId') workspaceId: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
  ) {
    await this.media.deleteFolder(req.ctx!, workspaceId, folderId);
  }

  @Get(':assetId')
  @RequirePermission('media.view')
  @ApiOperation({ summary: 'Fetch one asset' })
  async get(@Param('workspaceId') workspaceId: string, @Param('assetId') assetId: string) {
    return { data: await this.media.get(workspaceId, assetId) };
  }

  @Patch(':assetId')
  @RequirePermission('media.upload')
  @ApiOperation({ summary: 'Update asset metadata — alt text, caption, credit, tags, folder' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Body() dto: UpdateAssetDto,
    @Req() req: Request,
  ) {
    return { data: await this.media.update(req.ctx!, workspaceId, assetId, dto) };
  }

  @Get(':assetId/usages')
  @RequirePermission('media.view')
  @ApiOperation({
    summary: 'Entries that reference this asset',
    description: 'Powers the "used in N places" warning shown before deletion.',
  })
  async usages(@Param('workspaceId') workspaceId: string, @Param('assetId') assetId: string) {
    const data = await this.media.usages(workspaceId, assetId);
    return { data, meta: { total: data.length } };
  }

  @Delete(':assetId')
  @HttpCode(204)
  @RequirePermission('media.delete')
  @ApiOperation({
    summary: 'Delete an asset',
    description:
      'Refused when the asset is still referenced, unless `force=true`. Soft delete — the object ' +
      'itself is removed by the nightly purge, so an accident is recoverable.',
  })
  @ApiResponse({ status: 409, description: 'Still used by one or more entries.' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('assetId') assetId: string,
    @Query('force') force: string,
    @Req() req: Request,
  ) {
    await this.media.remove(req.ctx!, workspaceId, assetId, force === 'true');
  }
}

/**
 * The local storage driver's stand-in for S3.
 *
 * Unauthenticated by design, exactly like a presigned S3 URL: authority comes
 * from the HMAC signature in the query string, which covers the key, the content
 * type and an expiry. Only mounted when the local driver is active — with S3
 * these routes are never reached, because the client uploads to AWS.
 */
@ApiTags('Utility')
@Controller('uploads/local')
export class LocalUploadController {
  constructor(private readonly storage: StorageService) {}

  // PUT, not POST: this stands in for a presigned S3 URL, and S3 presigns a
  // PUT. Using a different verb here would mean the client code that works
  // against local storage does not work against S3 — which is the whole point
  // of having the local driver.
  @Public()
  @Put()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async upload(@Req() req: Request, @Query() query: Record<string, string>) {
    const local = this.storage.local;
    if (!local) throw new AppError('resource_not_found', 'Not found.');

    const { key, content_type: contentType, expires, signature } = query;
    if (!key || !contentType || !expires || !signature) {
      throw new AppError('invalid_request', 'Malformed upload URL.');
    }

    if (!local.verify(key, contentType, Number(expires), signature)) {
      throw new AppError('insufficient_permission', 'This upload URL is invalid or has expired.');
    }

    await local.write(key, req);
    return { data: { stored: true } };
  }

  @Public()
  @Get('*')
  @ApiExcludeEndpoint()
  async serve(@Req() req: Request, @Res() res: Response) {
    const local = this.storage.local;
    if (!local) throw new AppError('resource_not_found', 'Not found.');

    // Express 4 exposes a wildcard segment positionally, not by name.
    const key = (req.params as Record<string, string>)['0'] ?? '';
    const stored = await local.head(key);
    if (!stored) throw new AppError('resource_not_found', 'File not found.');

    // Served from the API only in development. In production media sits behind
    // a CDN on a separate cookieless domain (§18.2), which is why this sets
    // nosniff and an attachment-safe disposition rather than trusting the type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // nosniff without a Content-Type is a refusal to render: the browser is told
    // not to guess and given nothing to go on, so an <img> pointing here stays
    // blank. The type comes from the object's own magic bytes rather than from
    // the request or the filename — `complete` already deleted anything whose
    // contents disagreed with its declared type, so this cannot be talked into
    // labelling markup as an image.
    const head = await this.readHead(local, key);
    res.setHeader('Content-Type', sniffMimeType(head) ?? 'application/octet-stream');

    const stream = await local.read(key);
    stream.pipe(res);
  }

  /** First bytes of an object — enough for magic-byte detection, whatever its size. */
  private async readHead(
    local: NonNullable<StorageService['local']>,
    key: string,
    bytes = 64,
  ): Promise<Buffer> {
    const stream = await local.read(key);
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= bytes) break;
    }
    stream.destroy();

    return Buffer.concat(chunks).subarray(0, bytes);
  }
}
