import { expect, test } from '@playwright/test';
import { awaitAllReady, clearNotebook, gotoPlace, openQuickAdd, trace } from './helpers.ts';
import { PLACE_HEADING, PLACES } from '../src/lib/places.ts';

test('every route exposes one canonical place and no canonical peer', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  for (const place of PLACES) {
    await gotoPlace(page, place);
    const methodLabel = place === 'trends' ? 'Method & settings' : 'Method';
    await expect(page.getByRole('button', { name: methodLabel, exact: true })).toHaveCount(1);
    await expect(page.locator('details.method-summary')).toHaveCount(0);
    for (const [candidate, heading] of Object.entries(PLACE_HEADING)) {
      const expected = candidate === place ? 1 : 0;
      await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(expected);
      await expect(page.getByRole('region', { name: heading, exact: true })).toHaveCount(expected);
    }
  }
});

test('Vocabulary notebook refusals are visible at the action and cleared on departure', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  await clearNotebook(page);
  const quickAdd = await openQuickAdd(page);
  await quickAdd.fill('alpha, beta, gamma, delta, epsilon');
  await quickAdd.press('Enter');

  await gotoPlace(page, 'vocabulary');
  const vocabulary = page.getByRole('table', { name: 'Vocabulary frequency list' });
  await expect(vocabulary).toBeVisible();
  await vocabulary.locator('tr[data-frequency-row]').first().getByRole('button').click();
  await vocabulary.getByRole('button', { name: 'add exact' }).first().click();
  await expect(page.getByRole('alert')).toContainText(
    'deactivate a group before adding this frequency-table term',
  );

  await gotoPlace(page, 'corpus');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('resume reconciles visible state without claiming background work or issuing queries', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
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
