import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * The tenant the browser suite runs against.
 *
 * Created fresh per run and removed afterwards, because these tests type into
 * editors and delete fields — pointing them at a developer's own site would
 * quietly rewrite real content. The ids are written to disk so the tests and
 * the teardown can both find them without sharing process memory.
 *
 * The account is deliberately its own: reusing a human's login would mean the
 * suite's failures depend on whatever that person last did to their password.
 */
export interface Fixture {
  email: string;
  password: string;
  orgSlug: string;
  siteSlug: string;
  workspaceId: string;
  typeApiId: string;
  entryId: string;
}

/**
 * Anchored to the repo root, not to this file.
 *
 * Playwright loads these as ES modules, where `__dirname` does not exist, and
 * it resolves the config's directory as the working directory — so this is
 * stable whichever workspace the command was run from.
 */
export const AUTH_DIR = resolve(process.cwd(), 'apps', 'admin', 'e2e', '.auth');
const STATE_PATH = resolve(AUTH_DIR, 'fixture.json');

export async function saveFixture(fixture: Fixture): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(fixture, null, 2));
}

export async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(STATE_PATH, 'utf8')) as Fixture;
}

/** Where an entry of the fixture type lives, for the tests that open one. */
export function entryPath(fixture: Fixture, entryId = fixture.entryId): string {
  return `/o/${fixture.orgSlug}/s/${fixture.siteSlug}/content/${fixture.typeApiId}/${entryId}`;
}

export function sitePath(fixture: Fixture, suffix = ''): string {
  return `/o/${fixture.orgSlug}/s/${fixture.siteSlug}${suffix}`;
}
