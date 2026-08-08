import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

async function awaitFreshKwic(page: Page, mark: number): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await trace(page);
    const query = snapshot.events.find(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query'
        && event.op === 'kwic',
    );
    if (!query) return 'waiting for query';
    return snapshot.events.some(
      (event) =>
        event.seq > mark
        && event.direction === 'from-worker'
        && event.t === 'result'
        && event.job === query.job,
    )
      ? 'ready'
      : 'waiting for result';
  }, { timeout: 30_000 }).toBe('ready');
}

test('compact Concordance keeps alignment optional and evidence operable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'concordance');

  const controls = page.getByLabel('Concordance display');
  const resultActions = page.getByLabel('Occurrence navigation');
  const port = page.getByRole('region', { name: 'Scrollable concordance table' });
  const table = page.getByRole('table', { name: 'Concordance' });
  await expect(table).toBeVisible({ timeout: 30_000 });

  for (const control of await controls.locator('button, select').all()) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  for (const button of await resultActions.getByRole('button').all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await expect.poll(async () => {
    const portBox = await port.boundingBox();
    const nodeBox = await table.getByRole('columnheader', { name: 'node' }).boundingBox();
    if (!portBox || !nodeBox) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (portBox.x + portBox.width / 2) - (nodeBox.x + nodeBox.width / 2),
    );
  }).toBeLessThanOrEqual(2);

  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByLabel('Shown context characters').selectOption('12');
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);
  const firstLeft = table.locator('tbody tr').first().locator('.kwic-left-context');
  const shown = firstLeft.locator('[aria-hidden="true"]');
  const complete = firstLeft.locator('.visually-hidden');
  await expect(shown).not.toHaveText('');
  expect((await complete.textContent())!.length).toBeGreaterThan(
    (await shown.textContent())!.length,
  );

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByRole('button', { name: 'wrapped' }).click();
  await expect(page.getByRole('note')).toHaveText('Alignment is off in reading mode.');
  await expect(table).toHaveCount(0);
  await expect(page.getByLabel('Concordance reading view')).toBeVisible();
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query',
  )).toEqual([]);

  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await controls.getByLabel('Concordance order').selectOption('L1');
  await awaitFreshKwic(page, mark);
  const sortQueries = (await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'kwic',
  );
  expect(sortQueries).toHaveLength(1);
  await expect(page.getByText(/first L1 collocate/)).toBeVisible();
  await expect(page.getByText(/reading position is not used/)).toBeVisible();

  await resultActions.getByRole('button', { name: 'next', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Evidence' })
    .getByRole('button', { name: 'Inspect', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);
  await expect(resultActions.locator('output')).toHaveText(`1 / ${await page.getByLabel('Concordance reading view').locator('.kwic-reading-row').count()}`);

  await controls.getByRole('button', { name: 'aligned' }).click();
  await expect(table).toBeVisible();
  await resultActions.getByRole('button', { name: 'recenter node' }).click();
  await expect.poll(async () => {
    const portBox = await port.boundingBox();
    const nodeBox = await table.getByRole('columnheader', { name: 'node' }).boundingBox();
    if (!portBox || !nodeBox) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (portBox.x + portBox.width / 2) - (nodeBox.x + nodeBox.width / 2),
    );
  }).toBeLessThanOrEqual(2);

  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(overflow.client);
  expect(overflow.body).toBeLessThanOrEqual(overflow.client);
});
