/**
 * Slice-2 H browser proof: matches and barcode rows carry snapshot-bound
 * open intents into the lazy canonical reader; rapid navigation delivers stale
 * worker results physically out of order without relabeling the current page.
 */

import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
  submitAndAwaitFreshResults,
  trace,
} from './helpers.ts';

const CORPUS = Array.from({ length: 900 }, (_, index) =>
  index === 50
    ? '<em>'
    : index === 450
      ? 'wolf'
      : `w${String(index).padStart(4, '0')}`,
).join(' ');

async function importCorpus(
  page: Page,
  name: string,
  text: string,
  expectedReady: number,
): Promise<void> {
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page.getByLabel(/Create project from files|Add files/).setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(text, 'utf-8'),
  });
  await expect(page.getByRole('region', { name: 'Inputs', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      return snapshot.events.some(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'snapshot-published'
          && event.readyCount === expectedReady,
      );
    }, { timeout: 30_000 })
    .toBe(true);
  await awaitReadyCount(page, expectedReady);
}

async function awaitFreshReader(page: Page, mark: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && event.op === 'reader-page',
      );
      if (queries.length === 0) return 'no reader query';
      const delivered = snapshot.events.some(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && queries.some((query) => query.job === event.job),
      );
      return delivered ? 'answered' : 'waiting';
    }, { timeout: 30_000 })
    .toBe('answered');
}

async function awaitReaderBurst(page: Page, mark: number, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'to-worker'
          && event.t === 'query'
          && event.op === 'reader-page',
      );
      const jobs = new Set(queries.map((event) => event.job));
      const results = snapshot.events.filter(
        (event) =>
          event.seq > mark
          && event.direction === 'from-worker'
          && event.t === 'result'
          && jobs.has(event.job),
      );
      return jobs.size >= expected && results.length === jobs.size
        ? 'answered'
        : `${results.length}/${jobs.size}`;
    }, { timeout: 30_000 })
    .toBe('answered');
}

async function installReaderResultGate(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    interface Held {
      message: unknown;
      transfer?: Transferable[];
    }
    interface Gate {
      armed: boolean;
      held: Held[];
      arm(): void;
      heldCount(): number;
      releaseNewest(): void;
      release(): void;
    }
    interface Scope {
      __ttReaderGate?: Gate;
      postMessage: (message: unknown, transfer?: Transferable[]) => void;
    }
    const scope = globalThis as unknown as Scope;
    if (scope.__ttReaderGate) return;
    const original = scope.postMessage.bind(scope);
    const send = (item: Held) => {
      if (item.transfer && item.transfer.length > 0) original(item.message, item.transfer);
      else original(item.message);
    };
    const gate: Gate = {
      armed: false,
      held: [],
      arm() {
        if (this.held.length > 0) throw new Error('release held reader pages before rearming');
        this.armed = true;
      },
      heldCount() {
        return this.held.length;
      },
      releaseNewest() {
        const item = this.held.pop();
        if (item) send(item);
      },
      release() {
        this.armed = false;
        const held = this.held.splice(0);
        for (const item of held) send(item);
      },
    };
    scope.__ttReaderGate = gate;
    scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
      const candidate = message as { t?: string; data?: { op?: string } };
      if (gate.armed && candidate.t === 'result' && candidate.data?.op === 'reader-page') {
        gate.held.push({ message, ...(transfer ? { transfer } : {}) });
        return;
      }
      send({ message, ...(transfer ? { transfer } : {}) });
    };
  });
}

const gateArm = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttReaderGate?: { arm(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.arm();
  });

const gateHeld = (worker: Worker) =>
  worker.evaluate(() =>
    (globalThis as unknown as {
      __ttReaderGate?: { heldCount(): number };
    }).__ttReaderGate?.heldCount() ?? -1,
  );

const gateRelease = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttReaderGate?: { release(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.release();
  });

const gateReleaseNewest = (worker: Worker) =>
  worker.evaluate(() => {
    const gate = (globalThis as unknown as {
      __ttReaderGate?: { releaseNewest(): void };
    }).__ttReaderGate;
    if (!gate) throw new Error('reader gate is not installed');
    gate.releaseNewest();
  });

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await importCorpus(page, 'reader.txt', CORPUS, 1);
  await gotoPlace(page, 'trends');
  await submitAndAwaitFreshResults(page, 'wolf');
});

test('compact Reader is a Back/Escape layer and restores its invoking row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPlace(page, 'matches');
  const lens = page.getByRole('navigation', { name: 'Workbench sections' });
  await expect(lens).toBeVisible();

  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page
    .getByRole('grid', { name: 'Matches' })
    .getByRole('button', { name: 'wolf', exact: true })
    .click();
  await awaitFreshReader(page, mark);

  const drawer = page.getByRole('main', { name: /Reader: reader/ });
  await expect(drawer).toBeVisible();
  await expect(lens).toHaveCount(0);
  const controls = drawer.getByRole('button', { name: /Open Reader controls for/ });
  const readerPage = drawer.locator('[data-reader-page]');
  const prosePane = drawer.locator('.reader-prose-pane');
  const startBeforeDensity = (await readerPage.getAttribute('data-reader-page'))?.split(':')[0];
  const proseSizeBeforeDensity = await drawer.locator('.source-text').evaluate((element) =>
    getComputedStyle(element).fontSize);
  const paneBoxBeforeControls = await prosePane.boundingBox();
  await controls.click();
  const readerControls = page.getByRole('dialog', { name: 'Reader controls', exact: true });
  await expect(readerControls).toBeVisible();
  await expect(readerControls.getByRole('heading', { name: 'Position', exact: true })).toBeVisible();
  await expect(readerControls.getByRole('heading', { name: 'Page', exact: true })).toBeVisible();
  await expect(readerControls.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible();
  await expect(readerControls.getByRole('heading', { name: 'Text', exact: true })).toBeVisible();
  await expect(readerControls.getByRole('button', { name: 'Start of text', exact: true }))
    .toBeVisible();
  await expect(readerControls.getByRole('button', { name: 'End of text', exact: true }))
    .toBeVisible();
  expect(await prosePane.boundingBox()).toEqual(paneBoxBeforeControls);
  await readerControls.getByRole('button', { name: 'Open Reader settings', exact: true }).click();
  const settingsPane = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settingsPane.getByText(/Reader presents authenticated plain text/)).toHaveCount(0);
  await settingsPane.getByRole('slider', { name: 'Size and spacing' }).fill('2');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await page.keyboard.press('Escape');
  await expect(controls).toBeFocused();
  await controls.click();
  await page.getByRole('dialog', { name: 'Reader controls', exact: true })
    .getByRole('button', { name: 'Open Reader help', exact: true }).click();
  const helpPane = page.getByRole('dialog', { name: 'Help', exact: true });
  await expect(helpPane.getByText(/Reader presents authenticated plain text/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(controls).toBeFocused();
  await expect(drawer.locator('.reader-header, .reader-ruler, .reader-pages')).toHaveCount(0);
  const bar = drawer.getByRole('navigation', { name: 'Reader controls' });
  await expect(bar.getByRole('button')).toHaveCount(5);
  await expect.poll(async () => (await bar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(48);
  for (const button of await bar.getByRole('button').all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(async () => (await readerPage.getAttribute('data-reader-page'))?.split(':')[0])
    .toBe(startBeforeDensity);
  expect(await drawer.locator('.source-text').evaluate((element) =>
    getComputedStyle(element).fontSize)).toBe(proseSizeBeforeDensity);
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  const row = page
    .getByRole('grid', { name: 'Matches' })
    .getByRole('button', { name: 'wolf', exact: true });
  await expect(page.getByRole('grid', { name: 'Matches' })).toBeFocused();
  await expect(
    page.getByRole('navigation', { name: 'Workbench sections' }),
  ).toBeVisible();

  await row.click();
  await expect(drawer).toBeVisible();
  await drawer.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('grid', { name: 'Matches' })).toBeFocused();
});

test('dragging the Reader progress rail seeks to that position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoPlace(page, 'matches');
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await page
    .getByRole('grid', { name: 'Matches' })
    .getByRole('button', { name: 'wolf', exact: true })
    .click();
  await awaitFreshReader(page, mark);

  const reader = page.getByRole('main', { name: /Reader: reader/ });
  const pageText = reader.locator('[data-reader-page]');
  const position = reader.getByRole('slider', { name: /Position in reader/ });
  const box = await position.boundingBox();
  if (!box) throw new Error('Reader position slider has no layout box');
  expect(box.height).toBeGreaterThanOrEqual(11);
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest('[role="slider"]')?.getAttribute('role') ?? ''
  ), { x: box.x + box.width / 2, y: box.y + 8.5 })).toBe('slider');
  const back = reader.getByRole('button', { name: 'Return to workbench', exact: true });
  const backBox = await back.boundingBox();
  if (!backBox) throw new Error('Reader back button has no layout box');
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest('button')?.className ?? ''
  ), { x: backBox.x + backBox.width / 2, y: backBox.y + 2 })).toContain('reader-control-exit');

  const targetToken = Math.round(0.75 * (900 - 1));
  const y = box.y + box.height / 2;
  const pointer = {
    pointerType: 'mouse',
    pointerId: 17,
    isPrimary: true,
    button: 0,
  };
  const seekMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await position.dispatchEvent('pointerdown', {
    ...pointer,
    clientX: box.x + box.width * 0.2,
    clientY: y,
  });
  await position.dispatchEvent('pointermove', {
    ...pointer,
    clientX: box.x + box.width * 0.75,
    clientY: y,
  });
  await expect(position).toHaveAttribute('data-seeking', 'true');
  await expect(position).toHaveAttribute('aria-valuenow', String(targetToken + 1));
  await awaitFreshReader(page, seekMark);
  await expect(pageText).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${targetToken}:\\d+$`),
  );

  await position.dispatchEvent('pointerup', {
    ...pointer,
    clientX: box.x + box.width * 0.75,
    clientY: y,
  });
  await expect(pageText).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${targetToken}:\\d+$`),
  );
  await expect(position).toHaveAttribute('aria-valuenow', String(targetToken + 1));

  const keyboardTarget = targetToken + Math.round((900 - 1) / 100);
  await position.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
  await expect(position).toHaveAttribute('data-seeking', 'true');
  await expect(position).toHaveAttribute('aria-valuenow', String(keyboardTarget + 1));
  await position.dispatchEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight' });
  await expect(position).not.toHaveAttribute('data-seeking', 'true');
});

test('Matches opens the lazy reader; navigation and edited highlights stay correct', async ({ page }) => {
  // Pin this store-ordering proof to a compact Reader geometry so a wide-rail
  // height refit cannot add a third source request to the two-result gate.
  await page.setViewportSize({ width: 900, height: 600 });
  await gotoPlace(page, 'matches');
  const table = page.getByRole('grid', { name: 'Matches' });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  const kwicOpen = table.getByRole('button', { name: 'wolf', exact: true });
  await kwicOpen.click();
  await awaitFreshReader(page, mark);

  const drawer = page.getByRole('main', { name: /Reader: reader/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.reader-prose-pane')).not.toHaveAttribute('data-reader-fitting');
  await expect(drawer.locator('.workbench-dock')).toHaveCount(0);
  await expect(drawer).toHaveAttribute('data-reader-footer', 'false');
  await expect(drawer.getByRole('slider', { name: /Position in/ })).toHaveCount(1);
  const initialRange = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  const initialMatch = /^(\d+):(\d+)$/.exec(initialRange ?? '');
  expect(initialMatch).not.toBeNull();
  expect(Number(initialMatch![1])).toBeLessThanOrEqual(450);
  expect(Number(initialMatch![2])).toBeGreaterThan(450);
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-anchor', '450');

  await drawer.press('Home');
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', /^0:\d+$/);
  await drawer.press('End');
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', /^\d+:900$/);
  const endRange = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  const endStart = /^(\d+):/.exec(endRange ?? '')?.[1];
  expect(endStart).toBeTruthy();
  await drawer.press('h');
  const middleRange = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  expect(middleRange).toMatch(/^\d+:\d+$/);

  await expect.poll(() => page.workers().length).toBe(1);
  const worker = page.workers()[0]!;
  await installReaderResultGate(worker);
  await gateArm(worker);
  const navigationMark = (await trace(page)).events.at(-1)?.seq ?? -1;

  // The middle page exposes both directions. Hold the completed Next page,
  // then supersede it with Previous while no old prose is mounted.
  await drawer.press('l');
  await expect(drawer.locator('[data-reader-page]')).toHaveCount(0);
  await expect.poll(() => gateHeld(worker)).toBe(1);
  await drawer.press('ArrowLeft');
  await expect.poll(() => gateHeld(worker)).toBe(2);
  // Deliver the CURRENT Previous page first, then the stale Next page after
  // it has rendered. The final assertion now fails without store-side guards.
  await gateReleaseNewest(worker);
  await expect(drawer.locator('[data-reader-page]')).toBeVisible();
  const currentPrevious = await drawer.locator('[data-reader-page]').getAttribute('data-reader-page');
  expect(currentPrevious).not.toBe(middleRange);
  await expect.poll(() => gateHeld(worker)).toBe(1);
  await gateRelease(worker);
  await awaitReaderBurst(page, navigationMark, 2);
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', currentPrevious!);

  // Literal source markup remains literal selectable text, never an element.
  await drawer.press('Home');
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', /^0:\d+$/);
  await expect(drawer.getByText(/<em>/)).toBeVisible();
  await expect(drawer.locator('em')).toHaveCount(0);

  await drawer.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(table).toBeFocused();
  await gotoPlace(page, 'trends');

  // Return to Trends to make a semantic edit, then reopen from the refreshed
  // matches and verify the Reader's current projection.
  await page.getByRole('button', { name: 'Edit term: wolf' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage terms' });
  const editor = manager.getByRole('form', { name: 'Edit term: wolf' });
  await expect(editor).toBeVisible();
  await editor.getByRole('textbox', { name: 'Term and aliases for wolf' }).fill('wolf, w0100');
  await editor.getByRole('button', { name: 'Save term' }).click();
  await expect(editor).toHaveCount(0);
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  await gotoPlace(page, 'matches');
  const refreshedOpen = page.getByRole('grid', { name: 'Matches' })
    .getByRole('button', { name: 'w0100', exact: true }).first();
  const readerMark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await refreshedOpen.click();
  await awaitFreshReader(page, readerMark);
  const trendDrawer = page.getByRole('main', { name: /Reader: reader/ });
  await expect(trendDrawer.locator('[data-reader-mark]').filter({ hasText: 'w0100' })).toBeVisible();

  // Back restores workbench navigation; the full Reader never carries across
  // a subsequent place departure.
  await trendDrawer.getByRole('button', { name: 'Return to workbench', exact: true }).click();
  await expect(trendDrawer).toHaveCount(0);
  await gotoPlace(page, 'matches');
  await expect(page).toHaveURL(/[?&]p=matches(?:&|$)/);
});

test('an exact barcode occurrence opens the reader', async ({ page }) => {
  // Exact barcode tick at wolf@450 opens directly (density aggregates instead
  // center Matches, whose active exact row supplies its reader link).
  const canvas = page.getByRole('slider', { name: /reading position/i })
    .locator('canvas')
    .first();
  const box = (await canvas.boundingBox())!;
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;
  await canvas.click({ position: { x: box.width * (450.5 / 900), y: 3 } });
  await awaitFreshReader(page, mark);
  const drawer = page.getByRole('main', { name: /Reader: reader/ });
  await expect(drawer.locator('[data-reader-page]')).toHaveAttribute('data-reader-anchor', '450');
  await drawer.getByRole('button', { name: 'Return to workbench', exact: true }).click();
});
