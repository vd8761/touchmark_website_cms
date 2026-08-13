import { ConfigService } from '@nestjs/config';
import { PrismaClient, type OrgRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PasswordService } from '../src/auth/password.service';

/**
 * Creates or promotes an organisation Owner, from the command line.
 *
 * This exists because registration is deliberately closed (§6.1 deviation):
 * `POST /auth/register` is open only until the platform has its first owner or
 * admin, and after that every account arrives by invitation from someone who is
 * already signed in. That is the right rule, and it leaves one real gap — an
 * operator who has just deployed, or who has lost access to the last Owner
 * account, has no way in. Ad-hoc SQL was the alternative, and ad-hoc SQL writes
 * an unverified email, a plaintext password column or a missing membership row
 * about as often as not.
 *
 * The password goes through the same `PasswordService.assertAcceptable` the API
 * uses, so a credential created here cannot be weaker than one created through
 * the product. Set `PASSWORD_PWNED_CHECK=false` to skip the network call when
 * running offline.
 *
 * Idempotent: run it twice and the second run updates the password and confirms
 * the role rather than failing on the unique constraint.
 *
 *   npm run admin:create --workspace @cms/api -- \
 *     --email=you@example.com --password='…' --name='Your Name' --org='My Company'
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const email = (args.email ?? '').trim().toLowerCase();
  const password = args.password ?? '';
  if (!email || !password) {
    throw new Error(
      'Usage: --email=<address> --password=<password> [--name=<full name>] [--org=<org name>] [--role=owner|admin]',
    );
  }

  const role = (args.role ?? 'owner') as OrgRole;
  if (role !== 'owner' && role !== 'admin') {
    throw new Error(`--role must be owner or admin, got "${role}".`);
  }

  const passwords = new PasswordService(new ConfigService(process.env));
  // Fails loudly *before* anything is written, so a rejected password never
  // leaves a half-created account behind.
  await passwords.assertAcceptable(password, { email });
  const passwordHash = await passwords.hash(password);

  const prisma = new PrismaClient();

  try {
    // Resolved *before* the user is written. An ambiguous --org is a hard stop,
    // and an earlier version of this script did the upsert first — which left a
    // real account behind with no membership and no way to sign in anywhere.
    const organisation = await resolveOrganisation(prisma, args.org);

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        id: randomUUID(),
        email,
        passwordHash,
        fullName: args.name ?? null,
        // Verified on creation: this account is being provisioned by whoever
        // controls the deployment, and sending a verification email to prove
        // that would be theatre.
        emailVerifiedAt: new Date(),
        status: 'active',
      },
      update: {
        passwordHash,
        status: 'active',
        deletedAt: null,
        ...(args.name ? { fullName: args.name } : {}),
      },
    });

    await prisma.organisationMember.upsert({
      where: { organisationId_userId: { organisationId: organisation.id, userId: user.id } },
      create: {
        id: randomUUID(),
        organisationId: organisation.id,
        userId: user.id,
        role,
      },
      update: { role },
    });

    // An org Owner or Admin computes Site Admin on every workspace (§3.3), so
    // no per-site membership row is needed — and adding one would be misleading
    // about where the authority comes from.
    const sites = await prisma.workspace.count({
      where: { organisationId: organisation.id, deletedAt: null },
    });

    console.log('');
    console.log('  Account ready.');
    console.log('');
    console.log(`    Email         ${user.email}`);
    console.log(`    Organisation  ${organisation.name} (${organisation.slug})`);
    console.log(`    Org role      ${role}`);
    console.log(`    Sites         ${sites} — inherits Site Admin on all of them`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Picks the organisation to attach to.
 *
 * Named explicitly, else the only one that exists. Guessing between several is
 * refused rather than resolved: putting an Owner in the wrong organisation is
 * a privilege grant, and it should not happen because a flag was omitted.
 */
async function resolveOrganisation(prisma: PrismaClient, name?: string) {
  if (name) {
    const existing = await prisma.organisation.findFirst({
      where: { name, deletedAt: null },
    });
    if (existing) return existing;

    return prisma.organisation.create({
      data: { id: randomUUID(), name, slug: slugify(name) },
    });
  }

  const organisations = await prisma.organisation.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (organisations.length === 1) return organisations[0];

  if (organisations.length === 0) {
    return prisma.organisation.create({
      data: { id: randomUUID(), name: 'My Organisation', slug: slugify('My Organisation') },
    });
  }

  throw new Error(
    `This platform has ${organisations.length} organisations (${organisations
      .map((o) => o.name)
      .join(', ')}). Name the one you mean with --org=<name>.`,
  );
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // The slug is globally unique; a suffix costs nothing and avoids a collision
  // failing the whole run.
  return `${base || 'org'}-${randomUUID().slice(0, 6)}`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

main().catch((error: Error & { detail?: string }) => {
  console.error(`\n  ${error.message}`);
  if (error.detail) console.error(`  ${error.detail}`);
  console.error('');
  process.exit(1);
});
