import { expect, test } from '@playwright/test';

import { loadFixture, sitePath, type Fixture } from './fixture';

/**
 * Sign-in, and the token refresh that nothing was doing.
 *
 * The refresh test is the most valuable thing in this suite. `withRefresh` was
 * wired into exactly one call site, so every save, publish and autosave failed
 * outright once the fifteen-minute access token expired — showing "You are not
 * signed in" to someone who was. No unit or API test could see it: the API was
 * behaving correctly, and the client was the thing at fault.
 *
 * Rather than wait fifteen minutes, the access-token cookie is deleted, which
 * is indistinguishable from expiry as far as the client is concerned.
 */
let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await loadFixture();
});

/**
 * A context with its own session.
 *
 * The refresh tests below cannot share the stored sign-in state: refreshing
 * *rotates* the token, so the first test to refresh invalidates the copy the
 * next one would load, and presenting a superseded token is — correctly — read
 * as replay and revokes the family. Each test therefore owns its own login.
 */
async function freshSession(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const signIn = await context.request.post('/admin/v1/auth/login', {
    data: { email: fixture.email, password: fixture.password },
  });
  if (!signIn.ok()) throw new Error(`Sign-in failed: ${signIn.status()}`);
  return context;
}

/** Removes the access cookie — indistinguishable from expiry to the client. */
async function expireAccessToken(context: import('@playwright/test').BrowserContext) {
  const cookies = await context.cookies();
  await context.clearCookies();
  await context.addCookies(cookies.filter((cookie) => cookie.name !== 'access_token'));
}

test.describe('session', () => {
  test('signs in through the form', async ({ browser }) => {
    // A clean context: this is the one test that must not start signed in.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email').fill(fixture.email);
    await page.getByLabel('Password').fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/login/);
    await context.close();
  });

  test('rejects a wrong password without revealing whether the account exists', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email').fill(fixture.email);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Same message either way — §6.1 treats account enumeration as the leak.
    await expect(page.getByText(/Incorrect email or password/)).toBeVisible();
    await context.close();
  });

  test('refreshes an expired access token instead of failing the save', async ({ browser }) => {
    const context = await freshSession(browser);
    const page = await context.newPage();

    await page.goto(sitePath(fixture, '/settings'));
    await expireAccessToken(context);
    await page.reload();

    // Before the fix this showed "You are not signed in" and stayed there.
    await expect(page.getByText(/not signed in/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Site settings/i })).toBeVisible();

    await context.close();
  });

  test('survives concurrent requests all hitting an expired token', async ({ browser }) => {
    const context = await freshSession(browser);
    const page = await context.newPage();

    await page.goto(sitePath(fixture));
    await expireAccessToken(context);

    // Refresh tokens rotate. Several requests refreshing at once would each
    // present the same token; the first rotates it and the rest look like a
    // replayed stolen token, which revokes the whole session family (§6.1).
    // A single-flight refresh plus a cross-tab Web Lock is what prevents it.
    //
    // Driven by loading a screen that fans out several queries at once, rather
    // than by calling fetch() directly — a raw fetch bypasses the API client,
    // which is where the refresh lives, so it would only ever prove that a bare
    // request 401s.
    await page.goto(sitePath(fixture, '/settings/content-types'));

    await expect(page.getByText(/not signed in/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Content types', exact: true })).toBeVisible();

    // The session must still be usable afterwards — a family revocation would
    // show up here as a redirect to sign-in on the very next navigation.
    await page.goto(sitePath(fixture, '/settings'));
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(/not signed in/)).toHaveCount(0);

    await context.close();
  });
});
