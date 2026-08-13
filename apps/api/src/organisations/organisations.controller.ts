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
import type { Request } from 'express';

import { toAuditLogDto } from '../audit/audit-log.dto';
import { pageArgs, parseLimit, toPage } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { RequireOrgPermission } from '../auth/permissions.decorator';
import {
  CreateOrganisationDto,
  InviteMemberDto,
  TransferOwnershipDto,
  UpdateMemberRoleDto,
  UpdateOrganisationDto,
} from './dto/organisation.dto';
import { OrganisationsService } from './organisations.service';

/**
 * `/admin/v1/orgs` — §14.5.
 *
 * The `:orgId` path parameter is what RequestContextGuard resolves the
 * organisation scope from, which is why every route below can rely on
 * `req.ctx.orgRole` already being correct.
 */
@ApiTags('Organisations')
@Controller('admin/v1/orgs')
export class OrganisationsController {
  constructor(
    private readonly orgs: OrganisationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the organisations you belong to',
    description: 'Ordered by when you joined. Use `GET /auth/me` instead when booting the portal.',
  })
  async list(@Req() req: Request) {
    const memberships = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findMany({
        where: { userId: req.ctx!.userId },
        include: { organisation: true },
        orderBy: { joinedAt: 'asc' },
      }),
    );

    return {
      data: memberships.map((m) => ({
        id: m.organisation.id,
        name: m.organisation.name,
        slug: m.organisation.slug,
        logo_url: m.organisation.logoUrl,
        plan: m.organisation.plan,
        status: m.organisation.status,
        role: m.role,
        created_at: m.organisation.createdAt.toISOString(),
      })),
      meta: { total: memberships.length },
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Create an organisation',
    description:
      'You become its first Owner. Available to any signed-in user only while the platform ' +
      'has no owner or admin anywhere — the bootstrap case. After that it requires an ' +
      'existing owner or admin, and everyone else joins an organisation by invitation.',
  })
  @ApiResponse({ status: 201, description: 'Organisation created.' })
  @ApiResponse({ status: 403, description: 'The caller is not an organisation owner or admin.' })
  async create(@Body() dto: CreateOrganisationDto, @Req() req: Request) {
    return { data: await this.orgs.create(req.ctx!, dto) };
  }

  @Get(':orgId')
  @RequireOrgPermission('org.view')
  @ApiParam({ name: 'orgId', description: 'Organisation id.' })
  @ApiOperation({ summary: 'Fetch one organisation' })
  async get(@Param('orgId') orgId: string, @Req() req: Request) {
    const org = await this.prisma.asSystem((tx) =>
      tx.organisation.findUniqueOrThrow({ where: { id: orgId } }),
    );
    return {
      data: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo_url: org.logoUrl,
        plan: org.plan,
        status: org.status,
        role: req.ctx!.orgRole,
        created_at: org.createdAt.toISOString(),
      },
    };
  }

  @Patch(':orgId')
  @RequireOrgPermission('org.settings.edit')
  @ApiOperation({ summary: 'Update organisation details' })
  async update(
    @Param('orgId') orgId: string,
    @Body() dto: UpdateOrganisationDto,
    @Req() req: Request,
  ) {
    return { data: await this.orgs.update(req.ctx!, orgId, dto) };
  }

  // -- Members ---------------------------------------------------------------

  @Get(':orgId/members')
  @RequireOrgPermission('org.view')
  @ApiOperation({
    summary: 'List members and outstanding invitations',
    description:
      'Invited-but-not-yet-joined people are returned alongside active members with ' +
      '`status: "invited"`, so the members table needs only one request.',
  })
  async members(@Param('orgId') orgId: string) {
    const data = await this.orgs.listMembers(orgId);
    return { data, meta: { total: data.length } };
  }

  @Post(':orgId/invitations')
  @RequireOrgPermission('org.member.manage')
  @ApiOperation({
    summary: 'Invite someone to the organisation',
    description:
      'Sends a signed link valid for 7 days. Per-site roles can be granted in the same call ' +
      'and are applied when the invitation is accepted. Only an Owner may invite an Owner.',
  })
  @ApiResponse({ status: 201, description: 'Invitation sent.' })
  @ApiResponse({ status: 409, description: 'Already a member.' })
  async invite(@Param('orgId') orgId: string, @Body() dto: InviteMemberDto, @Req() req: Request) {
    return { data: await this.orgs.invite(req.ctx!, orgId, dto) };
  }

  @Post(':orgId/invitations/:id/resend')
  @HttpCode(202)
  @RequireOrgPermission('org.member.manage')
  @ApiOperation({
    summary: 'Resend an invitation',
    description: 'Rate limited to once per hour. Issues a fresh token; the old link stops working.',
  })
  @ApiResponse({ status: 429, description: 'Sent too recently.' })
  async resend(@Param('orgId') orgId: string, @Param('id') id: string, @Req() req: Request) {
    await this.orgs.resendInvitation(req.ctx!, orgId, id);
    return { data: { sent: true } };
  }

  @Delete(':orgId/invitations/:id')
  @HttpCode(204)
  @RequireOrgPermission('org.member.manage')
  @ApiOperation({ summary: 'Revoke an outstanding invitation' })
  async revoke(@Param('orgId') orgId: string, @Param('id') id: string, @Req() req: Request) {
    await this.orgs.revokeInvitation(req.ctx!, orgId, id);
  }

  @Patch(':orgId/members/:userId')
  @RequireOrgPermission('org.member.manage')
  @ApiOperation({
    summary: 'Change a member’s organisation role',
    description: 'The last Owner cannot be demoted — promote someone else first.',
  })
  @ApiResponse({ status: 422, description: 'Would leave the organisation without an Owner.' })
  async changeRole(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: Request,
  ) {
    await this.orgs.changeMemberRole(req.ctx!, orgId, userId, dto.role);
    return { data: { user_id: userId, role: dto.role } };
  }

  @Delete(':orgId/members/:userId')
  @HttpCode(204)
  @RequireOrgPermission('org.member.manage')
  @ApiOperation({
    summary: 'Remove a member',
    description:
      'Cascades to every site membership in this organisation and revokes their sessions ' +
      'immediately. The last Owner cannot be removed.',
  })
  async remove(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.orgs.removeMember(req.ctx!, orgId, userId);
  }

  @Post(':orgId/transfer-ownership')
  @HttpCode(200)
  @RequireOrgPermission('org.ownership.transfer')
  @ApiOperation({
    summary: 'Transfer ownership to another member',
    description:
      'Name the new Owner by `email` (or `user_id`); they must already be a member of the ' +
      'organisation. The current Owner becomes an Admin rather than losing access entirely. ' +
      'Both parties are emailed.',
  })
  @ApiResponse({ status: 400, description: 'Not a member, or the typed confirmation did not match.' })
  async transfer(
    @Param('orgId') orgId: string,
    @Body() dto: TransferOwnershipDto,
    @Req() req: Request,
  ) {
    const owner = await this.orgs.transferOwnership(req.ctx!, orgId, dto);
    return { data: { owner_id: owner.user_id, owner_email: owner.email } };
  }

  @Get(':orgId/audit-logs')
  @RequireOrgPermission('org.auditlog.view')
  @ApiOperation({
    summary: 'Organisation audit log',
    description: 'Append-only. Newest first. Cursor pagination via `?cursor=` and `?limit=`.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Rows per page, 1–100. Default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `next_cursor` of the last page.' })
  async auditLogs(
    @Param('orgId') orgId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const take = parseLimit(limit);
    const where = { organisationId: orgId };

    const [rows, total] = await this.prisma.asSystem((tx) =>
      Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          ...pageArgs(take, cursor),
        }),
        tx.auditLog.count({ where }),
      ]),
    );

    const page = toPage(rows, take, total);
    return { data: page.items.map(toAuditLogDto), meta: page.meta };
  }
}

/** Invitation acceptance is not under `/orgs/:orgId` — the invitee is not a member yet. */
@ApiTags('Organisations')
@Controller('admin/v1/invitations')
export class InvitationsController {
  constructor(private readonly orgs: OrganisationsService) {}

  @Post(':token/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Requires being signed in as the invited address. Creates the org membership and any ' +
      'per-site grants attached to the invitation.',
  })
  @ApiResponse({ status: 400, description: 'Expired, revoked, or already accepted.' })
  @ApiResponse({ status: 403, description: 'Signed in as a different address.' })
  async accept(@Param('token') token: string, @Req() req: Request) {
    return { data: await this.orgs.acceptInvitation(req.ctx!, token) };
  }
}
