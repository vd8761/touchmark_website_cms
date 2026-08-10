import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { newId } from '../common/uuid';

export interface AuditEntry {
  organisationId?: string | null;
  workspaceId?: string | null;
  actorType: 'user' | 'api_key' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * §1.2: "Every mutation is auditable — who, what, when, from where."
 *
 * Writes are append-only and enforced as such by the RLS policy, which grants
 * INSERT and SELECT but neither UPDATE nor DELETE. That means even a compromised
 * application role cannot rewrite history.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.asSystem((tx) => this.write(tx, entry));
    } catch (error) {
      // Losing an audit row is serious but must not roll back the action the
      // user asked for — that would make the audit log a availability risk.
      // The failure is logged at error level so alerting catches a pattern of it.
      this.logger.error(`Failed to write audit entry '${entry.action}': ${(error as Error).message}`);
    }
  }

  /**
   * Same, but inside a caller-supplied transaction — the audit row commits with
   * the change it describes, or neither does. Preferred wherever the caller
   * already has a transaction open.
   */
  async recordIn(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await this.write(tx, entry);
  }

  private write(tx: Prisma.TransactionClient, entry: AuditEntry) {
    return tx.auditLog.create({
      data: {
        id: newId(),
        organisationId: entry.organisationId ?? null,
        workspaceId: entry.workspaceId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        before: redact(entry.before),
        after: redact(entry.after),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }
}

const SENSITIVE = [
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'secret',
  'mfasecret',
  'mfa_secret',
  'keyhash',
  'key_hash',
  'refreshtokenhash',
  'authorization',
];

/**
 * §18.2 requires secrets to be "redacted in all log pipelines by a middleware
 * filter". The audit log is a log pipeline: before/after snapshots are built
 * from entity rows, and those rows contain hashes and secrets.
 */
function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return value as Prisma.InputJsonValue;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item)) as Prisma.InputJsonValue;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.includes(key.toLowerCase()) ? '[redacted]' : redact(item);
  }
  return out as Prisma.InputJsonValue;
}
