import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';

const PREVIEW_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class PreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async createToken(ctx: RequestContext, workspaceId: string, entryId: string) {
    const entry = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findFirst({
        where: { id: entryId, workspaceId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!entry) throw notFound('Entry', entryId);

    const token = `pv_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);

    await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.previewToken.create({
        data: {
          id: newId(),
          workspaceId,
          entryId,
          tokenHash: hashPreviewToken(token),
          expiresAt,
          createdBy: ctx.userId,
        },
      }),
    );

    return {
      token,
      preview_url: `/v1/preview/${token}`,
      expires_at: expiresAt.toISOString(),
    };
  }

  async resolve(token: string) {
    const now = new Date();
    const preview = await this.prisma.asSystem(async (tx) => {
      const row = await tx.previewToken.findUnique({
        where: { tokenHash: hashPreviewToken(token) },
        include: {
          entry: { include: { contentType: true } },
          workspace: { select: { id: true, status: true, deletedAt: true, organisation: { select: { status: true, deletedAt: true } } } },
        },
      });

      if (
        !row ||
        row.expiresAt.getTime() <= now.getTime() ||
        row.workspace.deletedAt ||
        row.workspace.status !== 'active' ||
        row.workspace.organisation.deletedAt ||
        row.workspace.organisation.status === 'suspended' ||
        row.entry.deletedAt
      ) {
        return null;
      }

      await tx.previewToken.update({ where: { id: row.id }, data: { usedAt: now } });
      return row;
    });

    if (!preview) throw notFound('Preview token');

    return {
      id: preview.entry.id,
      type: preview.entry.contentType.apiId,
      slug: preview.entry.slug,
      locale: preview.entry.locale,
      status: preview.entry.status,
      data: preview.entry.data,
      seo: preview.entry.seo,
      preview: true,
      schema_version: preview.entry.contentType.schemaVersion,
      updated_at: preview.entry.updatedAt.toISOString(),
      expires_at: preview.expiresAt.toISOString(),
    };
  }
}

function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
