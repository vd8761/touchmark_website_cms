import type { AuditLog } from '@prisma/client';

/**
 * The wire shape of an audit entry.
 *
 * Shared by the site and organisation endpoints, which were maintaining two
 * copies of the same mapping — a field added to one and not the other would
 * have made the same record look different depending on which log you read it
 * from.
 */
export interface AuditLogDto {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  request_id: string | null;
  occurred_at: string;
}

export function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    actor_type: row.actorType,
    actor_id: row.actorId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    before: row.before,
    after: row.after,
    ip: row.ip,
    request_id: row.requestId,
    occurred_at: row.occurredAt.toISOString(),
  };
}
