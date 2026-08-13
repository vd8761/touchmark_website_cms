import { request } from '@playwright/test';

import { loadFixture } from './fixture';

/**
 * Removes the tenant the suite created.
 *
 * The API's own Jest teardown matches the same `@e2e.example.test` marker, so
 * anything missed here is swept up the next time that suite runs. This exists
 * so a browser run on its own does not leave a site behind in the sidebar.
 *
 * Never fatal: the tests have already reported their result by this point, and
 * a cleanup failure turning a green run red would train people to ignore it.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_FIXTURE === 'true') return;

  try {
    const fixture = await loadFixture();
    const api = await request.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000',
    });

    await api.post('/admin/v1/auth/login', {
      data: { email: fixture.email, password: fixture.password },
    });

    // Site deletion needs the name typed back, exactly as the UI requires.
    await api.delete(`/admin/v1/workspaces/${fixture.workspaceId}`, {
      data: { confirm_name: 'Suite Site' },
    });

    await api.dispose();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Browser fixture cleanup skipped: ${(error as Error).message}`);
  }
}
