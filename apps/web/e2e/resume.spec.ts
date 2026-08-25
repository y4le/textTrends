import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';
import { PLACE_HEADING, PLACES } from '../src/lib/places.ts';

test('every route exposes one canonical place and no canonical peer', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  for (const place of PLACES) {
    await gotoPlace(page, place);
    await expect(page.getByRole('button', { name: 'Settings', exact: true }))
      .toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Terms' }))
      .toHaveCount(1);
    for (const [candidate, heading] of Object.entries(PLACE_HEADING)) {
      const expected = candidate === place ? 1 : 0;
      await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(0);
      await expect(page.getByRole('region', { name: heading, exact: true })).toHaveCount(expected);
    }
  }
});

test('Vocabulary additions beyond five persist hidden and open in the manager', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await submitAndAwaitFreshResults(page, 'alpha, beta, gamma, delta, epsilon');

  await gotoPlace(page, 'vocabulary');
  const vocabulary = page.getByRole('table', { name: 'Vocabulary frequency list' });
  await expect(vocabulary).toBeVisible();
  const firstRow = vocabulary.locator('tr[data-frequency-row]').first();
  const key = (await firstRow.locator('.frequency-term-label').innerText()).trim();
  await firstRow.getByRole('button').click();
  await vocabulary.getByRole('button', { name: 'add exact' }).first().click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  await expect(manager).toBeVisible();
  await expect(manager.getByRole('textbox', { name: `Term and aliases for ${key}` })).toBeFocused();
  await expect(manager.getByRole('checkbox', { name: `Shown in analysis: ${key}` }))
    .not.toBeChecked();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
});

test('resume reconciles visible state without claiming background work or issuing queries', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  const status = page.getByTestId('resume-status');
  await expect(status).toHaveText('Resumed · local results and scope are reconciled.');
  await expect(status).not.toContainText(/continued|completed|kept running|background/i);
  await expect(status).toHaveAttribute('data-resume-revision', '1');

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByTestId('resume-status')).toHaveAttribute('data-resume-revision', '2');

  const queryOps = (await trace(page)).events.filter((event) =>
    event.seq > mark
    && event.direction === 'to-worker'
    && event.t === 'query');
  expect(queryOps).toEqual([]);
});
