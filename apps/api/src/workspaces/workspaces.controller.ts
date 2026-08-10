import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RequireOrgPermission, RequirePermission } from '../auth/permissions.decorator';
import { PrismaService } from '../common/prisma.service';
import {
  AddWorkspaceMemberDto,
  CreateWorkspaceDto,
  DeleteWorkspaceDto,
  UpdateWorkspaceDto,
  UpdateWorkspaceMemberDto,
} from './dto/workspace.dto';
import { WorkspacesService } from './workspaces.service';

/**
 * Workspaces nested under their organisation, so `:orgId` resolves the org
 * scope and org-level permissions apply (creating a site is an org action).
 */
@ApiTags('Workspaces')
@Controller('admin/v1/orgs/:orgId/workspaces')
export class OrgWorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @RequireOrgPermission('org.view')
  @ApiParam({ name: 'orgId' })
  @ApiOperation({
    summary: 'List sites in an organisation',
    description:
      'Organisation Owners and Admins see every site. Everyone else sees only sites they hold ' +
      'a membership in. Labelled "Sites" in the UI, `workspaces` in the API (§2.1).',
  })
  async list(@Param('orgId') orgId: string, @Req() req: Request) {
    const data = await this.workspaces.list(req.ctx!, orgId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  @RequireOrgPermission('org.workspace.create')
  @ApiOperation({
    summary: 'Create a site',
    description:
      'Provisions defaults, adds you as Site Admin, and emits `workspace.created`. The chosen ' +
      'starter content model is recorded on the event; provisioning its types and sample ' +
      'entries lands with the content module.',
  })
  @ApiResponse({ status: 201, description: 'Site created.' })
  async create(@Param('orgId') orgId: string, @Body() dto: CreateWorkspaceDto, @Req() req: Request) {
    return { data: await this.workspaces.create(req.ctx!, orgId, dto) };
  }
}

/**
 * Everything scoped to one site. The `:workspaceId` parameter is what
 * RequestContextGuard reads to establish the tenant boundary — §3.4 layer 1.
 */
@ApiTags('Workspaces')
@Controller('admin/v1/workspaces/:workspaceId')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('workspace.view')
  @ApiParam({ name: 'workspaceId' })
  @ApiOperation({ summary: 'Fetch one site' })
  @ApiResponse({ status: 404, description: 'No such site, or you have no access to it.' })
  async get(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return { data: await this.workspaces.get(req.ctx!, workspaceId) };
  }

  @Patch()
  @RequirePermission('workspace.settings.edit')
  @ApiOperation({
    summary: 'Update site settings',
    description: 'Site Admin only. An archived site rejects this — archived sites are read-only.',
  })
  @ApiResponse({ status: 422, description: 'Locale change would orphan the default locale.' })
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
    @Req() req: Request,
  ) {
    return { data: await this.workspaces.update(req.ctx!, workspaceId, dto) };
  }

  @Post('archive')
  @HttpCode(200)
  @RequirePermission('workspace.settings.edit')
  @ApiOperation({
    summary: 'Archive a site',
    description:
      'The site becomes read-only and its API keys stop working (`403 workspace_archived`). ' +
      'Content is retained and the action is reversible. All organisation Owners are emailed.',
  })
  async archive(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    await this.workspaces.archive(req.ctx!, workspaceId);
    return { data: { status: 'archived' } };
  }

  @Post('restore')
  @HttpCode(200)
  @RequireOrgPermission('org.workspace.create')
  @ApiOperation({
    summary: 'Restore an archived or pending-deletion site',
    description:
      'Restoring is an organisation-level action: an archived site grants no write permissions, ' +
      'so a Site Admin cannot un-archive their own site.',
  })
  async restore(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    await this.workspaces.restore(req.ctx!, workspaceId);
    return { data: { status: 'active' } };
  }

  @Delete()
  @HttpCode(202)
  @RequireOrgPermission('org.workspace.create')
  @ApiOperation({
    summary: 'Delete a site',
    description:
      'Requires typing the site name, and requires organisation Owner or Admin in addition to ' +
      'Site Admin. Enters a 30-day window during which `POST /restore` still works; after that ' +
      'the data and its object storage are permanently purged.',
  })
  @ApiResponse({ status: 400, description: 'The confirmation name does not match.' })
  @ApiResponse({ status: 403, description: 'Requires an organisation Owner or Admin.' })
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: DeleteWorkspaceDto,
    @Req() req: Request,
  ) {
    await this.workspaces.scheduleDeletion(req.ctx!, workspaceId, dto.confirm_name);
    return { data: { status: 'pending_deletion' } };
  }

  // -- Members ---------------------------------------------------------------

  @Get('members')
  @RequirePermission('workspace.view')
  @ApiOperation({
    summary: 'List site members',
    description:
      'Includes organisation Owners and Admins, who hold Site Admin implicitly and are ' +
      'returned with `inherited: true` — they have no membership row to remove.',
  })
  async members(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    const data = await this.workspaces.listMembers(req.ctx!, workspaceId);
    return { data, meta: { total: data.length } };
  }

  @Post('members')
  @RequirePermission('workspace.member.manage')
  @ApiOperation({
    summary: 'Grant someone a role on this site',
    description: 'The user must already be a member of the organisation.',
  })
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
    @Req() req: Request,
  ) {
    await this.workspaces.addMember(req.ctx!, workspaceId, dto.user_id, dto.role);
    return { data: { user_id: dto.user_id, role: dto.role } };
  }

  @Patch('members/:userId')
  @RequirePermission('workspace.member.manage')
  @ApiOperation({ summary: 'Change a site member’s role' })
  async updateMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateWorkspaceMemberDto,
    @Req() req: Request,
  ) {
    await this.workspaces.addMember(req.ctx!, workspaceId, userId, dto.role);
    return { data: { user_id: userId, role: dto.role } };
  }

  @Delete('members/:userId')
  @HttpCode(204)
  @RequirePermission('workspace.member.manage')
  @ApiOperation({
    summary: 'Remove someone from this site',
    description:
      'Removes the membership row only. Someone who is an organisation Owner or Admin keeps ' +
      'implicit Site Admin — change their organisation role to revoke that.',
  })
  async removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.workspaces.removeMember(req.ctx!, workspaceId, userId);
  }

  @Get('audit-logs')
  @RequirePermission('auditlog.view')
  @ApiOperation({ summary: 'This site’s audit log', description: 'Append-only, newest first.' })
  async auditLogs(@Param('workspaceId') workspaceId: string) {
    const rows = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.auditLog.findMany({
        where: { workspaceId },
        orderBy: { occurredAt: 'desc' },
        take: 50,
      }),
    );

    return {
      data: rows.map((r) => ({
        id: r.id,
        actor_type: r.actorType,
        actor_id: r.actorId,
        action: r.action,
        resource_type: r.resourceType,
        resource_id: r.resourceId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        request_id: r.requestId,
        occurred_at: r.occurredAt.toISOString(),
      })),
      meta: { total: rows.length, limit: 50, has_more: rows.length === 50 },
    };
  }
}
