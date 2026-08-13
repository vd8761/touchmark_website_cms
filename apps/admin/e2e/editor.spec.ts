import { expect, test, type Page } from '@playwright/test';

import { entryPath, loadFixture, type Fixture } from './fixture';

/**
 * The block editor and autosave.
 *
 * Both were shipped with unit and API coverage and no browser coverage at all,
 * and the first manual session found a bug in each. The slash-menu case below
 * is the exact regression: `/head` + Enter produced a heading reading
 * "/hWhy foxes matter", because the deletion range came from React state that
 * lags behind fast typing. Playwright types at that speed by default, which is
 * precisely why it catches it.
 */
let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await loadFixture();
});

const editor = (page: Page) => page.locator('.ProseMirror');

/** The slash menu itself, so assertions cannot match the document's own text. */
const slashMenu = (page: Page) => page.locator('.absolute.z-20');
const outline = (page: Page) => page.locator('aside').filter({ hasText: 'Outline' });

/** Clears the body so each test starts from a known document. */
async function resetBody(page: Page, entryId: string) {
  await page.request.patch(
    `/admin/v1/workspaces/${fixture.workspaceId}/content/entries/${entryId}`,
    { data: { data: { body: { type: 'doc', content: [{ type: 'paragraph' }] } } } },
  );
}

/**
 * A fresh entry per test.
 *
 * Autosave means these tests write on a timer; sharing one entry would let a
 * pending save from the previous test land in the middle of the next one.
 */
async function createEntry(page: Page, title: string): Promise<string> {
  const response = await page.request.post(
    `/admin/v1/workspaces/${fixture.workspaceId}/content/${fixture.typeApiId}`,
    { data: { data: { title } } },
  );
  return (await response.json()).data.id as string;
}

test.describe('block editor', () => {
  test('opens as a block editor, not a JSON textarea', async ({ page }) => {
    const entryId = await createEntry(page, 'Mounts');
    await page.goto(entryPath(fixture, entryId));

    await expect(editor(page)).toBeVisible();
    await expect(page.getByText('Press / for blocks')).toBeVisible();
    // The chunk is lazy-loaded; the skeleton must resolve to a real editor.
    await expect(page.locator('textarea')).toHaveCount(0);
  });

  test('removes the slash query when inserting a block', async ({ page }) => {
    const entryId = await createEntry(page, 'Slash query');
    await page.goto(entryPath(fixture, entryId));
    await resetBody(page, entryId);
    await page.reload();

    await editor(page).click();
    await page.keyboard.type('/head');

    // The menu filters as you type.
    await expect(slashMenu(page).getByText('Heading 2')).toBeVisible();
    await expect(slashMenu(page).getByText('Bullet list')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await page.keyboard.type('Why foxes matter');

    const heading = editor(page).locator('h2');
    await expect(heading).toHaveText('Why foxes matter');
    // The regression: "/h" was left in front of the text.
    await expect(heading).not.toContainText('/');
  });

  test('does not open the menu for a slash mid-word', async ({ page }) => {
    const entryId = await createEntry(page, 'Mid-word slash');
    await page.goto(entryPath(fixture, entryId));

    await editor(page).click();
    await page.keyboard.type('and/or');

    // Typing "and/or" must not pop a block menu into the middle of a sentence.
    await expect(slashMenu(page)).toHaveCount(0);
    await expect(editor(page)).toContainText('and/or');
  });

  test('closes the menu on Escape without inserting', async ({ page }) => {
    const entryId = await createEntry(page, 'Escape');
    await page.goto(entryPath(fixture, entryId));

    await editor(page).click();
    await page.keyboard.type('/quote');
    await expect(slashMenu(page).getByText('Quote', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(slashMenu(page)).toHaveCount(0);
    // Escape dismisses; it must not run the highlighted command on the way out.
    await expect(editor(page).locator('blockquote')).toHaveCount(0);
  });

  test('builds a heading outline that navigates', async ({ page }) => {
    const entryId = await createEntry(page, 'Outline');
    await page.goto(entryPath(fixture, entryId));
    await resetBody(page, entryId);
    await page.reload();

    await editor(page).click();
    await page.keyboard.type('/head');
    await page.keyboard.press('Enter');
    await page.keyboard.type('First section');

    await expect(outline(page).getByRole('button', { name: 'First section' })).toBeVisible();
  });

  test('formats a selection from the toolbar without losing it', async ({ page }) => {
    const entryId = await createEntry(page, 'Bold');
    await page.goto(entryPath(fixture, entryId));
    await resetBody(page, entryId);
    await page.reload();

    await editor(page).click();
    await page.keyboard.type('make this bold');
    await page.keyboard.press('ControlOrMeta+a');

    // mousedown must be prevented on the toolbar, or the editor blurs and the
    // selection the command acts on is gone before it runs.
    await page.getByRole('button', { name: 'B', exact: true }).first().click();

    await expect(editor(page).locator('strong')).toHaveText('make this bold');
  });

  test('round-trips a document through a reload', async ({ page }) => {
    const entryId = await createEntry(page, 'Round trip');
    await page.goto(entryPath(fixture, entryId));
    await resetBody(page, entryId);
    await page.reload();

    await editor(page).click();
    await page.keyboard.type('/head');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Persisted heading');

    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(page.getByText(/Saved/)).toBeVisible();

    await page.reload();
    await expect(editor(page).locator('h2')).toHaveText('Persisted heading');
  });
});

test.describe('autosave', () => {
  test('saves a draft after a pause, without pressing anything', async ({ page }) => {
    const entryId = await createEntry(page, 'Autosave');
    await page.goto(entryPath(fixture, entryId));
    await resetBody(page, entryId);
    await page.reload();

    await editor(page).click();
    await page.keyboard.type('Typed and left alone.');

    // 3s of inactivity, per §7.3.
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(editor(page)).toContainText('Typed and left alone.');
  });

  test('collapses a burst of autosaves into one version', async ({ page }) => {
    const entryId = await createEntry(page, 'Version churn');
    await page.goto(entryPath(fixture, entryId));

    const versionsUrl = `/admin/v1/workspaces/${fixture.workspaceId}/content/entries/${entryId}/versions`;
    const before = (await (await page.request.get(versionsUrl)).json()).data.length;

    await editor(page).click();
    for (const word of ['One. ', 'Two. ', 'Three. ']) {
      await page.keyboard.type(word);
      await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 15_000 });
    }

    const after = (await (await page.request.get(versionsUrl)).json()).data.length;

    // Without coalescing this is one version per save, and 50-version retention
    // would evict every real restore point within minutes of typing.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  test('does not autosave a published entry', async ({ page }) => {
    const entryId = await createEntry(page, 'Published entry');
    await page.request.post(
      `/admin/v1/workspaces/${fixture.workspaceId}/content/entries/${entryId}/publish`,
      { data: {} },
    );

    await page.goto(entryPath(fixture, entryId));
    await editor(page).click();
    await page.keyboard.type('Edited after publishing.');

    // Flipping a live page into "has unpublished changes" because someone typed
    // one character is not the editor's decision to make.
    await expect(page.getByText(/published entries do not autosave/)).toBeVisible();
    await expect(page.getByText(/^Saved at /)).toHaveCount(0);
  });

  test('warns before leaving with unsaved changes', async ({ page }) => {
    const entryId = await createEntry(page, 'Unsaved guard');
    await page.goto(entryPath(fixture, entryId));

    await page.getByRole('textbox').first().fill('Changed but not saved');

    let dialogSeen = false;
    page.on('dialog', (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });

    await page.evaluate(() => {
      window.location.href = '/';
    });
    await page.waitForTimeout(1000);

    expect(dialogSeen).toBe(true);
  });
});
