import { expect, test } from '@playwright/test';
import { awaitAllReady, DOC_COUNT, gotoPlace, trace } from './helpers.ts';

test('Scope states resident corpus truth and follows the committed range', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await page.setViewportSize({ width: 320, height: 568 });

  const scope = page.getByRole('region', { name: 'Corpus status' });
  await expect(scope.getByText('Library corpus', { exact: true })).toHaveCount(0);
  await expect(scope.getByText(`all ${DOC_COUNT} texts`, { exact: true })).toHaveCount(0);
  await expect(scope.getByText(`${DOC_COUNT}/${DOC_COUNT} texts ready`, { exact: true })).toHaveCount(0);

  const dashboardTokens = await page
    .locator('.catalog-summary')
    .locator('dt', { hasText: /^tokens$/ })
    .locator('..')
    .locator('dd')
    .innerText();
  await expect(scope.getByText(`${dashboardTokens} tokens`, { exact: true })).toHaveCount(0);
  const headerBefore = await page.locator('.app-header').evaluate((header) => {
    const box = header.getBoundingClientRect();
    return {
      height: box.height,
      actions: [...header.querySelectorAll<HTMLElement>('.header-action')]
        .map((action) => {
          const rect = action.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
    };
  });

  await gotoPlace(page, 'trends');
  const scrubber = page.getByRole('slider', { name: /reading position/i });
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');

  let scopeChip = scope.getByRole('button', {
    name: /Scope: .*tokens 1–3 · 3 tokens.*Open scope details/,
  });
  await expect(scopeChip).toContainText(/3 tokens/);
  await expect(scope.getByRole('status')).toContainText('1 text in scope');
  const headerAfter = await page.locator('.app-header').evaluate((header) => {
    const box = header.getBoundingClientRect();
    return {
      height: box.height,
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      actions: [...header.querySelectorAll<HTMLElement>('.header-action')]
        .map((action) => {
          const rect = action.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
    };
  });
  expect(headerAfter.height).toBe(headerBefore.height);
  expect(headerAfter.actions).toEqual(headerBefore.actions);
  expect(headerAfter.scrollWidth).toBeLessThanOrEqual(headerAfter.clientWidth + 1);

  for (const width of [320, 390, 600, 700, 800, 900, 959, 960, 1024, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('.app-header').evaluate((header) => {
      const chip = header.querySelector<HTMLElement>('.scope-chip')!;
      const organ = header.querySelector<HTMLElement>('.scope-organ')!;
      const navigation = header.querySelector<HTMLElement>('.lens-organ')!;
      const magnitude = [...chip.querySelectorAll<HTMLElement>('.scope-chip-magnitude')]
        .find((candidate) => getComputedStyle(candidate).display !== 'none')!;
      const chipBox = chip.getBoundingClientRect();
      const organBox = organ.getBoundingClientRect();
      const magnitudeBox = magnitude.getBoundingClientRect();
      const centerTarget = document.elementFromPoint(
        chipBox.left + chipBox.width / 2,
        chipBox.top + chipBox.height / 2,
      );
      return {
        headerClientWidth: header.clientWidth,
        headerScrollWidth: header.scrollWidth,
        chip: {
          left: chipBox.left,
          right: chipBox.right,
          width: chipBox.width,
          height: chipBox.height,
        },
        organ: { left: organBox.left, right: organBox.right },
        magnitude: {
          left: magnitudeBox.left,
          right: magnitudeBox.right,
          width: magnitudeBox.width,
          text: magnitude.textContent,
        },
        chipHitTestable: centerTarget === chip || chip.contains(centerTarget),
        navigationPosition: getComputedStyle(navigation).position,
      };
    });
    expect(geometry.headerScrollWidth, `${width}px header overflow`).toBeLessThanOrEqual(
      geometry.headerClientWidth + 1,
    );
    expect(geometry.chip.width, `${width}px scope width`).toBeGreaterThanOrEqual(44);
    expect(geometry.chip.height, `${width}px scope height`).toBeGreaterThanOrEqual(44);
    expect(geometry.chip.left, `${width}px scope left edge`).toBeGreaterThanOrEqual(
      geometry.organ.left - 1,
    );
    expect(geometry.chip.right, `${width}px scope right edge`).toBeLessThanOrEqual(
      geometry.organ.right + 1,
    );
    expect(geometry.magnitude.left, `${width}px magnitude left edge`).toBeGreaterThanOrEqual(
      geometry.chip.left - 1,
    );
    expect(geometry.magnitude.right, `${width}px magnitude right edge`).toBeLessThanOrEqual(
      geometry.chip.right + 1,
    );
    expect(geometry.magnitude.width, `${width}px magnitude width`).toBeGreaterThan(0);
    expect(geometry.chipHitTestable, `${width}px scope hit target`).toBe(true);
    expect(geometry.navigationPosition, `${width}px navigation placement`).toBe(
      width < 960 ? 'fixed' : 'static',
    );
    if (width === 320) expect(geometry.magnitude.text).toBe('3');
  }

  await page.setViewportSize({ width: 320, height: 568 });

  await scopeChip.click();
  let details = page.locator('#scope-details:popover-open');
  await expect(details).toBeVisible();
  expect(await page.evaluate(() => 'popover' in HTMLElement.prototype)).toBe(true);
  const detailsBox = await details.boundingBox();
  expect(detailsBox?.x).toBe(0);
  expect(detailsBox?.width).toBe(320);
  await expect(details.getByText(/tokens 1–3 · 3 tokens/)).toBeVisible();
  const tokenFact = details.locator('dt', { hasText: /^Tokens in scope$/ }).locator('..');
  await expect(tokenFact.locator('dd')).toHaveText('3');

  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(scopeChip).toBeFocused();
  await scopeChip.click();
  details = page.locator('#scope-details:popover-open');
  await expect(details).toBeVisible();

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await details.getByRole('button', { name: 'Use all texts' }).click();
  await expect(scope.getByText(`all ${DOC_COUNT} texts`, { exact: true })).toHaveCount(0);
  await expect(scope.getByRole('button', { name: /Open scope details/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find', exact: true })).toBeFocused();

  const after = await trace(page);
  // The global transient footer owns its own debounced source-page lane; it
  // is navigation traffic, not a linked-range analysis consumer.
  const clearOps = after.events
    .filter(
      (event) =>
        event.seq > mark
        && event.direction === 'to-worker'
        && event.t === 'query',
    )
    .filter((event) => event.op !== 'reader-page')
    .map((event) => event.op);
  expect(clearOps.length).toBeGreaterThan(0);
  expect(new Set(clearOps)).toEqual(new Set(['freq-list']));
  // Inputs reuses its authenticated full-corpus inventory; clearing a range
  // must not issue another identical inventory request.
  expect(clearOps).not.toContain('inventory');

  // Full-corpus occurrence navigation is independent of the analytical range.
  await scrubber.focus();
  await scrubber.press('Home');
  await scrubber.press('s');
  await scrubber.press('ArrowRight');
  await scrubber.press('ArrowRight');
  await scrubber.press('Enter');
  scopeChip = scope.getByRole('button', {
    name: /Scope: .*tokens 1–3 · 3 tokens.*Open scope details/,
  });
  await expect(scopeChip).toBeVisible();
  await page.getByRole('button', { name: /^Next(?: Holmes)? reference$/ }).first().click();
  await expect(scopeChip).toBeVisible();
  await expect(scope.getByRole('status')).toContainText('tokens 1–3');
});

test('a whole-book magnitude stays visible through the navigation handoff', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');

  const firstText = page.getByRole('table', { name: 'Text details' })
    .locator('tr[data-catalog-book]')
    .first();
  await firstText.getByRole('rowheader').getByRole('button').click();
  await page.getByRole('region', { name: /Text detail:/ })
    .getByRole('button', { name: 'select this text' })
    .click();

  const scopeChip = page.getByRole('region', { name: 'Corpus status' })
    .getByRole('button', { name: /Open scope details/ });
  await expect(scopeChip).toBeVisible();

  for (const width of [320, 600, 959, 960, 965, 970, 975, 980, 985, 995, 1024, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await scopeChip.evaluate((chip) => {
      const magnitude = [...chip.querySelectorAll<HTMLElement>('.scope-chip-magnitude')]
        .find((candidate) => getComputedStyle(candidate).display !== 'none')!;
      const chipBox = chip.getBoundingClientRect();
      const magnitudeBox = magnitude.getBoundingClientRect();
      const visibleMagnitude = magnitude.textContent?.trim() ?? '';
      return {
        chipClientWidth: chip.clientWidth,
        chipScrollWidth: chip.scrollWidth,
        chipLeft: chipBox.left,
        chipRight: chipBox.right,
        magnitudeLeft: magnitudeBox.left,
        magnitudeRight: magnitudeBox.right,
        visibleMagnitude,
        nameContainsMagnitude: (chip.getAttribute('aria-label') ?? '')
          .includes(visibleMagnitude),
      };
    });

    expect(geometry.visibleMagnitude, `${width}px visible magnitude`).not.toBe('');
    expect(geometry.chipScrollWidth, `${width}px chip content overflow`).toBeLessThanOrEqual(
      geometry.chipClientWidth + 1,
    );
    expect(geometry.magnitudeLeft, `${width}px magnitude left edge`).toBeGreaterThanOrEqual(
      geometry.chipLeft - 1,
    );
    expect(geometry.magnitudeRight, `${width}px magnitude right edge`).toBeLessThanOrEqual(
      geometry.chipRight + 1,
    );
    expect(geometry.nameContainsMagnitude, `${width}px label in name`).toBe(true);
  }
});
