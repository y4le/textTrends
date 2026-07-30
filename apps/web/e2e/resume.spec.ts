import { expect, test } from '@playwright/test';
import { awaitAllReady, trace } from './helpers.ts';
import { PLACE_HEADING } from '../src/lib/places.ts';

test('the migration page exposes every canonical place as a real heading', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);
  const headings = Object.values(PLACE_HEADING);
  for (const heading of headings) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    const region = page.getByRole('region', { name: heading, exact: true });
    await expect(region).toBeVisible();
    for (const peer of headings) {
      if (peer !== heading) {
        await expect(region.getByRole('region', { name: peer, exact: true })).toHaveCount(0);
      }
    }
  }
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
