import { expect, test, type Locator, type Page } from '@playwright/test';
import { awaitAllReady, awaitReadyCount, clearDemoInputs, gotoPlace } from './helpers.ts';

const text = (word: string) => Array.from({ length: 12 }, () => word).join(' ');

async function dragBetween(page: Page, first: Locator, last: Locator): Promise<void> {
  const start = await first.boundingBox();
  const end = await last.boundingBox();
  if (!start || !end) throw new Error('title targets must be visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('title clicks and reading-order drags select whole texts in every trend layout', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from(text('alpha'), 'utf-8') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from(text('beta'), 'utf-8') },
    { name: 'gamma.txt', mimeType: 'text/plain', buffer: Buffer.from(text('gamma'), 'utf-8') },
  ]);
  await awaitReadyCount(page, 3);
  await gotoPlace(page, 'trends');

  const scope = page.getByRole('region', { name: 'Corpus status' });
  const controls = page.getByRole('group', { name: 'Select whole texts' });
  const title = (name: string) => controls.getByRole('button', {
    name: new RegExp(`: ${name} — select whole text$`, 'i'),
  });
  const layouts = [
    { button: 'Combined sequence', selected: 'alpha' },
    { button: 'Separate rows, equal width', selected: 'beta' },
    { button: 'To scale — separate rows, same token scale', selected: 'gamma' },
  ] as const;

  for (const [index, layout] of layouts.entries()) {
    await page.getByRole('button', { name: layout.button, exact: true }).click();
    await expect(controls.getByRole('button')).toHaveCount(3);

    await title(layout.selected).click();
    await expect(scope.getByRole('button', {
      name: new RegExp(`Scope: ${layout.selected} · tokens 1–12 · 12 tokens`, 'i'),
    })).toBeVisible();

    await dragBetween(
      page,
      title(index === 1 ? 'gamma' : 'alpha'),
      title(index === 1 ? 'alpha' : 'gamma'),
    );
    await expect(scope.getByRole('button', {
      name: /3-book range.*Scope: alpha token 1 → gamma token 12 · 36 tokens across 3 books/i,
    })).toBeVisible();
  }

  // The title remains an interactive target: a double-click re-applies the
  // whole text and never bubbles into the graph's clear-range gesture.
  await title('beta').dblclick();
  await expect(scope.getByRole('button', {
    name: /Scope: beta · tokens 1–12 · 12 tokens/i,
  })).toBeVisible();
});
