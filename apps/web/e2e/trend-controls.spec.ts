import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test('Trends solely owns chapter marks and the preference survives its Corpus route', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  // Progressive ingestion may initially focus whichever book became ready
  // first. Choose the first declared book explicitly because this contract
  // requires a detected top-level outline.
  await gotoPlace(page, 'corpus');
  await page.getByLabel('Document to preview').selectOption({ index: 0 });
  await gotoPlace(page, 'trends');

  const chapterMarks = page.getByRole('checkbox', {
    name: 'Mark top-level chapters on the chart',
  });
  await expect(chapterMarks).toBeEnabled({ timeout: 30_000 });
  await expect(chapterMarks).not.toBeChecked();
  await expect(page.getByLabel('Document to preview')).toHaveCount(0);

  const beforeToggle = (await trace(page)).events.at(-1)?.seq ?? -1;
  await chapterMarks.check();
  await expect(chapterMarks).toBeChecked();
  await page.waitForTimeout(250);
  expect((await trace(page)).events.filter((event) =>
    event.seq > beforeToggle
    && event.direction === 'to-worker'
    && event.t === 'query')).toEqual([]);

  await page.getByRole('button', { name: /change chapter-mark book, currently/i }).click();
  await expect(page).toHaveURL(/[?&]p=corpus(?:&|$)/);
  await expect(page.getByLabel('Document to preview')).toBeVisible();
  await expect(page.getByRole('checkbox', {
    name: 'Mark top-level chapters on the chart',
  })).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/[?&]p=trends(?:&|$)/);
  await expect(page.getByRole('checkbox', {
    name: 'Mark top-level chapters on the chart',
  })).toBeChecked();
});
