import { expect, test, type Page } from '@playwright/test';

import { loadFixture, sitePath, type Fixture } from './fixture';

/**
 * The content-type builder's field form.
 *
 * Most of what is asserted here is a guard rather than a feature: controls that
 * must disappear for the wrong type, and a save button that must stay disabled
 * for a definition the editor could not render. Those are exactly the things a
 * refactor breaks silently, because nothing throws — you simply end up able to
 * create a relation field pointing at nothing.
 */
let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await loadFixture();
});

async function openBuilder(page: Page) {
  await page.goto(sitePath(fixture, '/settings/content-types'));
  await page.getByRole('button', { name: /Article/ }).first().click();
  await page.getByRole('button', { name: /Add field/ }).click();
}

test.describe('field configuration', () => {
  test('derives the API ID live, and says it is permanent', async ({ page }) => {
    await openBuilder(page);

    await page.getByPlaceholder('Hero Image').fill('Featured Image URL');

    // The same derivation the server applies — shown while it can still be
    // changed, rather than discovered later in a payload.
    await expect(page.getByText('data.featured_image_url')).toBeVisible();
    await expect(page.getByText(/permanent once saved/)).toBeVisible();
  });

  test('shows only the rules the server enforces for the chosen type', async ({ page }) => {
    await openBuilder(page);
    await page.getByPlaceholder('Hero Image').fill('Probe');

    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(page.getByText('Maximum length')).toBeVisible();

    await page.getByRole('button', { name: 'Number', exact: true }).click();
    await expect(page.getByText('Maximum length')).toHaveCount(0);
    await expect(page.getByText('Maximum', { exact: true })).toBeVisible();

    // Nothing in field-validation.ts applies a rule to a date, so offering one
    // would teach people the schema is advisory.
    await page.getByRole('button', { name: 'Date', exact: true }).click();
    await expect(page.getByText('Validation')).toHaveCount(0);
  });

  test('refuses to save a select with no options', async ({ page }) => {
    await openBuilder(page);
    await page.getByPlaceholder('Hero Image').fill('Status');
    await page.getByRole('button', { name: 'Select', exact: true }).click();

    const save = page.getByRole('button', { name: 'Add field', exact: true });
    // An enum with no options renders as an unusable control.
    await expect(save).toBeDisabled();

    await page.getByPlaceholder('value').first().fill('draft');
    await expect(save).toBeEnabled();
  });

  test('refuses to save a reference with no target', async ({ page }) => {
    await openBuilder(page);
    await page.getByPlaceholder('Hero Image').fill('Author');
    await page.getByRole('button', { name: 'Reference', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Add field', exact: true })).toBeDisabled();
    await expect(page.getByText('Links to', { exact: true })).toBeVisible();
  });

  test('previews the control an author will actually see', async ({ page }) => {
    await openBuilder(page);
    await page.getByPlaceholder('Hero Image').fill('Status');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByPlaceholder('value').first().fill('draft');

    const preview = page.locator('aside').filter({ hasText: 'Preview' });
    await expect(preview.locator('select')).toBeVisible();
    await expect(preview.locator('select option')).toHaveCount(2);
  });

  test('creates, edits and deletes a field without losing its API ID', async ({ page }) => {
    await openBuilder(page);

    await page.getByPlaceholder('Hero Image').fill('Read Time');
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: 'Add field', exact: true }).click();

    await expect(page.getByText('read_time')).toBeVisible();

    // Editing a field did not exist at all before — renaming meant deleting and
    // losing every value.
    await page
      .getByRole('listitem')
      .filter({ hasText: 'read_time' })
      .getByRole('button', { name: 'Edit' })
      .click();

    await page.getByPlaceholder('Hero Image').fill('Reading Time');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText('Reading Time')).toBeVisible();
    // The name moves; the identifier consumers read never does.
    await expect(page.getByText('read_time')).toBeVisible();

    // §7.1 two-step deletion: hard-deleting a field consumers still read is the
    // change most likely to break a live site, so the API refuses until it has
    // been deprecated. The UI must surface that rather than appear to succeed.
    const row = () => page.getByRole('listitem').filter({ hasText: 'read_time' });

    await row().getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/has not been deprecated yet/)).toBeVisible();
    await expect(page.getByText('read_time')).toBeVisible();

    // Deprecated: hidden from the editor, still served by the API while
    // consumers migrate.
    await row().getByRole('button', { name: 'Deprecate' }).click();
    await expect(row().getByText('deprecated')).toBeVisible();

    await row().getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('read_time')).toHaveCount(0);
  });
});
