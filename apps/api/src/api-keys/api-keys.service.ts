import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ApiKey,
  ApiKeyEnvironment,
  ApiKeyType,
  ApiRequestLog,
  WorkspaceStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppError, conflict, invalid, notFound, unprocessable } from '../common/errors';
import { MailService } from '../common/mail.service';
import { pageArgs, parseLimit, toPage, type PageQuery } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { RequestContext } from '../common/request-context';
import { JOB_NAMES } from '../jobs/job-names';
import { JobQueueService } from '../jobs/job-queue.service';
import { newId } from '../common/uuid';
import {
  type ApiKeyScope,
  isApiKeyScope,
  isPublishableApiKeyScope,
} from './api-key-scopes';
import {
  type ApiKeyRotationGracePeriod,
  CreateApiKeyDto,
  RevokeApiKeyDto,
  RotateApiKeyDto,
  UpdateApiKeyDto,
} from './dto/api-key.dto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const API_KEY_PATTERN = /^(pk|sk)_(live|test)_([0-9A-Za-z]+)$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const BURST_WINDOW_MS = 10_000;
const SUBSCRIBER_WRITE_IP_LIMIT = 30;

export interface ApiKeyAuthContext {
  id: string;
  name: string;
  type: ApiKeyType;
  environment: ApiKeyEnvironment;
  workspaceId: string;
  organisationId: string;
  workspaceStatus: WorkspaceStatus;
  scopes: readonly ApiKeyScope[];
  limits: { requests_per_minute: number };
}

export interface ApiKeyRateLimitState {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface ApiKeyRequestLogInput {
  key: ApiKeyAuthContext;
  method: string;
  path: string;
  statusCode: number;
  errorCode?: string | null;
  ip?: string | null;
  origin?: string | null;
  userAgent?: string | null;
  durationMs: number;
}

type ResolvedApiKeyRecord = ApiKeyAuthContext & {
  keyPrefix: string;
  allowedOrigins: string[];
  allowedIps: string[];
  expiresAt: string | null;
};

@Injectable()
export class ApiKeysService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeysService.name);
  private readonly rateLimitEnabled: boolean;
  private readonly publishableRateLimit: number;
  private readonly secretRateLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
    config: ConfigService,
  ) {
    this.rateLimitEnabled = config.get<string>('API_KEY_RATE_LIMIT_ENABLED') !== 'false';
    this.publishableRateLimit = positiveInt(
      config.get<string>('API_KEY_RATE_LIMIT_PUBLISHABLE_PER_MINUTE'),
      300,
    );
    this.secretRateLimit = positiveInt(
      config.get<string>('API_KEY_RATE_LIMIT_SECRET_PER_MINUTE'),
      1_000,
    );
  }

  onModuleInit(): void {
    // Counters are keyed by API key and by client IP, so the IP-keyed rows would
    // otherwise accumulate one per address seen, forever.
    this.jobs.registerRecurring(JOB_NAMES.keyUsageFlush, 15 * 60_000, async () => {
      const removed = await this.purgeExpiredRateLimitCounters();
      if (removed > 0) this.logger.log(`Purged ${removed} expired rate-limit counter(s).`);
    });
  }

  async list(workspaceId: string) {
    const keys = await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
      tx.apiKey.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
    );

    return keys.map((key) => this.toDto(key));
  }

  async create(ctx: RequestContext, workspaceId: string, dto: CreateApiKeyDto) {
    const type = dto.type;
    const environment = dto.environment ?? 'live';
    const scopes = normaliseScopes(dto.scopes);
    const allowedOrigins = normaliseOrigins(dto.allowed_origins ?? []);
    const allowedIps = (dto.allowed_ips ?? []).map((ip) => ip.trim()).filter(Boolean);
    const expiresAt = parseExpiry(dto.expires_at);

    if (type === 'publishable') {
      const forbidden = scopes.filter((scope) => !isPublishableApiKeyScope(scope));
      if (forbidden.length) {
        throw unprocessable(
          'Publishable keys cannot use those scopes.',
          `Remove: ${forbidden.join(', ')}. Use a secret key for server-only scopes.`,
        );
      }
      if (allowedOrigins.length === 0) {
        throw unprocessable(
          'Publishable keys require an origin allowlist.',
          'Add at least one allowed origin, for example https://www.example.com.',
        );
      }
    }

    const plaintext = generateApiKey(type, environment);
    const created = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const key = await tx.apiKey.create({
        data: {
          id: newId(),
          workspaceId,
          name: dto.name.trim(),
          type,
          environment,
          keyHash: hashApiKey(plaintext),
          keyPrefix: keyPrefix(type, environment),
          keyLastFour: plaintext.slice(-4),
          scopes,
          allowedOrigins,
          allowedIps,
          rateLimitPerMinute: dto.rate_limit_per_minute,
          expiresAt,
          createdBy: ctx.userId,
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: key.id,
        after: {
          name: key.name,
          type: key.type,
          environment: key.environment,
          scopes: key.scopes,
          allowed_origins: key.allowedOrigins,
          allowed_ips: key.allowedIps,
          rate_limit_per_minute: key.rateLimitPerMinute,
          expires_at: key.expiresAt?.toISOString() ?? null,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return key;
    });

    return { ...this.toDto(created), key: plaintext };
  }

  async update(ctx: RequestContext, workspaceId: string, keyId: string, dto: UpdateApiKeyDto) {
    const updated = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const current = await tx.apiKey.findFirst({ where: { id: keyId, workspaceId } });
      if (!current) throw notFound('API key', keyId);
      if (current.status === 'revoked') {
        throw conflict('Cannot update a revoked API key.');
      }

      const scopes = dto.scopes ? normaliseScopes(dto.scopes) : normaliseScopes(current.scopes);
      const allowedOrigins = dto.allowed_origins
        ? normaliseOrigins(dto.allowed_origins)
        : current.allowedOrigins;
      const allowedIps = dto.allowed_ips
        ? dto.allowed_ips.map((ip) => ip.trim()).filter(Boolean)
        : current.allowedIps;

      this.assertConfigurationAllowed(current.type, scopes, allowedOrigins);

      const next = await tx.apiKey.update({
        where: { id: keyId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.scopes !== undefined ? { scopes } : {}),
          ...(dto.allowed_origins !== undefined ? { allowedOrigins } : {}),
          ...(dto.allowed_ips !== undefined ? { allowedIps } : {}),
          ...(dto.expires_at !== undefined ? { expiresAt: parseExpiry(dto.expires_at) } : {}),
          ...(dto.rate_limit_per_minute !== undefined
            ? { rateLimitPerMinute: dto.rate_limit_per_minute }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'api_key.updated',
        resourceType: 'api_key',
        resourceId: keyId,
        before: this.auditSnapshot(current),
        after: this.auditSnapshot(next),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return next;
    });

    return this.toDto(updated);
  }

  async rotate(ctx: RequestContext, workspaceId: string, keyId: string, dto: RotateApiKeyDto) {
    const gracePeriod = dto.grace_period ?? '24h';
    const rotated = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const current = await tx.apiKey.findFirst({ where: { id: keyId, workspaceId } });
      if (!current) throw notFound('API key', keyId);
      if (current.status === 'revoked') {
        throw conflict('Cannot rotate a revoked API key.');
      }
      if (current.rotatedToId) {
        throw conflict('This API key has already been rotated.');
      }
      if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
        throw conflict('Cannot rotate an expired API key.');
      }

      const now = new Date();
      const replacementId = newId();
      const plaintext = generateApiKey(current.type, current.environment);
      const graceEndsAt = graceEndsAtFor(gracePeriod, now);
      const oldExpiresAt =
        gracePeriod === 'immediate' ? now : minDate(current.expiresAt, graceEndsAt);
      const replacement = await tx.apiKey.create({
        data: {
          id: replacementId,
          workspaceId,
          name: dto.name?.trim() || rotationName(current.name, replacementId),
          type: current.type,
          environment: current.environment,
          keyHash: hashApiKey(plaintext),
          keyPrefix: keyPrefix(current.type, current.environment),
          keyLastFour: plaintext.slice(-4),
          scopes: current.scopes,
          allowedOrigins: current.allowedOrigins,
          allowedIps: current.allowedIps,
          rateLimitPerMinute: current.rateLimitPerMinute,
          expiresAt: current.expiresAt,
          rotatedFromId: current.id,
          createdBy: ctx.userId,
        },
      });

      const previous = await tx.apiKey.update({
        where: { id: current.id },
        data: {
          rotatedToId: replacement.id,
          rotationGraceEndsAt: oldExpiresAt,
          expiresAt: oldExpiresAt,
          ...(gracePeriod === 'immediate'
            ? { status: 'revoked', revokedAt: now, revokedBy: ctx.userId }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'api_key.rotated',
        resourceType: 'api_key',
        resourceId: current.id,
        before: this.auditSnapshot(current),
        after: {
          replacement_id: replacement.id,
          grace_period: gracePeriod,
          grace_ends_at: oldExpiresAt.toISOString(),
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return { previous, previousHash: current.keyHash, replacement, plaintext };
    });

    return {
      previous: this.toDto(rotated.previous),
      replacement: { ...this.toDto(rotated.replacement), key: rotated.plaintext },
      grace_ends_at: rotated.previous.rotationGraceEndsAt?.toISOString() ?? null,
    };
  }

  async revoke(ctx: RequestContext, workspaceId: string, keyId: string, dto: RevokeApiKeyDto) {
    const revoked = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const current = await tx.apiKey.findFirst({ where: { id: keyId, workspaceId } });
      if (!current) throw notFound('API key', keyId);
      if (current.status === 'revoked') return current;

      const next = await tx.apiKey.update({
        where: { id: keyId },
        data: { status: 'revoked', revokedAt: new Date(), revokedBy: ctx.userId },
      });

      await this.audit.recordIn(tx, {
        workspaceId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: keyId,
        before: { status: current.status },
        after: { status: next.status, reason: dto.reason ?? null },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return next;
    });

    await this.notifyKeyRevoked(ctx, workspaceId, revoked, dto.reason ?? null);
    return this.toDto(revoked);
  }

  async authenticate(
    plaintext: string,
    request: { origin: string | null; ip: string | null },
  ): Promise<ApiKeyAuthContext> {
    const parsed = parseApiKey(plaintext);
    if (!parsed) {
      throw new AppError('invalid_api_key', 'The API key is not valid.', {
        detail: 'Use a key in the format pk_live_... or sk_live_....',
      });
    }

    // Resolved from the database on every request, with no cache in front.
    //
    // §12.1 promises that revocation is synchronous — the key stops
    // authenticating immediately. A cache can only honour that by being shared
    // and deleted on revoke, which is what Redis was doing here; a per-instance
    // cache would keep a revoked key alive on every *other* instance until its
    // TTL expired. Given the lookup is a single unique-index hit on key_hash,
    // and the request is already writing a log row, buying back that
    // microsecond is not worth a window in which a leaked key still works.
    const hash = hashApiKey(plaintext);

    const record = await this.prisma.asSystem((tx) =>
      tx.apiKey.findUnique({
        where: { keyHash: hash },
        include: {
          workspace: {
            select: {
              id: true,
              organisationId: true,
              status: true,
              deletedAt: true,
              organisation: { select: { status: true, deletedAt: true } },
            },
          },
        },
      }),
    );

    if (!record || record.workspace.deletedAt || record.workspace.organisation.deletedAt) {
      throw new AppError('invalid_api_key', 'The API key is not valid.');
    }
    if (record.keyPrefix !== parsed.prefix) {
      throw new AppError('invalid_api_key', 'The API key is not valid.');
    }
    if (record.status === 'revoked' || record.revokedAt) {
      throw new AppError('key_revoked', 'This API key has been revoked.');
    }
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      throw new AppError('key_expired', 'This API key has expired.');
    }
    if (record.workspace.organisation.status === 'suspended') {
      throw new AppError('workspace_suspended', 'This organisation is suspended.');
    }
    if (record.workspace.status === 'archived') {
      throw new AppError('workspace_archived', 'This site is archived.');
    }

    if (record.type === 'publishable' && record.allowedOrigins.length > 0) {
      const origin = request.origin ? normaliseOrigin(request.origin) : null;
      if (!origin || !record.allowedOrigins.includes(origin)) {
        throw new AppError('origin_not_allowed', 'This origin is not allowed for the API key.');
      }
    }

    if (record.type === 'secret' && record.allowedIps.length > 0) {
      if (!request.ip || !isIpAllowed(request.ip, record.allowedIps)) {
        throw new AppError('ip_not_allowed', 'This IP address is not allowed for the API key.');
      }
    }

    const context: ResolvedApiKeyRecord = {
      id: record.id,
      name: record.name,
      type: record.type,
      environment: record.environment,
      workspaceId: record.workspaceId,
      organisationId: record.workspace.organisationId,
      workspaceStatus: record.workspace.status,
      scopes: normaliseScopes(record.scopes),
      limits: { requests_per_minute: this.limitForRecord(record) },
      keyPrefix: record.keyPrefix,
      allowedOrigins: record.allowedOrigins,
      allowedIps: record.allowedIps,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };

    return this.publicAuthContext(context);
  }

  async consumeRateLimit(
    key: ApiKeyAuthContext,
    options: { scope?: ApiKeyScope; ip?: string | null } = {},
  ): Promise<ApiKeyRateLimitState & { allowed: boolean }> {
    const limit = key.limits.requests_per_minute;
    const now = Date.now();

    if (!this.rateLimitEnabled) {
      return {
        allowed: true,
        limit,
        remaining: limit,
        resetAt: new Date(now + RATE_LIMIT_WINDOW_MS),
      };
    }

    const minute = await this.consumeRateWindow(`api-key:rate:${key.id}:1m`, now, RATE_LIMIT_WINDOW_MS);
    const burstLimit = burstLimitFor(limit);
    const burst = await this.consumeRateWindow(`api-key:rate:${key.id}:10s`, now, BURST_WINDOW_MS);
    let allowed = minute.count <= limit && burst.count <= burstLimit;
    let remaining = Math.max(Math.min(limit - minute.count, burstLimit - burst.count), 0);
    let resetAt = new Date(minute.oldest + RATE_LIMIT_WINDOW_MS);

    if ((options.scope === 'subscriber.write' || options.scope === 'form.submit') && options.ip) {
      const ip = normaliseIp(options.ip);
      const ipMinute = await this.consumeRateWindow(
        `api-key:rate:${key.id}:ip:${ip}:1m`,
        now,
        RATE_LIMIT_WINDOW_MS,
      );
      const ipBurstLimit = burstLimitFor(SUBSCRIBER_WRITE_IP_LIMIT);
      const ipBurst = await this.consumeRateWindow(
        `api-key:rate:${key.id}:ip:${ip}:10s`,
        now,
        BURST_WINDOW_MS,
      );
      allowed =
        allowed &&
        ipMinute.count <= SUBSCRIBER_WRITE_IP_LIMIT &&
        ipBurst.count <= ipBurstLimit;
      remaining = Math.max(
        Math.min(
          remaining,
          SUBSCRIBER_WRITE_IP_LIMIT - ipMinute.count,
          ipBurstLimit - ipBurst.count,
        ),
        0,
      );
      if (ipMinute.count > SUBSCRIBER_WRITE_IP_LIMIT) {
        resetAt = new Date(ipMinute.oldest + RATE_LIMIT_WINDOW_MS);
      } else if (ipBurst.count > ipBurstLimit) {
        resetAt = new Date(ipBurst.oldest + BURST_WINDOW_MS);
      }
    }

    return {
      allowed,
      limit,
      remaining,
      resetAt,
    };
  }

  /**
   * Recent requests made with one key.
   *
   * Paginated rather than capped: "which call failed, and when" is the question
   * this endpoint exists to answer, and a hard 50 makes it unanswerable for any
   * key doing real traffic — the interesting request is rarely in the newest
   * fifty.
   */
  async listRequestLogs(workspaceId: string, keyId: string, query: PageQuery = {}) {
    const limit = parseLimit(query.limit);
    const where = { workspaceId, apiKeyId: keyId };

    const [rows, total] = await this.prisma.withWorkspaceScope(workspaceId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { id: keyId, workspaceId } });
      if (!key) throw notFound('API key', keyId);

      return Promise.all([
        tx.apiRequestLog.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          ...pageArgs(limit, query.cursor),
        }),
        tx.apiRequestLog.count({ where }),
      ]);
    });

    const page = toPage(rows, limit, total);
    return { items: page.items.map((log) => this.toRequestLogDto(log)), meta: page.meta };
  }

  async requestLogSummary(
    workspaceId: string,
    input: { since?: string; until?: string; granularity?: string } = {},
  ) {
    const range = parseLogRange(input.since, input.until);
    const bucketSql =
      input.granularity === 'day'
        ? Prisma.sql`date_trunc('day', occurred_at)`
        : Prisma.sql`date_trunc('hour', occurred_at)`;

    const [totals, byStatus, topPaths, topKeys, timeseries] =
      await this.prisma.withWorkspaceScope(workspaceId, (tx) =>
        Promise.all([
          tx.$queryRaw<
            Array<{
              requests: number;
              errors: number;
              avg_duration_ms: number | null;
              p50_duration_ms: number | null;
              p95_duration_ms: number | null;
              p99_duration_ms: number | null;
            }>
          >(Prisma.sql`
            SELECT
              COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors,
              ROUND(AVG(duration_ms))::int AS avg_duration_ms,
              percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_duration_ms,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_duration_ms,
              percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_duration_ms
            FROM api_request_logs
            WHERE workspace_id = CAST(${workspaceId} AS uuid)
              AND occurred_at >= ${range.since}
              AND occurred_at < ${range.until}
          `),
          tx.$queryRaw<Array<{ status_class: string; requests: number }>>(Prisma.sql`
            -- FLOOR(code / 100) alone, not × 100: multiplying produced "200xx"
            -- rather than the conventional "2xx".
            SELECT CONCAT(FLOOR(status_code / 100), 'xx') AS status_class,
                   COUNT(*)::int AS requests
            FROM api_request_logs
            WHERE workspace_id = CAST(${workspaceId} AS uuid)
              AND occurred_at >= ${range.since}
              AND occurred_at < ${range.until}
            GROUP BY status_class
            ORDER BY status_class
          `),
          tx.$queryRaw<
            Array<{
              path: string;
              requests: number;
              errors: number;
              avg_duration_ms: number | null;
            }>
          >(Prisma.sql`
            SELECT path,
                   COUNT(*)::int AS requests,
                   COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors,
                   ROUND(AVG(duration_ms))::int AS avg_duration_ms
            FROM api_request_logs
            WHERE workspace_id = CAST(${workspaceId} AS uuid)
              AND occurred_at >= ${range.since}
              AND occurred_at < ${range.until}
            GROUP BY path
            ORDER BY requests DESC, path ASC
            LIMIT 20
          `),
          tx.$queryRaw<
            Array<{
              api_key_id: string | null;
              api_key_name: string | null;
              requests: number;
              errors: number;
            }>
          >(Prisma.sql`
            SELECT l.api_key_id,
                   k.name AS api_key_name,
                   COUNT(*)::int AS requests,
                   COUNT(*) FILTER (WHERE l.status_code >= 400)::int AS errors
            FROM api_request_logs l
            LEFT JOIN api_keys k ON k.id = l.api_key_id
            WHERE l.workspace_id = CAST(${workspaceId} AS uuid)
              AND l.occurred_at >= ${range.since}
              AND l.occurred_at < ${range.until}
            GROUP BY l.api_key_id, k.name
            ORDER BY requests DESC
            LIMIT 20
          `),
          tx.$queryRaw<Array<{ bucket: Date; requests: number; errors: number }>>(Prisma.sql`
            SELECT ${bucketSql} AS bucket,
                   COUNT(*)::int AS requests,
                   COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors
            FROM api_request_logs
            WHERE workspace_id = CAST(${workspaceId} AS uuid)
              AND occurred_at >= ${range.since}
              AND occurred_at < ${range.until}
            GROUP BY bucket
            ORDER BY bucket ASC
          `),
        ]),
      );

    const total = totals[0] ?? {
      requests: 0,
      errors: 0,
      avg_duration_ms: null,
      p50_duration_ms: null,
      p95_duration_ms: null,
      p99_duration_ms: null,
    };

    return {
      range: {
        since: range.since.toISOString(),
        until: range.until.toISOString(),
        granularity: input.granularity === 'day' ? 'day' : 'hour',
      },
      totals: {
        requests: total.requests,
        errors: total.errors,
        error_rate: total.requests > 0 ? total.errors / total.requests : 0,
        avg_duration_ms: total.avg_duration_ms,
        p50_duration_ms: total.p50_duration_ms,
        p95_duration_ms: total.p95_duration_ms,
        p99_duration_ms: total.p99_duration_ms,
      },
      by_status: byStatus,
      top_paths: topPaths,
      top_keys: topKeys,
      timeseries: timeseries.map((row) => ({
        bucket: row.bucket.toISOString(),
        requests: row.requests,
        errors: row.errors,
      })),
    };
  }

  async recordRequest(input: ApiKeyRequestLogInput): Promise<void> {
    const occurredAt = new Date();
    await this.prisma.asSystem(async (tx) => {
      await tx.apiRequestLog.create({
        data: {
          id: newId(),
          workspaceId: input.key.workspaceId,
          apiKeyId: input.key.id,
          method: input.method.toUpperCase(),
          path: input.path,
          statusCode: input.statusCode,
          errorCode: input.errorCode ?? null,
          ip: input.ip ? normaliseIp(input.ip) : null,
          origin: input.origin,
          userAgent: input.userAgent,
          durationMs: Math.max(0, Math.round(input.durationMs)),
          occurredAt,
        },
      });

      await tx.apiKey.updateMany({
        where: { id: input.key.id },
        data: { lastUsedAt: occurredAt, usageCount: { increment: 1 } },
      });
    });
  }

  private async notifyKeyRevoked(
    ctx: RequestContext,
    workspaceId: string,
    key: Pick<ApiKey, 'name'>,
    reason: string | null,
  ): Promise<void> {
    const context = await this.prisma.asSystem((tx) =>
      tx.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          name: true,
          organisation: {
            select: {
              members: {
                where: { role: { in: ['owner', 'admin'] } },
                select: { user: { select: { email: true } } },
              },
            },
          },
          members: {
            where: { role: 'site_admin' },
            select: { user: { select: { email: true } } },
          },
        },
      }),
    );
    if (!context) return;

    const actor = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { id: ctx.userId }, select: { fullName: true, email: true } }),
    );
    const recipients = unique([
      ...context.members.map((member) => member.user.email),
      ...context.organisation.members.map((member) => member.user.email),
    ]);
    await this.mail.sendApiKeyRevokedNotice(recipients, {
      workspaceName: context.name,
      keyName: key.name,
      actorName: actor?.fullName ?? actor?.email ?? null,
      reason,
    });
  }

  /**
   * Counts this request against a fixed window, atomically.
   *
   * One statement, one row per bucket. The upsert either increments the current
   * window or, when the stored `window_start` belongs to an older window, resets
   * the row to 1 — so expiry is arithmetic rather than a background sweep, and
   * two instances racing on the same bucket still produce consecutive counts
   * because the increment happens inside the row lock Postgres already takes.
   *
   * Fixed windows, not the sliding log this used to keep in Redis: a sliding
   * window needs a row per request to be exact, and the only behaviour it buys
   * is stricter fairness at a window boundary — which the burst allowance is
   * already there to tolerate.
   */
  private async consumeRateWindow(
    bucket: string,
    now: number,
    windowMs: number,
  ): Promise<{ count: number; oldest: number }> {
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs * 2);

    try {
      const rows = await this.prisma.asSystem((tx) =>
        tx.$queryRaw<Array<{ count: number; window_start: Date }>>(Prisma.sql`
          INSERT INTO rate_limit_counters (bucket, window_start, count, expires_at)
          VALUES (${bucket}, ${windowStart}, 1, ${expiresAt})
          ON CONFLICT (bucket) DO UPDATE
            SET count = CASE
                          WHEN rate_limit_counters.window_start = EXCLUDED.window_start
                          THEN rate_limit_counters.count + 1
                          ELSE 1
                        END,
                window_start = EXCLUDED.window_start,
                expires_at = EXCLUDED.expires_at
          RETURNING count, window_start
        `),
      );

      const row = rows[0];
      return { count: Number(row.count), oldest: row.window_start.getTime() };
    } catch (error) {
      this.logger.error(`API key rate limit failed: ${(error as Error).message}`);
      throw new AppError('service_unavailable', 'The API key rate limiter is unavailable.', {
        detail: 'Retry shortly.',
      });
    }
  }

  /** Drops counters whose window is long past. Registered as a recurring job. */
  async purgeExpiredRateLimitCounters(now = new Date()): Promise<number> {
    const { count } = await this.prisma.asSystem((tx) =>
      tx.rateLimitCounter.deleteMany({ where: { expiresAt: { lt: now } } }),
    );
    return count;
  }

  private publicAuthContext(context: ResolvedApiKeyRecord): ApiKeyAuthContext {
    return {
      id: context.id,
      name: context.name,
      type: context.type,
      environment: context.environment,
      workspaceId: context.workspaceId,
      organisationId: context.organisationId,
      workspaceStatus: context.workspaceStatus,
      scopes: normaliseScopes(context.scopes),
      limits: context.limits,
    };
  }

  private limitForRecord(key: Pick<ApiKey, 'type' | 'rateLimitPerMinute'>): number {
    return (
      key.rateLimitPerMinute ??
      (key.type === 'publishable' ? this.publishableRateLimit : this.secretRateLimit)
    );
  }

  private toDto(
    key: Pick<
      ApiKey,
      | 'id'
      | 'name'
      | 'type'
      | 'environment'
      | 'keyPrefix'
      | 'keyLastFour'
      | 'scopes'
      | 'allowedOrigins'
      | 'allowedIps'
      | 'rateLimitPerMinute'
      | 'expiresAt'
      | 'status'
      | 'lastUsedAt'
      | 'usageCount'
      | 'rotatedFromId'
      | 'rotatedToId'
      | 'rotationGraceEndsAt'
      | 'revokedAt'
      | 'createdAt'
      | 'updatedAt'
    >,
  ) {
    return {
      id: key.id,
      name: key.name,
      type: key.type,
      environment: key.environment,
      prefix: key.keyPrefix,
      last_four: key.keyLastFour,
      scopes: normaliseScopes(key.scopes),
      allowed_origins: key.allowedOrigins,
      allowed_ips: key.allowedIps,
      rate_limit_per_minute: key.rateLimitPerMinute,
      expires_at: key.expiresAt?.toISOString() ?? null,
      status: key.status,
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      usage_count: key.usageCount,
      rotated_from_id: key.rotatedFromId,
      rotated_to_id: key.rotatedToId,
      rotation_grace_ends_at: key.rotationGraceEndsAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
      created_at: key.createdAt.toISOString(),
      updated_at: key.updatedAt.toISOString(),
    };
  }

  private toRequestLogDto(
    log: Pick<
      ApiRequestLog,
      | 'id'
      | 'apiKeyId'
      | 'method'
      | 'path'
      | 'statusCode'
      | 'errorCode'
      | 'ip'
      | 'origin'
      | 'userAgent'
      | 'durationMs'
      | 'occurredAt'
    >,
  ) {
    return {
      id: log.id,
      api_key_id: log.apiKeyId,
      method: log.method,
      path: log.path,
      status_code: log.statusCode,
      error_code: log.errorCode,
      ip: log.ip,
      origin: log.origin,
      user_agent: log.userAgent,
      duration_ms: log.durationMs,
      occurred_at: log.occurredAt.toISOString(),
    };
  }

  private auditSnapshot(
    key: Pick<
      ApiKey,
      | 'name'
      | 'scopes'
      | 'allowedOrigins'
      | 'allowedIps'
      | 'rateLimitPerMinute'
      | 'expiresAt'
      | 'status'
    >,
  ) {
    return {
      name: key.name,
      scopes: key.scopes,
      allowed_origins: key.allowedOrigins,
      allowed_ips: key.allowedIps,
      rate_limit_per_minute: key.rateLimitPerMinute,
      expires_at: key.expiresAt?.toISOString() ?? null,
      status: key.status,
    };
  }

  private assertConfigurationAllowed(
    type: ApiKeyType,
    scopes: readonly ApiKeyScope[],
    allowedOrigins: readonly string[],
  ): void {
    if (type !== 'publishable') return;

    const forbidden = scopes.filter((scope) => !isPublishableApiKeyScope(scope));
    if (forbidden.length) {
      throw unprocessable(
        'Publishable keys cannot use those scopes.',
        `Remove: ${forbidden.join(', ')}. Use a secret key for server-only scopes.`,
      );
    }
    if (allowedOrigins.length === 0) {
      throw unprocessable(
        'Publishable keys require an origin allowlist.',
        'Add at least one allowed origin, for example https://www.example.com.',
      );
    }
  }
}

function keyPrefix(type: ApiKeyType, environment: ApiKeyEnvironment): string {
  return `${type === 'publishable' ? 'pk' : 'sk'}_${environment}`;
}

function generateApiKey(type: ApiKeyType, environment: ApiKeyEnvironment): string {
  const value = encodeBase62(randomBytes(32));
  return `${keyPrefix(type, environment)}_${value}`;
}

function hashApiKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeBase62(bytes: Buffer): string {
  let n = BigInt('0x' + bytes.toString('hex'));
  if (n === BigInt(0)) return '0';

  let out = '';
  while (n > BigInt(0)) {
    out = BASE62[Number(n % BigInt(62))] + out;
    n = n / BigInt(62);
  }
  return out;
}

function parseApiKey(value: string): { prefix: string } | null {
  const match = API_KEY_PATTERN.exec(value);
  if (!match) return null;
  return { prefix: `${match[1]}_${match[2]}` };
}

function graceEndsAtFor(period: ApiKeyRotationGracePeriod, now: Date): Date {
  if (period === 'immediate') return now;
  const hours = period === '1h' ? 1 : period === '24h' ? 24 : 24 * 7;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

function minDate(a: Date | null, b: Date): Date {
  if (!a) return b;
  return a.getTime() < b.getTime() ? a : b;
}

function rotationName(currentName: string, replacementId: string): string {
  const suffix = ` rotation ${replacementId.slice(0, 8)}`;
  return `${currentName.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function normaliseScopes(values: readonly string[]): ApiKeyScope[] {
  const scopes: ApiKeyScope[] = [];
  for (const value of values) {
    if (!isApiKeyScope(value)) throw invalid('Unknown API key scope.', value);
    scopes.push(value);
  }
  if (scopes.length === 0) throw invalid('At least one API key scope is required.');
  return scopes;
}

function normaliseOrigins(values: readonly string[]): string[] {
  return values.map((value) => normaliseOrigin(value)).filter(Boolean);
}

function normaliseOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw invalid('Invalid origin.', `Allowed origins must include a protocol, e.g. https://example.com.`);
  }
}

function parseExpiry(value?: string): Date | null {
  if (!value) return null;
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) throw invalid('expires_at is not a valid date.');
  if (expiresAt.getTime() <= Date.now()) {
    throw invalid('expires_at must be in the future.');
  }
  return expiresAt;
}

function parseLogRange(sinceRaw?: string, untilRaw?: string): { since: Date; until: Date } {
  const until = untilRaw ? new Date(untilRaw) : new Date();
  const since = sinceRaw ? new Date(sinceRaw) : new Date(until.getTime() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) throw invalid('since is not a valid date.');
  if (Number.isNaN(until.getTime())) throw invalid('until is not a valid date.');
  if (since.getTime() >= until.getTime()) {
    throw invalid('since must be before until.');
  }
  if (until.getTime() - since.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw invalid('Request log summaries can cover at most 31 days.');
  }
  return { since, until };
}

function burstLimitFor(minuteLimit: number): number {
  if (minuteLimit <= 1) return 1;
  return Math.max(2, Math.ceil(minuteLimit / 3));
}

function isIpAllowed(ip: string, rules: readonly string[]): boolean {
  const normalisedIp = normaliseIp(ip);
  return rules.some((rule) => {
    const value = rule.trim();
    if (!value) return false;
    if (value.includes('/')) return ipv4InCidr(normalisedIp, value);
    return normaliseIp(value) === normalisedIp;
  });
}

function normaliseIp(value: string): string {
  return value.replace(/^::ffff:/, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
