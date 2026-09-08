import { expect, test } from '@playwright/test';
import { awaitReadyCount, gotoPlace, trace } from './helpers.ts';

test('ready texts offer Track a term and Read with working history and focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Hold worker admission, so saved/finalized sources cannot stand in for
  // snapshot-ready evidence. Release in reverse order to check declared order.
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage;
    const held: Array<() => void> = [];
    let holding = true;
    (window as unknown as { releaseInputs(): void }).releaseInputs = () => {
      holding = false;
      held.reverse().forEach((send) => send());
    };
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const send = () => Reflect.apply(nativePost, this, transfer === undefined ? [message] : [message, transfer]);
      if (holding && (message as { t?: string }).t === 'ingest') held.push(send);
      else send();
    };
  });
  await page.goto('./?fresh=1');
  const next = page.getByRole('group', { name: 'Explore your texts' });
  await expect(next).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try the Sherlock Holmes sample' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the Jane Austen sample' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the World English Bible sample' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Browse Standard Ebooks/ })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: testInfo.outputPath('empty-inputs.png'), fullPage: true });
  await page.getByLabel('Add files — import and analyze').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('forest pine wolf. '.repeat(30)) },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('ocean wave salt. '.repeat(30)) },
  ]);
  await expect.poll(async () => (await trace(page)).events.filter((event) => event.t === 'ingest').length).toBe(2);
  await expect(next).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseInputs(): void }).releaseInputs());
  await awaitReadyCount(page, 2);
  await expect(next).toContainText('2 texts ready');
  await expect(next.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ready-inputs.png'), fullPage: true });
  await next.getByRole('button', { name: 'Read', exact: true }).click();
  const reader = page.getByRole('main', { name: 'Reader: first', exact: true });
  await expect(reader.locator('[data-reader-page]')).toContainText('forest');
  await reader.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(next.getByRole('button', { name: 'Read', exact: true })).toBeFocused();
  await page.goForward();
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  await page.goBack();
  await next.getByRole('button', { name: 'Track a term', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const aliases = manager.getByRole('textbox', { name: /Term and aliases for/ });
  await expect(aliases).toBeFocused();
  await aliases.fill('forest');
  await manager.getByRole('button', { name: 'Add term', exact: true }).click();
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trends', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'forest, shown in analysis', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('failed and partial imports keep recovery visible; clearing active work restores acquisition defaults', async ({ page }) => {
  await page.goto('./?fresh=1');
  const next = page.getByRole('group', { name: 'Explore your texts' });
  const acquisition = page.getByRole('region', { name: 'Add texts' });
  await page.getByLabel('Add files — import and analyze').setInputFiles({
    name: 'broken.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not an archive'),
  });
  await expect(page.getByRole('button', { name: 'Remove failed import broken.epub' })).toBeVisible();
  await expect(next).toHaveCount(0);
  await expect(acquisition.getByRole('button', { name: 'Hide options' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Add files — import and analyze').setInputFiles({
    name: 'healthy.txt', mimeType: 'text/plain', buffer: Buffer.from('healthy forest text'),
  });
  await expect(page.locator('.scope-organ > [role="status"]')).toContainText('1/2 texts ready');
  await expect(next.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove failed import broken.epub' })).toBeVisible();
  // An explicit choice made with active work must not strand an empty workspace.
  await acquisition.getByRole('button', { name: 'Show options' }).click();
  await acquisition.getByRole('button', { name: 'Hide options' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Active inputs' }).getByRole('button', { name: /Clear all/ }).click();
  await expect(next).toHaveCount(0);
  await expect(acquisition.getByRole('button', { name: 'Hide options' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: 'Saved texts' })).toContainText('healthy.txt');
  await gotoPlace(page, 'inputs');
});
