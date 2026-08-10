import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { newId } from '../common/uuid';
import { EventsService } from '../events/events.service';
import { looksLikeMarkup, readImageDimensions, sniffMimeType } from './image-metadata';
import { StorageService } from './storage';

/** Defaults; a workspace can narrow them in Site settings → Media (§6.5). */
const DEFAULT_MAX_UPLOAD_MB = 25;
const ALLOWED_MIME = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'text/plain',
  'text/csv',
];

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  /**
   * Step one of the direct-to-storage upload (§4.2): reserve the row, hand back
   * a presigned URL. The asset is invisible in the library until `complete` is
   * called, so an abandoned upload never appears as a broken thumbnail.
   */
  async createUploadUrl(
    ctx: RequestContext,
    workspaceId: string,
    input: { filename: string; mime_type: string; size_bytes: number; folder_id?: string },
  ) {
    const settings = await this.workspaceSettings(workspaceId);

    if (!settings.allowedMime.includes(input.mime_type)) {
      throw new AppError('unprocessable', `${input.mime_type} files are not allowed.`, {
        detail: `This site accepts: ${settings.allowedMime.join(', ')}.`,
      });
    }

    if (input.size_bytes > settings.maxBytes) {
      throw new AppError('payload_too_large', 'That file is too large.', {
        detail: `The limit for this site is ${Math.round(settings.maxBytes / 1024 / 1024)}MB; that file is ${Math.round(input.size_bytes / 1024 / 1024)}MB.`,
      });
    }

    if (input.folder_id) await this.requireFolder(workspaceId, input.folder_id);

    const assetId = newId();
    const key = StorageService.keyFor(workspaceId, assetId, input.filename);

    const asset = await this.prisma.asSystem((tx) =>
      tx.mediaAsset.create({
        data: {
          id: assetId,
          workspaceId,
          folderId: input.folder_id ?? null,
          filename: input.filename,
          storageKey: key,
          mimeType: input.mime_type,
          sizeBytes: BigInt(input.size_bytes),
          uploadedBy: ctx.userId,
          // uploadedAt stays null until the client confirms; see `complete`.
        },
      }),
    );

    const upload = await this.storage.presignUpload(key, input.mime_type);

    return {
      asset_id: asset.id,
      upload_url: upload.url,
      method: upload.method,
      headers: upload.headers,
      expires_in: upload.expiresIn,
      storage_driver: this.storage.name,
    };
  }

  /**
   * Step two: the client says the upload finished. Everything here is verified
   * against the stored bytes rather than trusted from the request — the client
   * has just written directly to storage, so its claims about what it wrote are
   * exactly what must not be believed.
   */
  async completeUpload(ctx: RequestContext, workspaceId: string, assetId: string) {
    const asset = await this.requireAsset(workspaceId, assetId, { includeIncomplete: true });

    if (asset.uploadedAt) {
      throw conflict('That upload has already been completed.');
    }

    const stored = await this.storage.head(asset.storageKey);
    if (!stored) {
      throw new AppError('unprocessable', 'No file was uploaded.', {
        detail: 'The presigned URL may have expired before the upload finished. Try again.',
      });
    }

    const settings = await this.workspaceSettings(workspaceId);
    if (stored.sizeBytes > settings.maxBytes) {
      // The client under-reported the size to get a URL, then uploaded more.
      await this.storage.delete(asset.storageKey).catch(() => undefined);
      await this.prisma.asSystem((tx) => tx.mediaAsset.delete({ where: { id: assetId } }));

      throw new AppError('payload_too_large', 'The uploaded file exceeds the size limit.', {
        detail: 'It has been discarded.',
      });
    }

    // Read only the head of the object: enough for magic bytes and dimensions,
    // and constant regardless of how large the file is.
    const head = await this.readHead(asset.storageKey, 64 * 1024);
    const sniffed = sniffMimeType(head);

    // §18.2: uploads are MIME-sniffed. A file claiming to be a PNG but
    // containing markup becomes stored XSS the moment a browser opens it.
    if (looksLikeMarkup(head) && !asset.mimeType.startsWith('text/')) {
      await this.storage.delete(asset.storageKey).catch(() => undefined);
      await this.prisma.asSystem((tx) => tx.mediaAsset.delete({ where: { id: assetId } }));

      throw new AppError('unprocessable', 'That file contains markup and was rejected.', {
        detail:
          `It was uploaded as ${asset.mimeType} but its contents look like HTML. Serving it ` +
          'would let it run scripts in your visitors’ browsers.',
      });
    }

    if (sniffed && sniffed !== asset.mimeType) {
      await this.storage.delete(asset.storageKey).catch(() => undefined);
      await this.prisma.asSystem((tx) => tx.mediaAsset.delete({ where: { id: assetId } }));

      throw new AppError('unprocessable', 'The file does not match its declared type.', {
        detail: `It was uploaded as ${asset.mimeType} but its contents are ${sniffed}.`,
      });
    }

    const dimensions = readImageDimensions(head, asset.mimeType);
    const checksum = createHash('sha256').update(head).digest('hex');

    const completed = await this.prisma.asSystem(async (tx) => {
      const updated = await tx.mediaAsset.update({
        where: { id: assetId },
        data: {
          sizeBytes: BigInt(stored.sizeBytes),
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          checksum,
          uploadedAt: new Date(),
        },
      });

      await this.events.emit(tx, 'media.uploaded', { asset_id: assetId }, { workspaceId });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'media.uploaded',
        resourceType: 'media_asset',
        resourceId: assetId,
        after: { filename: updated.filename, size_bytes: stored.sizeBytes },
        requestId: ctx.requestId,
      });

      return updated;
    });

    return this.toDto(completed);
  }

  async list(
    workspaceId: string,
    query: { folder_id?: string; search?: string; type?: string; unused?: boolean; limit?: number },
  ) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

    return this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const where: Prisma.MediaAssetWhereInput = {
        workspaceId,
        deletedAt: null,
        // Incomplete uploads are rows without bytes behind them; showing them
        // would mean broken thumbnails in the grid.
        uploadedAt: { not: null },
        ...(query.folder_id ? { folderId: query.folder_id } : {}),
        ...(query.search ? { filename: { contains: query.search, mode: 'insensitive' } } : {}),
        ...(query.type ? { mimeType: { startsWith: query.type } } : {}),
        ...(query.unused ? { usages: { none: {} } } : {}),
      };

      const [assets, total] = await Promise.all([
        tx.mediaAsset.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { _count: { select: { usages: true } } },
        }),
        tx.mediaAsset.count({ where }),
      ]);

      const items = await Promise.all(
        assets.map(async (asset) => ({
          ...this.toDto(asset),
          url: await this.storage.publicUrl(asset.storageKey),
          usage_count: asset._count.usages,
        })),
      );

      return { items, meta: { total, limit, has_more: total > limit } };
    });
  }

  async get(workspaceId: string, assetId: string) {
    const asset = await this.requireAsset(workspaceId, assetId);
    return {
      ...this.toDto(asset),
      url: await this.storage.publicUrl(asset.storageKey),
    };
  }

  async update(
    ctx: RequestContext,
    workspaceId: string,
    assetId: string,
    patch: { filename?: string; alt_text?: string; caption?: string; credit?: string; tags?: string[]; folder_id?: string | null },
  ) {
    await this.requireAsset(workspaceId, assetId);
    if (patch.folder_id) await this.requireFolder(workspaceId, patch.folder_id);

    const updated = await this.prisma.asSystem((tx) =>
      tx.mediaAsset.update({
        where: { id: assetId },
        data: {
          filename: patch.filename?.trim() ?? undefined,
          altText: patch.alt_text ?? undefined,
          caption: patch.caption ?? undefined,
          credit: patch.credit ?? undefined,
          tags: patch.tags ?? undefined,
          folderId: patch.folder_id === undefined ? undefined : patch.folder_id,
        },
      }),
    );

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'media.updated',
      resourceType: 'media_asset',
      resourceId: assetId,
      requestId: ctx.requestId,
    });

    return { ...this.toDto(updated), url: await this.storage.publicUrl(updated.storageKey) };
  }

  /** The "used in N entries" list of §5.3 and §17.7. */
  async usages(workspaceId: string, assetId: string) {
    await this.requireAsset(workspaceId, assetId);

    const usages = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaUsage.findMany({ where: { workspaceId, assetId } }),
    );

    if (usages.length === 0) return [];

    // Entry titles are fetched separately: mediaUsage has no relation to entry
    // (an entry may be deleted while the usage row lingers until the next save),
    // so a join would drop rows rather than showing them as stale.
    const entries = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.contentEntry.findMany({
        where: { workspaceId, id: { in: usages.map((u) => u.entryId) }, deletedAt: null },
        select: { id: true, slug: true, contentType: { select: { name: true, apiId: true } } },
      }),
    );

    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    return usages
      .filter((usage) => byId.has(usage.entryId))
      .map((usage) => {
        const entry = byId.get(usage.entryId)!;
        return {
          entry_id: usage.entryId,
          field_api_id: usage.fieldApiId,
          slug: entry.slug,
          content_type: entry.contentType.name,
          content_type_api_id: entry.contentType.apiId,
        };
      });
  }

  async remove(ctx: RequestContext, workspaceId: string, assetId: string, force: boolean) {
    const asset = await this.requireAsset(workspaceId, assetId);
    const usages = await this.usages(workspaceId, assetId);

    // §17.7 wants the usage warning *before* deletion, not a broken image
    // discovered later on the live site.
    if (usages.length > 0 && !force) {
      throw new AppError('conflict', `"${asset.filename}" is used in ${usages.length} place(s).`, {
        detail:
          `Deleting it would leave broken references in: ${usages
            .map((u) => `${u.content_type}${u.slug ? ` /${u.slug}` : ''}`)
            .slice(0, 5)
            .join(', ')}. Remove it from those entries first, or delete anyway.`,
      });
    }

    await this.prisma.asSystem(async (tx) => {
      // Soft delete first; the object itself is removed by the nightly purge, so
      // an accidental delete is recoverable within the retention window (§4.6).
      await tx.mediaAsset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });

      await this.events.emit(tx, 'media.deleted', { asset_id: assetId }, { workspaceId });
      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'media.deleted',
        resourceType: 'media_asset',
        resourceId: assetId,
        before: { filename: asset.filename, usages: usages.length },
        requestId: ctx.requestId,
      });
    });
  }

  // -- Folders ---------------------------------------------------------------

  async listFolders(workspaceId: string) {
    const folders = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaFolder.findMany({ where: { workspaceId }, orderBy: { path: 'asc' } }),
    );

    return folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      parent_id: folder.parentId,
    }));
  }

  async createFolder(
    ctx: RequestContext,
    workspaceId: string,
    input: { name: string; parent_id?: string },
  ) {
    const parent = input.parent_id ? await this.requireFolder(workspaceId, input.parent_id) : null;
    const name = input.name.trim();
    const path = parent ? `${parent.path}/${slugSegment(name)}` : `/${slugSegment(name)}`;

    const taken = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaFolder.count({ where: { workspaceId, path } }),
    );
    if (taken) throw conflict('A folder with that name already exists here.');

    const folder = await this.prisma.asSystem((tx) =>
      tx.mediaFolder.create({
        data: { id: newId(), workspaceId, parentId: parent?.id ?? null, name, path },
      }),
    );

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'media_folder.created',
      resourceType: 'media_folder',
      resourceId: folder.id,
      requestId: ctx.requestId,
    });

    return { id: folder.id, name: folder.name, path: folder.path, parent_id: folder.parentId };
  }

  async deleteFolder(ctx: RequestContext, workspaceId: string, folderId: string): Promise<void> {
    const folder = await this.requireFolder(workspaceId, folderId);

    const contents = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => ({
      assets: await tx.mediaAsset.count({ where: { workspaceId, folderId, deletedAt: null } }),
      children: await tx.mediaFolder.count({ where: { workspaceId, parentId: folderId } }),
    }));

    if (contents.assets > 0 || contents.children > 0) {
      throw new AppError('conflict', `"${folder.name}" is not empty.`, {
        detail: `It holds ${contents.assets} file(s) and ${contents.children} subfolder(s). Move or delete them first.`,
      });
    }

    await this.prisma.asSystem((tx) => tx.mediaFolder.delete({ where: { id: folderId } }));

    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'media_folder.deleted',
      resourceType: 'media_folder',
      resourceId: folderId,
      requestId: ctx.requestId,
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async readHead(key: string, bytes: number): Promise<Buffer> {
    const stream = await this.storage.read(key);
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size >= bytes) break;
    }

    // Release the connection rather than leaving the rest of a large object
    // streaming into a socket nobody is reading.
    stream.destroy?.();

    return Buffer.concat(chunks).subarray(0, bytes);
  }

  private async workspaceSettings(workspaceId: string) {
    const workspace = await this.prisma.asSystem((tx) =>
      tx.workspace.findFirst({ where: { id: workspaceId }, select: { settings: true } }),
    );

    const media = ((workspace?.settings as Record<string, unknown>)?.media ?? {}) as {
      max_upload_size_mb?: number;
      allowed_mime_types?: string[];
    };

    return {
      maxBytes: (media.max_upload_size_mb ?? DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024,
      allowedMime: media.allowed_mime_types?.length ? media.allowed_mime_types : ALLOWED_MIME,
    };
  }

  private async requireAsset(
    workspaceId: string,
    assetId: string,
    options: { includeIncomplete?: boolean } = {},
  ) {
    const asset = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaAsset.findFirst({
        where: {
          id: assetId,
          workspaceId,
          deletedAt: null,
          ...(options.includeIncomplete ? {} : { uploadedAt: { not: null } }),
        },
      }),
    );
    if (!asset) throw notFound('Media asset', assetId);
    return asset;
  }

  private async requireFolder(workspaceId: string, folderId: string) {
    const folder = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.mediaFolder.findFirst({ where: { id: folderId, workspaceId } }),
    );
    if (!folder) throw notFound('Folder', folderId);
    return folder;
  }

  private toDto(asset: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: bigint;
    width: number | null;
    height: number | null;
    altText: string | null;
    caption: string | null;
    credit: string | null;
    tags: string[];
    folderId: string | null;
    uploadedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: asset.id,
      filename: asset.filename,
      mime_type: asset.mimeType,
      // bigint does not survive JSON.stringify; sizes are well within Number.
      size_bytes: Number(asset.sizeBytes),
      width: asset.width,
      height: asset.height,
      alt_text: asset.altText,
      caption: asset.caption,
      credit: asset.credit,
      tags: asset.tags,
      folder_id: asset.folderId,
      uploaded_at: asset.uploadedAt?.toISOString() ?? null,
      created_at: asset.createdAt.toISOString(),
    };
  }
}

function slugSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'folder'
  );
}
