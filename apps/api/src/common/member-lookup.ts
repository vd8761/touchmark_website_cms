import type { OrgRole } from '@cms/shared';

import { AppError } from './errors';
import { PrismaService } from './prisma.service';

/**
 * Resolves "who did you mean" for the ownership-transfer endpoints.
 *
 * People identify each other by email, not by UUID, so both organisation and
 * site transfers accept an address. The lookup is deliberately scoped to the
 * organisation: an address that has no account and an address that has one but
 * is not in this organisation produce the *same* message, so the endpoint
 * cannot be used to probe which email addresses are registered on the platform.
 */
export interface ResolvedMember {
  memberId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: OrgRole;
}

export async function resolveOrganisationMember(
  prisma: PrismaService,
  organisationId: string,
  target: { email?: string; user_id?: string },
): Promise<ResolvedMember> {
  const email = target.email?.trim().toLowerCase();
  if (!email && !target.user_id) {
    throw new AppError('invalid_request', 'Name the person to transfer to.', {
      detail: 'Provide either `email` or `user_id`.',
    });
  }

  const member = await prisma.asSystem((tx) =>
    tx.organisationMember.findFirst({
      where: {
        organisationId,
        ...(email ? { user: { email } } : { userId: target.user_id }),
      },
      include: { user: { select: { id: true, email: true, fullName: true, status: true } } },
    }),
  );

  if (!member) {
    throw new AppError('invalid_request', 'That person is not a member of this organisation.', {
      detail:
        `No member of this organisation matches ${email ?? target.user_id}. ` +
        'Invite them to the organisation first, then transfer ownership.',
    });
  }

  // Handing an organisation or a site to an account that cannot sign in would
  // leave it with an owner who can never act.
  if (member.user.status !== 'active') {
    throw new AppError('unprocessable', 'That account is not active.', {
      detail: `${member.user.email} is ${member.user.status}. Reactivate it before transferring.`,
    });
  }

  return {
    memberId: member.id,
    userId: member.user.id,
    email: member.user.email,
    fullName: member.user.fullName,
    role: member.role,
  };
}
