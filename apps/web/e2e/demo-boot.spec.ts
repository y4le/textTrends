import { expect, test } from '@playwright/test';
import { openQuickAdd, workspaceRecord } from './helpers.ts';

test('declining a URL demo keeps edits made during its download', async ({ page }) => {
  let finishDownload!: () => void;
  const download = new Promise<void>((resolve) => { finishDownload = resolve; });
  await page.route('**/corpora/sherlock/**', async (route) => {
    await download;
    await route.continue();
  });
  await page.goto('./?demo=sherlock');
  const term = await openQuickAdd(page);
  await term.fill('wolf');
  await term.press('Enter');
  const confirmation = new Promise<string>((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  finishDownload();
  expect(await confirmation).toContain('Replace your active texts and term notebook');
  await expect(page.getByText(/Replacement cancelled. Your workspace was kept/)).toBeVisible();
  await expect(page.locator('.term-bucket-toggle')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.term-bucket-toggle')).toHaveAccessibleName('Shown in analysis: wolf');
  expect(new URL(page.url()).searchParams.has('demo')).toBe(false);
});

test('a failed URL demo preserves edits autosaved during its download', async ({ page }) => {
  let failDownload!: () => void;
  const download = new Promise<void>((resolve) => { failDownload = resolve; });
  await page.route('**/corpora/sherlock/**', async (route) => {
    await download;
    await route.abort('failed');
  });
  await page.goto('./?demo=sherlock');
  const term = await openQuickAdd(page);
  await term.fill('wolf');
  await term.press('Enter');
  await expect.poll(async () => {
    const record = await workspaceRecord(page) as { notebook?: { groups?: unknown[] } } | undefined;
    return record?.notebook?.groups?.length;
  }).toBe(1);

  failDownload();
  await expect(page.getByText(/demo could not be loaded/)).toBeVisible();
  await expect.poll(async () => {
    const record = await workspaceRecord(page) as { notebook: { groups: unknown[] } };
    return record.notebook.groups.length;
  }).toBe(1);
  await page.reload();
  await expect(page.locator('.term-bucket-toggle')).toHaveCount(1);
  await expect(page.locator('.term-bucket-toggle')).toHaveAccessibleName('Shown in analysis: wolf');
});
