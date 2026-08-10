import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { EntryStatus } from '@prisma/client';
import type { Request } from 'express';

import { RequirePermission } from '../auth/permissions.decorator';
import { ContentTypesService } from './content-types.service';
import {
  CreateContentTypeDto,
  CreateEntryDto,
  CreateFieldDto,
  DeleteContentTypeDto,
  PublishEntryDto,
  ReorderFieldsDto,
  RestoreVersionDto,
  UpdateContentTypeDto,
  UpdateEntryDto,
  UpdateFieldDto,
} from './dto/content.dto';
import { EntriesService } from './entries.service';

/** The content type builder (§7.1, §17.6). Site Admin only. */
@ApiTags('Content types')
@Controller('admin/v1/workspaces/:workspaceId/content-types')
export class ContentTypesController {
  constructor(private readonly types: ContentTypesService) {}

  @Get()
  @RequirePermission('content.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({
    summary: 'List content types with their fields',
    description: 'Ordered as they appear in the sidebar. Includes an entry count per type.',
  })
  async list(@Param('workspaceId') workspaceId: string) {
    const data = await this.types.list(workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Get(':typeId')
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Fetch one content type',
    description: 'Accepts either the id or the api_id, since both appear in URLs.',
  })
  async get(@Param('workspaceId') workspaceId: string, @Param('typeId') typeId: string) {
    return { data: await this.types.get(workspaceId, typeId) };
  }

  @Post()
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Create a content type',
    description:
      'The api_id is permanent — it appears in every Delivery API URL, so it cannot be renamed ' +
      'later without breaking every consumer.',
  })
  @ApiResponse({ status: 409, description: 'That api_id is already in use.' })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateContentTypeDto,
    @Req() req: Request,
  ) {
    return { data: await this.types.create(req.ctx!, workspaceId, dto) };
  }

  @Patch(':typeId')
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Update a content type',
    description: 'Bumps schema_version, which consumers can watch to detect drift.',
  })
  @ApiResponse({ status: 422, description: 'Attempted to change the immutable api_id.' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: UpdateContentTypeDto,
    @Req() req: Request,
  ) {
    return { data: await this.types.update(req.ctx!, workspaceId, typeId, { ...dto }) };
  }

  @Delete(':typeId')
  @HttpCode(204)
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Delete a content type',
    description:
      'Blocked while entries exist unless `delete_entries` is set and `confirm_name` matches the ' +
      'type name exactly.',
  })
  @ApiResponse({ status: 409, description: 'Entries exist and deletion was not confirmed.' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: DeleteContentTypeDto,
    @Req() req: Request,
  ) {
    await this.types.remove(req.ctx!, workspaceId, typeId, dto);
  }

  // -- Fields ----------------------------------------------------------------

  @Post(':typeId/fields')
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Add a field',
    description:
      'Adding an optional field is always safe. Adding a required field without a default marks ' +
      'existing entries incomplete — the response reports how many.',
  })
  async addField(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: CreateFieldDto,
    @Req() req: Request,
  ) {
    return { data: await this.types.addField(req.ctx!, workspaceId, typeId, dto) };
  }

  @Patch(':typeId/fields/:fieldId')
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Update a field',
    description:
      'The api_id cannot change. Field types may only widen safely (text→long_text, ' +
      'number→decimal); anything else is refused with the safe alternatives listed.',
  })
  @ApiResponse({ status: 422, description: 'Unsafe type change or an api_id change.' })
  async updateField(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Param('fieldId') fieldId: string,
    @Body() dto: UpdateFieldDto,
    @Req() req: Request,
  ) {
    return { data: await this.types.updateField(req.ctx!, workspaceId, typeId, fieldId, { ...dto }) };
  }

  @Get(':typeId/fields/:fieldId/impact')
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'How many entries would a field change affect',
    description:
      'Powers the pre-delete check of §17.6 — "24 of 142 entries have a value in this field" — ' +
      'so the consequence is visible before the decision.',
  })
  async impact(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Param('fieldId') fieldId: string,
  ) {
    return { data: await this.types.fieldImpact(workspaceId, typeId, fieldId) };
  }

  @Post(':typeId/fields/:fieldId/deprecate')
  @HttpCode(200)
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Deprecate a field (the recommended first step of deletion)',
    description:
      'The field disappears from the editor but keeps being served by the Delivery API, so ' +
      'consumers can migrate before the value actually goes away.',
  })
  async deprecateField(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Param('fieldId') fieldId: string,
    @Req() req: Request,
  ) {
    return { data: await this.types.deprecateField(req.ctx!, workspaceId, typeId, fieldId) };
  }

  @Delete(':typeId/fields/:fieldId')
  @HttpCode(204)
  @RequirePermission('contenttype.manage')
  @ApiOperation({
    summary: 'Delete a field permanently',
    description:
      'Refused unless the field was deprecated first, or `force` is passed. This is the change ' +
      'most likely to break a live site.',
  })
  @ApiResponse({ status: 409, description: 'Field has not been deprecated.' })
  async deleteField(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Param('fieldId') fieldId: string,
    @Query('force') force: string,
    @Req() req: Request,
  ) {
    await this.types.deleteField(req.ctx!, workspaceId, typeId, fieldId, { force: force === 'true' });
  }

  @Post(':typeId/fields/reorder')
  @HttpCode(200)
  @RequirePermission('contenttype.manage')
  @ApiOperation({ summary: 'Reorder the fields of a content type' })
  async reorder(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: ReorderFieldsDto,
    @Req() req: Request,
  ) {
    await this.types.reorderFields(req.ctx!, workspaceId, typeId, dto.field_ids);
    return { data: { reordered: dto.field_ids.length } };
  }
}

/** Entries — the content list (§17.4) and the entry editor (§17.5). */
@ApiTags('Content')
@Controller('admin/v1/workspaces/:workspaceId/content')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get(':typeId')
  @RequirePermission('content.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiParam({ name: 'typeId', description: 'Content type id or api_id.' })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'in_review', 'scheduled', 'published', 'archived'] })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 25, maximum 100.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'From meta.next_cursor of the previous page.' })
  @ApiQuery({ name: 'sort', required: false, description: 'e.g. `-published_at,slug`. Leading `-` is descending.' })
  @ApiOperation({
    summary: 'List entries of a content type',
    description: 'Cursor-paginated (§14.1). Ordered by last update unless `sort` says otherwise.',
  })
  async list(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Query('status') status?: EntryStatus,
    @Query('locale') locale?: string,
    @Query('search') search?: string,
    @Query('author_id') authorId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
  ) {
    const result = await this.entries.list(workspaceId, typeId, {
      status,
      locale,
      search,
      author_id: authorId,
      limit: limit ? Number(limit) : undefined,
      cursor,
      sort,
    });
    return { data: result.items, meta: result.meta };
  }

  @Post(':typeId')
  @RequirePermission('content.create')
  @ApiOperation({
    summary: 'Create an entry',
    description:
      'Saved as a draft with relaxed validation — required fields may be empty, so a ' +
      'half-finished draft is never lost. Publishing applies the strict pass.',
  })
  @ApiResponse({ status: 409, description: 'A single content type already has its entry.' })
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: CreateEntryDto,
    @Req() req: Request,
  ) {
    return { data: await this.entries.create(req.ctx!, workspaceId, typeId, dto) };
  }

  @Get('entries/:entryId')
  @RequirePermission('content.view')
  @ApiOperation({ summary: 'Fetch one entry' })
  async get(@Param('workspaceId') workspaceId: string, @Param('entryId') entryId: string) {
    return { data: await this.entries.get(workspaceId, entryId) };
  }

  @Patch('entries/:entryId')
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Update an entry',
    description:
      '`data` is merged, not replaced, so a collapsed field group is not wiped by saving. Pass ' +
      '`expected_version` to turn a concurrent overwrite into a 409 rather than silent data loss. ' +
      'Authors may only edit their own entries.',
  })
  @ApiResponse({ status: 409, description: 'Version conflict, or another user holds the edit lock.' })
  @ApiResponse({ status: 400, description: 'Field validation failed; see error.fields[].' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateEntryDto,
    @Req() req: Request,
  ) {
    return { data: await this.entries.update(req.ctx!, workspaceId, entryId, dto) };
  }

  @Delete('entries/:entryId')
  @HttpCode(204)
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Delete an entry',
    description: 'Soft delete. Authors may delete only their own drafts.',
  })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    await this.entries.remove(req.ctx!, workspaceId, entryId);
  }

  @Post('entries/:entryId/publish')
  @HttpCode(200)
  @RequirePermission('content.publish')
  @ApiOperation({
    summary: 'Publish or schedule an entry',
    description:
      'Applies strict validation first: every required field must be present. With ' +
      '`scheduled_at` the entry becomes `scheduled` and is published by the scheduler.',
  })
  @ApiResponse({ status: 422, description: 'Required fields missing, or review is required.' })
  async publish(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Body() dto: PublishEntryDto,
    @Req() req: Request,
  ) {
    return { data: await this.entries.publish(req.ctx!, workspaceId, entryId, dto) };
  }

  @Post('entries/:entryId/unpublish')
  @HttpCode(200)
  @RequirePermission('content.publish')
  @ApiOperation({
    summary: 'Take an entry off the live site',
    description: 'Returns it to draft. The published version number is retained for history.',
  })
  async unpublish(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    return { data: await this.entries.unpublish(req.ctx!, workspaceId, entryId) };
  }

  @Post('entries/:entryId/archive')
  @HttpCode(200)
  @RequirePermission('content.publish')
  @ApiOperation({ summary: 'Archive an entry' })
  async archive(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    return { data: await this.entries.archive(req.ctx!, workspaceId, entryId) };
  }

  @Get('entries/:entryId/versions')
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Version history',
    description:
      'Newest first. The last 50 versions are kept, plus every version that was ever published — ' +
      'those are never pruned.',
  })
  async versions(@Param('workspaceId') workspaceId: string, @Param('entryId') entryId: string) {
    const data = await this.entries.listVersions(workspaceId, entryId);
    return { data, meta: { total: data.length } };
  }

  @Post('entries/:entryId/versions/restore')
  @HttpCode(200)
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Restore an earlier version',
    description:
      'Writes the old content as a new version rather than rewinding, so history stays ' +
      'append-only and the restore is itself auditable.',
  })
  async restore(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Body() dto: RestoreVersionDto,
    @Req() req: Request,
  ) {
    return { data: await this.entries.restoreVersion(req.ctx!, workspaceId, entryId, dto.version) };
  }

  @Post('entries/:entryId/lock')
  @HttpCode(200)
  @RequirePermission('content.view')
  @ApiOperation({
    summary: 'Take the edit lock',
    description: 'Soft lock, expiring 10 minutes after the holder stops editing.',
  })
  @ApiResponse({ status: 409, description: 'Someone else holds an unexpired lock.' })
  async lock(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    return { data: await this.entries.acquireLock(req.ctx!, workspaceId, entryId) };
  }

  @Delete('entries/:entryId/lock')
  @HttpCode(204)
  @RequirePermission('content.view')
  @ApiOperation({ summary: 'Release the edit lock' })
  async unlock(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
  ) {
    await this.entries.releaseLock(req.ctx!, workspaceId, entryId);
  }
}
