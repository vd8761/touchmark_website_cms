import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { request } from '@playwright/test';

import { AUTH_DIR, saveFixture, type Fixture } from './fixture';

const run = promisify(execFile);
const ROOT = process.cwd();

/**
 * Provisions the tenant the suite runs against, and signs in once.
 *
 * Registration is closed after the platform has its first administrator (a
 * deliberate deviation from the spec), so the account is created through
 * `admin:create` — the same script an operator would use — rather than by
 * poking rows into the database. That keeps the fixture honest: if password
 * policy or the bootstrap rule changes, this breaks, which is the point.
 *
 * Everything else is built over the Admin API rather than through the UI. The
 * tests are about the screens, and driving twelve clicks to reach the one under
 * test makes every failure ambiguous about which step actually broke.
 */
const PASSWORD = 'e2e-browser-suite-password-1';

async function main(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4000';
  const stamp = Date.now();
  const email = `browser-suite-${stamp}@e2e.example.test`;
  // No spaces: this is passed to npm through a shell, where arguments are
  // concatenated rather than escaped, and a space would split the flag.
  const orgName = `browser-suite-${stamp}`;

  await run(
    'npm',
    [
      'run',
      'admin:create',
      '--workspace',
      '@cms/api',
      '--',
      `--email=${email}`,
      `--password=${PASSWORD}`,
      '--name=Browser Suite',
      `--org=${orgName}`,
    ],
    { cwd: ROOT, shell: true },
  );

  const api = await request.newContext({ baseURL });

  const signIn = await api.post('/admin/v1/auth/login', {
    data: { email, password: PASSWORD },
  });
  if (!signIn.ok()) {
    throw new Error(`Fixture sign-in failed (${signIn.status()}): ${await signIn.text()}`);
  }

  const orgs = await (await api.get('/admin/v1/orgs')).json();
  const org = orgs.data.find((candidate: { name: string }) => candidate.name === orgName);
  if (!org) throw new Error(`Fixture organisation "${orgName}" was not created.`);

  const site = (
    await (
      await api.post(`/admin/v1/orgs/${org.id}/workspaces`, { data: { name: 'Suite Site' } })
    ).json()
  ).data;

  const base = `/admin/v1/workspaces/${site.id}`;
  const type = (
    await (await api.post(`${base}/content-types`, { data: { name: 'Article' } })).json()
  ).data;

  await api.post(`${base}/content-types/${type.id}/fields`, {
    data: { name: 'Title', type: 'text', required: true },
  });
  await api.post(`${base}/content-types/${type.id}/fields`, {
    data: { name: 'Body', type: 'rich_text' },
  });

  const entry = (
    await (
      await api.post(`${base}/content/${type.id}`, {
        data: { data: { title: 'the quick brown fox' } },
      })
    ).json()
  ).data;

  const fixture: Fixture = {
    email,
    password: PASSWORD,
    orgSlug: org.slug,
    siteSlug: site.slug,
    workspaceId: site.id,
    typeApiId: type.api_id,
    entryId: entry.id,
  };

  await saveFixture(fixture);

  // Signed-in cookies, reused by every test so none of them spend time on a
  // login form that has its own dedicated test.
  await mkdir(AUTH_DIR, { recursive: true });
  await api.storageState({ path: resolve(AUTH_DIR, 'state.json') });
  await api.dispose();
}

export default main;
