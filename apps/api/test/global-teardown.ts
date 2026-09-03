import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Teardown runs in its own process, outside Nest — so `ConfigModule`'s env
// loading has not happened and `DATABASE_URL` would be undefined. Same file
// list the application uses.
loadEnv({ path: resolve(__dirname, '..', '..', '..', '.env') });
loadEnv({ path: resolve(__dirname, '..', '.env') });

/**
 * Removes the tenants the e2e suites created.
 *
 * Every suite builds a full tenant — user, organisation, site, content — and
 * nothing ever removed them. On the development database that had accumulated
 * to 74 organisations and 65 workspaces of pure test residue, which made the
 * admin UI unusable for actually looking at anything and made "which org am I
 * in" a real question. In CI the database is thrown away, so the cost landed
 * entirely on whoever ran the suite locally.
 *
 * **Matching is on the `@e2e.example.test` marker, deliberately.** Fixture users
 * used plain `@example.test`, which the seed also uses — so a teardown keyed on
 * that would have deleted `owner@example.test` and the demo content along with
 * the junk.
 *
 * Organisations are deleted before their members, because deleting a user only
 * cascades their membership row and would leave the organisation orphaned with
 * no way to identify it afterwards.
 */
const MARKER = '@e2e.example.test';

/**
 * The seed's accounts, which share the `example.test` domain and must survive.
 *
 * Earlier runs predate the marker, so their residue is on plain
 * `@example.test`; sweeping that up too is what clears the backlog rather than
 * only stopping it growing. This list is the line between the two.
 */
const SEED_EMAILS = [
  'owner@example.test',
  'admin@example.test',
  'editor@example.test',
  'author@example.test',
  'marketer@example.test',
  'analyst@example.test',
];

export default async function globalTeardown(): Promise<void> {
  if (process.env.SKIP_E2E_TEARDOWN === 'true') return;

  const prisma = new PrismaClient();

  try {
    // Marker-only by default. An earlier version also swept plain
    // `@example.test` to clear historical residue, and that is far too blunt a
    // tool to run automatically: it deletes any organisation whose members all
    // happen to match, and on a development database that is indistinguishable
    // from someone's real work. Opt in explicitly, having looked first.
    const emailFilter =
      process.env.E2E_TEARDOWN_LEGACY === 'true'
        ? {
            OR: [{ email: { endsWith: MARKER } }, { email: { endsWith: '@example.test' } }],
            email: { notIn: SEED_EMAILS },
          }
        : { email: { endsWith: MARKER } };

    const users = await prisma.user.findMany({
      where: emailFilter,
      select: { id: true },
    });
    if (users.length === 0) return;

    const userIds = new Set(users.map((user) => user.id));

    // Only organisations whose membership is *entirely* fixture users. An org
    // holding one real member is somebody's actual data, whatever else is in
    // it, and must survive.
    const candidates = await prisma.organisation.findMany({
      where: { members: { some: { userId: { in: [...userIds] } } } },
      select: { id: true, members: { select: { userId: true } } },
    });

    const disposable = candidates
      .filter((org) => org.members.every((member) => userIds.has(member.userId)))
      .map((org) => org.id);

    // Cascades workspaces and everything scoped to them.
    const orgs = await prisma.organisation.deleteMany({ where: { id: { in: disposable } } });
    const removed = await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });

    // Recurring job rows the suites register but the application has no
    // processor for; left behind they fail on every poll, forever.
    await prisma.job.deleteMany({
      where: { dedupeKey: { startsWith: 'recurring:' }, status: 'pending', intervalMs: null },
    });

    if (orgs.count || removed.count) {
      console.log(
        `\ne2e teardown: removed ${orgs.count} organisation(s) and ${removed.count} user(s).`,
      );
    }
  } catch (error) {
    // A failed cleanup must never turn a green suite red — the tests already
    // ran and their result is the thing that matters.
    console.warn(`e2e teardown skipped: ${(error as Error).message}`);
  } finally {
    await prisma.$disconnect();
  }
}
