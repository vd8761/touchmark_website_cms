import { defineConfig, devices } from '@playwright/test';

/**
 * Browser coverage for the admin portal (§11.9).
 *
 * The portal had none. Everything was verified by typecheck, unit tests and
 * API-level e2e — which between them missed four real bugs found in a single
 * manual browser session, including one that stopped every save working after
 * fifteen minutes and one that signed a user out for having two tabs open.
 * Those classes of failure only exist in a browser, so that is where they have
 * to be tested.
 *
 * Runs against the **built** portal served by the API, not the Vite dev server.
 * One origin is what makes session cookies work at all (they are SameSite=Lax),
 * and it is what production looks like — testing against a proxied dev server
 * would exercise a setup nobody deploys.
 */
export default defineConfig({
  testDir: './apps/admin/e2e',
  // These drive one shared database; running files in parallel would have them
  // renaming each other's fixtures.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000',
    // Artifacts only for failures — a green run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  globalSetup: './apps/admin/e2e/global-setup.ts',
  globalTeardown: './apps/admin/e2e/global-teardown.ts',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'apps/admin/e2e/.auth/state.json' },
    },
  ],

  /**
   * Starts the API — which also serves the built portal — unless something is
   * already listening. `reuseExistingServer` keeps a local run fast; CI always
   * starts its own.
   */
  webServer: {
    command: 'npm run start --workspace @cms/api',
    url: 'http://localhost:4000/v1/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
