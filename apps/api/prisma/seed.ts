/**
 * Development seed — one organisation, two sites, one user per role.
 *
 * Two sites exist deliberately: the site switcher, cross-tenant behaviour and
 * the isolation guarantees are all invisible with only one.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { hash as argonHash } from '@node-rs/argon2';
import { v7 as uuidv7 } from 'uuid';

// Loaded explicitly so `ts-node prisma/seed.ts` behaves like `prisma db seed`.
for (const candidate of [join(__dirname, '..', '.env'), join(__dirname, '..', '..', '..', '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

// Seeding writes rows across many workspaces at once, which the row-level
// security policies exist precisely to prevent. It therefore connects as the
// owner rather than as the application role.
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

const PASSWORD = 'development-password-1';

const PEOPLE = [
  { email: 'owner@example.test', name: 'Olivia Owner', orgRole: 'owner' as const, siteRole: null },
  { email: 'admin@example.test', name: 'Adam Admin', orgRole: 'admin' as const, siteRole: null },
  { email: 'editor@example.test', name: 'Esha Editor', orgRole: 'member' as const, siteRole: 'editor' as const },
  { email: 'author@example.test', name: 'Arun Author', orgRole: 'member' as const, siteRole: 'author' as const },
  { email: 'marketer@example.test', name: 'Maya Marketer', orgRole: 'member' as const, siteRole: 'marketer' as const },
  { email: 'analyst@example.test', name: 'Ana Analyst', orgRole: 'member' as const, siteRole: 'analyst' as const },
];

async function main(): Promise<void> {
  const passwordHash = await argonHash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const org = await prisma.organisation.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { id: uuidv7(), name: 'Acme Inc', slug: 'acme', plan: 'growth' },
  });

  const sites = [];
  for (const [index, config] of [
    { name: 'Marketing Site', slug: 'marketing', colour: '#4F46E5', timezone: 'Asia/Kolkata' },
    { name: 'Docs Site', slug: 'docs', colour: '#059669', timezone: 'UTC' },
  ].entries()) {
    const site = await prisma.workspace.upsert({
      where: { organisationId_slug: { organisationId: org.id, slug: config.slug } },
      update: {},
      create: {
        id: uuidv7(),
        organisationId: org.id,
        name: config.name,
        slug: config.slug,
        colour: config.colour,
        timezone: config.timezone,
        defaultLocale: 'en',
        locales: index === 0 ? ['en', 'de'] : ['en'],
        primaryUrl: `https://${config.slug}.example.com`,
      },
    });
    sites.push(site);
  }

  for (const person of PEOPLE) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: {},
      create: {
        id: uuidv7(),
        email: person.email,
        fullName: person.name,
        passwordHash,
        emailVerifiedAt: new Date(),
        timezone: 'Asia/Kolkata',
      },
    });

    await prisma.organisationMember.upsert({
      where: { organisationId_userId: { organisationId: org.id, userId: user.id } },
      update: { role: person.orgRole },
      create: { id: uuidv7(), organisationId: org.id, userId: user.id, role: person.orgRole },
    });

    // Org Owners and Admins inherit Site Admin (§3.3) and need no rows.
    if (!person.siteRole) continue;

    for (const site of sites) {
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: site.id, userId: user.id } },
        update: { role: person.siteRole },
        create: { id: uuidv7(), workspaceId: site.id, userId: user.id, role: person.siteRole },
      });
    }
  }

  console.log(`Seeded "${org.name}" with ${sites.length} sites and ${PEOPLE.length} users.`);
  console.log(`Sign in as any of: ${PEOPLE.map((p) => p.email).join(', ')}`);
  console.log(`Password for all: ${PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
