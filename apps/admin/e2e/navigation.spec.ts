import { expect, test } from '@playwright/test';

import { loadFixture, sitePath, type Fixture } from './fixture';

/**
 * Sidebar highlighting — a reported bug, now pinned.
 *
 * `NavLink` matches by path prefix, and this sidebar nests destinations inside
 * one another: "Site settings" is `settings`, while Content model, Site
 * members, Sending and Audit log all live beneath it. Prefix matching lit up
 * Site settings on every one of those pages, and `settings/org/email` lit three
 * rows at once — so the sidebar stopped answering the one question it exists to
 * answer.
 *
 * The assertions are deliberately about what is *not* highlighted. Checking
 * only that the right row is active would have passed throughout the bug.
 */
let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await loadFixture();
});

/** The active row is the one carrying aria-current, as NavLink sets it. */
function activeLinks(page: import('@playwright/test').Page) {
  return page.locator('nav a[aria-current="page"]');
}

test.describe('sidebar navigation', () => {
  test('highlights only Content model on the content model page', async ({ page }) => {
    await page.goto(sitePath(fixture, '/settings/content-types'));

    await expect(activeLinks(page)).toHaveCount(1);
    await expect(activeLinks(page)).toHaveText('Content model');
  });

  test('highlights only Site settings on the settings page', async ({ page }) => {
    await page.goto(sitePath(fixture, '/settings'));

    await expect(activeLinks(page)).toHaveCount(1);
    await expect(activeLinks(page)).toHaveText('Site settings');
  });

  test('highlights only Site members, not its parent', async ({ page }) => {
    await page.goto(sitePath(fixture, '/settings/members'));

    await expect(activeLinks(page)).toHaveCount(1);
    await expect(activeLinks(page)).toHaveText('Site members');
  });

  test('highlights one row on the deepest nested page', async ({ page }) => {
    // The original report's worst case: this lit Email configurations,
    // Organisation settings *and* Site settings simultaneously.
    await page.goto(sitePath(fixture, '/settings/org/email'));

    await expect(activeLinks(page)).toHaveCount(1);
    await expect(activeLinks(page)).toHaveText('Email configurations');
  });

  test('keeps the content type highlighted while inside the entry editor', async ({ page }) => {
    // Prefix matching is *wanted* here — an item with no nav children keeps it,
    // which is what stops the sidebar going blank while you edit.
    await page.goto(sitePath(fixture, `/content/${fixture.typeApiId}/${fixture.entryId}`));

    await expect(activeLinks(page)).toHaveCount(1);
    await expect(activeLinks(page)).toHaveText('Article');
  });

  test('marks unbuilt sections as Soon rather than hiding them', async ({ page }) => {
    await page.goto(sitePath(fixture));

    // Phases 3-5 have tables and Delivery endpoints but no admin screens.
    // Saying so is more useful than a dead link or a missing section.
    for (const label of ['Subscribers', 'Lists & segments', 'Forms', 'Campaigns', 'Automations']) {
      await expect(page.getByRole('link', { name: new RegExp(`^${label}` ) })).toContainText('Soon');
    }
  });
});
