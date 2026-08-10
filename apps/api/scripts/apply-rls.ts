/**
 * Applies prisma/rls.sql as the database owner.
 *
 * Run after every migration — `npm run db:migrate && npm run db:rls`. Prisma
 * Migrate does not manage policies or roles, so they live in a file it will not
 * overwrite and are applied separately.
 *
 * Uses a raw `pg` client rather than Prisma: Prisma sends every statement as a
 * prepared statement, and prepared statements cannot carry multiple commands.
 * rls.sql is one script with DO blocks, so it needs the simple query protocol.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

/**
 * The Prisma CLI loads .env for you; a plain script does not. Load the same
 * files the API does, so `npm run db:rls` and `npm run dev` see one config.
 */
for (const candidate of [
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '..', '..', '.env'),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('Set DATABASE_ADMIN_URL (or DATABASE_URL) before applying RLS policies.');
  }

  const sql = readFileSync(join(__dirname, '..', 'prisma', 'rls.sql'), 'utf8');
  const client = new Client({ connectionString: adminUrl });

  await client.connect();
  try {
    await client.query(sql);
    console.log('Row-level security policies applied.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Failed to apply RLS policies:', error.message ?? error);
  process.exit(1);
});
