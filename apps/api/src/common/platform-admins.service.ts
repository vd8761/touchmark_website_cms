import { Injectable } from '@nestjs/common';

import { AppError } from './errors';
import { PrismaService } from './prisma.service';

/**
 * The platform's bootstrap rule, in one place.
 *
 * Two endpoints hand out authority that nothing above them can take back:
 * creating an account, and creating an organisation (whose creator becomes its
 * first Owner). Both are open while the platform has no administrator at all —
 * somebody has to be first — and belong to administrators from then on.
 *
 * The check counts *administrators*, not users. A user row with no organisation
 * membership has no authority over anything, so counting users would wedge the
 * platform shut permanently the moment a half-finished signup left one behind.
 *
 * Nothing here is cached. It is a single indexed count, and a stale "no admins
 * yet" answer would reopen public signup on a live platform — the one wrong
 * answer with no recovery path.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(private readonly prisma: PrismaService) {}

  /** True when no organisation anywhere has an owner or admin yet. */
  async isUnclaimed(): Promise<boolean> {
    const admins = await this.prisma.asSystem((tx) =>
      tx.organisationMember.count({ where: { role: { in: ['owner', 'admin'] } } }),
    );
    return admins === 0;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const membership = await this.prisma.asSystem((tx) =>
      tx.organisationMember.findFirst({
        where: { userId, role: { in: ['owner', 'admin'] } },
        select: { id: true },
      }),
    );
    return membership !== null;
  }

  /**
   * Throws unless `actor` may perform a bootstrap-gated action.
   *
   * Returns true when this *is* the bootstrap — callers use that to decide
   * whether they are setting the platform up or adding to it.
   */
  async assertMayBootstrapOrAdminister(
    actor: { userId: string } | null,
    messages: { closed: string; closedDetail: string; forbidden: string; forbiddenDetail: string },
  ): Promise<boolean> {
    if (await this.isUnclaimed()) return true;

    if (!actor) {
      throw new AppError('session_expired', messages.closed, { detail: messages.closedDetail });
    }

    if (!(await this.isAdmin(actor.userId))) {
      throw new AppError('insufficient_permission', messages.forbidden, {
        detail: messages.forbiddenDetail,
      });
    }

    return false;
  }
}
