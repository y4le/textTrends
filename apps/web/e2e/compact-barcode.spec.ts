import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

async function awaitFreshKwic(
  page: import('@playwright/test').Page,
  mark: number,
): Promise<void> {
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

test('coarse pointers read the dense barcode through one focused 48px stepper', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'trends');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const canvas = page.locator('canvas[data-pointer-contract="scrub-only"]');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

  const stepper = page.getByRole('group', { name: 'Barcode occurrence navigation' });
  await expect(stepper).toBeVisible();
  await expect(stepper.getByRole('button')).toHaveCount(2);
  await expect(stepper.getByRole('button', { name: 'Previous Holmes occurrence' })).toBeVisible();
  const buttons = await stepper.getByRole('button').all();
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(48);
    expect(box?.width).toBeGreaterThanOrEqual(48);
  }

  await stepper.getByRole('button', { name: 'Next Holmes occurrence' }).click();
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await expect(scrubber).toHaveAttribute('aria-valuetext', /token \d+ of/);
  await expect(page.getByRole('main', { name: /Reader:/ })).toHaveCount(0);

  const captions = [await scrubber.getAttribute('aria-valuetext')];
  await gotoPlace(page, 'concordance');
  let mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel('Concordance order').selectOption('L1');
  await awaitFreshKwic(page, mark);
  await gotoPlace(page, 'trends');
  mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  for (let index = 0; index < 2; index++) {
    await stepper.getByRole('button', { name: 'Next Holmes occurrence' }).click();
    await expect(scrubber).not.toHaveAttribute('aria-valuetext', captions.at(-1)! ?? '');
    captions.push(await scrubber.getAttribute('aria-valuetext'));
  }
  expect(new Set(captions).size).toBe(3);
  expect((await trace(page)).events.filter(
    (event) =>
      event.seq > mark
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'kwic',
  )).toEqual([]);

  await page
    .getByRole('group', { name: 'Query terms' })
    .getByRole('button', { name: /^Moriarty \d+$/ })
    .click();
  await expect(stepper.getByRole('button', { name: 'Next Moriarty occurrence' })).toBeVisible();
  await expect(stepper.getByRole('button', { name: 'Next Holmes occurrence' })).toHaveCount(0);

  await context.close();
});
