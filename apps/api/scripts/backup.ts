import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { config as loadEnv } from 'dotenv';

const run = promisify(execFile);

loadEnv({ path: resolve(__dirname, '..', '..', '..', '.env') });

/**
 * Snapshot and restore, because "an untested backup is not a backup" (§18.3).
 *
 * This is not a production backup strategy — that is streaming replication and
 * PITR, and it belongs in infrastructure rather than in the repo. What this is
 * is the safety net for the operations that actually destroy data during
 * development: `db:reset`, the e2e teardown, a purge run with the windows set
 * too short, and any hand-written query that turns out to match more rows than
 * intended.
 *
 * The cost of not having it was demonstrated the hard way: a cleanup that
 * looked routine, no snapshot, and no way to answer "what did that just
 * delete?" — because the audit rows explaining a deletion cascade with the
 * thing deleted.
 *
 *   npm run db:backup  --workspace @cms/api            # snapshot now
 *   npm run db:backup  --workspace @cms/api -- --list  # what do I have
 *   npm run db:restore --workspace @cms/api -- --file=<name>
 *
 * Restores go through `pg_restore --clean`, which drops and recreates every
 * object it owns. That is destructive by definition, so it refuses to run
 * without --yes.
 */

const BACKUP_DIR = resolve(__dirname, '..', '..', '..', '.backups');
/** Snapshots are cheap; a disk full of them is not. */
const KEEP = 20;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = process.env.BACKUP_MODE ?? 'dump';

  await mkdir(BACKUP_DIR, { recursive: true });

  if (args.list !== undefined) return list();
  if (mode === 'restore') return restore(args);
  return dump(args.label);
}

/**
 * The admin URL, not the application's.
 *
 * `cms_app` is deliberately not the table owner and carries NOBYPASSRLS, so a
 * dump taken as that role would silently contain only the rows RLS lets it see
 * — which is to say almost nothing, since no workspace scope is set. A backup
 * that restores as an empty database is worse than no backup, because you
 * believe you have one.
 */
function connectionUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error(
      'DATABASE_ADMIN_URL is not set. A dump taken as the application role would be ' +
        'filtered by row-level security and would restore as an empty database.',
    );
  }
  // `?schema=public` is a Prisma extension; libpq rejects it as an unknown URI
  // parameter, so pg_dump refuses the connection string Prisma is happy with.
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

/**
 * Where to find pg_dump/pg_restore.
 *
 * A local client is used when there is one. Otherwise the tools are run inside
 * the Postgres container this repo already brings up — the client version then
 * always matches the server, which is the usual reason a dump refuses to
 * restore. `docker compose exec -T` streams, so the file still lands on the
 * host and the container needs no volume mount.
 */
async function resolveClient(): Promise<{ kind: 'local' } | { kind: 'docker' }> {
  try {
    await run('pg_dump', ['--version']);
    return { kind: 'local' };
  } catch {
    // Fall through.
  }

  try {
    await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '--version'], {
      cwd: resolve(__dirname, '..', '..', '..'),
    });
    return { kind: 'docker' };
  } catch {
    throw new Error(
      'Neither a local pg_dump nor the postgres container is available. Install the ' +
        'PostgreSQL client tools, or start the database with `npm run db:up`.',
    );
  }
}

/** Inside the container the server is always on localhost:5432. */
function containerUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = 'localhost';
  parsed.port = '5432';
  return parsed.toString();
}

async function dump(label?: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}${label ? `-${slug(label)}` : ''}.dump`;
  const target = resolve(BACKUP_DIR, name);
  const client = await resolveClient();

  // Custom format: compressed, and restorable selectively with pg_restore.
  if (client.kind === 'local') {
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', target, connectionUrl()]);
  } else {
    const out = createWriteStream(target);
    const child = spawn(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '--format=custom',
        '--no-owner',
        containerUrl(connectionUrl()),
      ],
      { cwd: resolve(__dirname, '..', '..', '..') },
    );

    child.stdout.pipe(out);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    await new Promise<void>((done, fail) => {
      child.on('error', fail);
      child.on('close', (code) =>
        code === 0 ? done() : fail(new Error(stderr.trim() || `pg_dump exited ${code}`)),
      );
    });
  }

  const { size } = await stat(target);
  console.log(`\n  Snapshot written: .backups/${name} (${(size / 1_048_576).toFixed(1)} MB)`);
  console.log(`  Restore with: npm run db:restore --workspace @cms/api -- --file=${name} --yes\n`);

  await prune();
}

async function restore(args: Record<string, string | undefined>): Promise<void> {
  const file = args.file;
  if (!file) throw new Error('Pass --file=<name>. Use --list to see what is available.');
  if (args.yes === undefined) {
    throw new Error(
      `This DROPS and recreates every table in the target database before loading ${file}. ` +
        'Re-run with --yes if that is what you want.',
    );
  }

  const source = resolve(BACKUP_DIR, basename(file));
  await stat(source);
  const client = await resolveClient();

  // pg_restore exits non-zero on benign notices — dropping objects that were
  // never there — so only lines it marks as errors should stop the script.
  const tolerate = (stderr: string) => {
    const fatal = stderr.split('\n').filter((line) => line.includes('error:'));
    if (fatal.length > 0) throw new Error(fatal.slice(0, 5).join('\n'));
  };

  // --clean --if-exists so a restore onto a populated database replaces it
  // rather than failing on every conflicting object.
  if (client.kind === 'local') {
    await run('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--dbname',
      connectionUrl(),
      source,
    ]).catch((error: Error & { stderr?: string }) => tolerate(error.stderr ?? ''));
  } else {
    const child = spawn(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--dbname',
        containerUrl(connectionUrl()),
      ],
      { cwd: resolve(__dirname, '..', '..', '..') },
    );

    createReadStream(source).pipe(child.stdin);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    await new Promise<void>((done, fail) => {
      child.on('error', fail);
      child.on('close', () => {
        try {
          tolerate(stderr);
          done();
        } catch (error) {
          fail(error as Error);
        }
      });
    });
  }

  console.log(`\n  Restored from ${file}.`);
  console.log('  Re-apply RLS policies now: npm run db:rls --workspace @cms/api\n');
}

async function list(): Promise<void> {
  const files = (await readdir(BACKUP_DIR).catch(() => [])).filter((f) => f.endsWith('.dump'));
  if (files.length === 0) {
    console.log('\n  No snapshots yet.\n');
    return;
  }

  console.log('');
  for (const file of files.sort().reverse()) {
    const { size, mtime } = await stat(resolve(BACKUP_DIR, file));
    console.log(
      `  ${file}  ${(size / 1_048_576).toFixed(1).padStart(6)} MB  ${mtime.toLocaleString()}`,
    );
  }
  console.log('');
}

async function prune(): Promise<void> {
  const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.dump')).sort();
  for (const file of files.slice(0, Math.max(0, files.length - KEEP))) {
    await unlink(resolve(BACKUP_DIR, file));
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) parsed[match[1]] = match[2] ?? '';
  }
  return parsed;
}

main().catch((error: Error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
});
