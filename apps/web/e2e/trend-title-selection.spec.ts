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

  await page.getByRole('button', { name: 'Combined sequence', exact: true }).click();
  await expect(controls.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(controls.locator('button[tabindex="-1"]')).toHaveCount(2);
  await expect(title('alpha')).toHaveAttribute(
    'aria-keyshortcuts',
    /Home End Enter Space.*Shift\+ArrowRight/,
  );
  await expect(title('alpha')).toHaveCSS('touch-action', 'pan-y');
  await title('alpha').focus();
  await title('alpha').press('Enter');
  await expect(scope.getByRole('button', {
    name: /Scope: alpha · tokens 1–12 · 12 tokens/i,
  })).toBeVisible();
  await title('alpha').press('ArrowRight');
  await expect(title('beta')).toBeFocused();
  await title('beta').press('Shift+ArrowRight');
  await expect(title('gamma')).toBeFocused();
  await expect(scope.getByRole('button', {
    name: /2-book range.*Scope: beta token 1 → gamma token 12 · 24 tokens across 2 books/i,
  })).toBeVisible();
  await title('gamma').press('Shift+ArrowRight');
  await expect(title('gamma')).toBeFocused();
  await title('gamma').press('Home');
  await expect(title('alpha')).toBeFocused();
  await title('alpha').press('End');
  await expect(title('gamma')).toBeFocused();

  for (const [index, layout] of layouts.entries()) {
    await page.getByRole('button', { name: layout.button, exact: true }).click();
    await expect(controls.getByRole('button')).toHaveCount(3);
    await expect(controls.locator('button[tabindex="0"]')).toHaveCount(1);

    if (index > 0) {
      await expect(title('alpha')).toHaveCSS('touch-action', 'none');
      const [targetBox, controlsBox] = await Promise.all([
        title('alpha').boundingBox(),
        controls.boundingBox(),
      ]);
      expect(targetBox && controlsBox ? targetBox.width : Number.POSITIVE_INFINITY)
        .toBeLessThan(controlsBox?.width ?? 0);
    }

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
