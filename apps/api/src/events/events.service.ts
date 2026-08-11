import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { newId } from '../common/uuid';

/**
 * The transactional outbox of §4.7.
 *
 * Events are written to `domain_events` in the same transaction as the state
 * change they describe. A separate dispatcher publishes unpublished rows to the
 * consumers (webhook dispatcher, analytics rollup, automation trigger matcher,
 * audit logger, cache invalidator) from Phase 2 onwards.
 *
 * The point of the outbox, per the spec: "an event is never lost if the process
 * dies between the DB commit and the publish."
 */

/** The §4.7 event vocabulary, extended per phase. */
export type DomainEventType =
  // Content (Phase 1)
  | 'content.created'
  | 'content.updated'
  | 'content.published'
  | 'content.unpublished'
  | 'content.scheduled'
  | 'content.deleted'
  | 'media.uploaded'
  | 'media.deleted'
  // Identity and tenancy (Phase 0)
  | 'workspace.created'
  | 'workspace.archived'
  | 'workspace.restored'
  | 'workspace.deletion_scheduled'
  | 'workspace.ownership_transferred'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  | 'organisation.created'
  | 'organisation.ownership_transferred';

@Injectable()
export class EventsService {
  /**
   * Must be called with the transaction that performs the state change —
   * passing the base client would defeat the entire mechanism.
   */
  async emit(
    tx: Prisma.TransactionClient,
    type: DomainEventType,
    payload: Record<string, unknown>,
    scope: { workspaceId?: string | null; orgId?: string | null } = {},
  ): Promise<void> {
    await tx.domainEvent.create({
      data: {
        id: newId(),
        type,
        payload: payload as Prisma.InputJsonValue,
        workspaceId: scope.workspaceId ?? null,
        orgId: scope.orgId ?? null,
      },
    });
  }
}
