import { expect, test, type Locator, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  awaitAllReady,
  SHERLOCK,
  trace,
  workerQueriesAfter,
} from './helpers.ts';

async function openReader(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Matches', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Matches' });
  const read = grid.getByRole('rowgroup').getByRole('button').first();
  await expect(read).toBeVisible();
  await read.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  return { grid, read, reader };
}

async function expectNoBodyOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    documentClient: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(widths.documentScroll).toBeLessThanOrEqual(widths.documentClient);
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient);
}

async function expectReaderFillsViewport(
  page: Page,
  reader: Locator,
  width: number,
  height: number,
) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const box = await reader.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeCloseTo(0, 0);
  expect(box!.y).toBeCloseTo(0, 0);
  expect(box!.width).toBeCloseTo(width, 0);
  expect(box!.height).toBeCloseTo(height, 0);
  const pane = reader.locator('.reader-prose-pane');
  await expect.poll(async () => {
    const published = await reader.getAttribute('data-reader-fit-size');
    const current = await pane.evaluate(
      (element) => `${element.clientWidth}x${element.clientHeight}`,
    );
    return published === current;
  }).toBe(true);
  await expect(reader.getByRole('navigation', { name: 'Reader navigation' })).toBeVisible();
  await expect(pane).not.toHaveAttribute('data-reader-fitting');
  await expectNoBodyOverflow(page);
}

function parseReaderRange(value: string | null): readonly [number, number] {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

async function dispatchReaderPointer(
  target: Locator,
  pointerType: 'touch' | 'mouse',
  from: { readonly x: number; readonly y: number },
  to = from,
) {
  const init = {
    pointerType,
    pointerId: 7,
    isPrimary: true,
    button: 0,
  };
  await target.dispatchEvent('pointerdown', { ...init, clientX: from.x, clientY: from.y });
  await target.dispatchEvent('pointerup', { ...init, clientX: to.x, clientY: to.y });
}

async function settledReaderRange(reader: Locator): Promise<readonly [number, number]> {
  const pane = reader.locator('.reader-prose-pane');
  await expect(pane).not.toHaveAttribute('data-reader-fitting');
  return parseReaderRange(
    await reader.locator('[data-reader-page]').getAttribute('data-reader-page'),
  );
}

test('the lazy Reader fallback is titled, nonblank, and can go back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const dist = fileURLToPath(new URL('../dist/assets/', import.meta.url));
  const readerChunk = readdirSync(dist).find(
    (file) => file.endsWith('.js') && readFileSync(`${dist}${file}`, 'utf8').includes('Loading reader page'),
  );
  expect(readerChunk, 'dist contains a distinct Reader chunk').toBeTruthy();
  const gate: { release?: () => void } = {};
  await page.route(`**/assets/${readerChunk}`, (route) => new Promise<void>((resolve) => {
    gate.release = () => {
      void route.continue().finally(resolve);
    };
  }));
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Matches', exact: true }).click();
  await page.getByRole('grid', { name: 'Matches' })
    .getByRole('rowgroup').getByRole('button').first().click();
  const fallback = page.getByRole('main', { name: /Reader:/ });
  await expect(fallback.getByRole('status', { name: 'Reader keyboard status' })).toHaveCount(1);
  await expect(fallback.locator('p.reader-position')).toHaveText('loading reader…');
  await fallback.getByRole('button', { name: 'back', exact: true }).click();
  await expect(fallback).toHaveCount(0);
  await expect(page.locator('.app-header')).toBeVisible();
  gate.release?.();
});

test('Reader has one full-viewport presentation with its compressed analytical footer', async ({ page }) => {
  const { grid, reader } = await openReader(page);

  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader.getByRole('group', { name: 'Reader width' })).toHaveCount(0);
  await expect(reader.getByRole('complementary', { name: 'Terms' })).toBeVisible();
  await expect(reader.locator('.workbench-dock[data-mode="reader"]')).toBeVisible();
  await expect(reader.getByRole('complementary', { name: 'Reading position' }))
    .toBeVisible();
  await expect(reader.locator('.footer-passage')).toHaveCount(0);
  await expect(reader.getByLabel('Reader query highlights')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Workbench sections' })).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'back', exact: true })).toBeVisible();
  await expectReaderFillsViewport(page, reader, 1440, 900);

  await page.goBack();
  await expect(reader).toHaveCount(0);
  await expect(grid).toBeFocused();
  await expect(page.locator('html')).not.toHaveClass(/reader-open/);
  await page.goForward();
  await expect(page.getByRole('main', { name: /Reader:/ })).toBeVisible();
});

test('Atlas compares complete text extents without analysis queries or page overflow', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { reader } = await openReader(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await trace(page);
  const mark = before.events.at(-1)?.seq ?? 0;

  await reader.getByRole('button', { name: 'Atlas', exact: true }).click();
  const plane = reader.locator('.reader-atlas-plane');
  await expect(plane).toBeVisible();
  await expect(reader.locator('[data-atlas-column]')).toHaveCount(SHERLOCK.length);
  await expect.poll(() => reader.locator('[data-atlas-canvas]').count())
    .toBeLessThan(SHERLOCK.length);
  await expect(reader.locator('.reader-atlas-extent')).toHaveCount(SHERLOCK.length);
  await expect(reader.getByRole('button', { name: 'Atlas', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(plane).toBeFocused();
  expect(await plane.evaluate((element) => getComputedStyle(element).touchAction))
    .toContain('pinch-zoom');
  await expect(reader.locator('.reader-atlas-ruler-list > button[tabindex="0"]')).toHaveCount(1);

  const readerHelp = reader.getByRole('button', { name: 'help', exact: true });
  await readerHelp.click();
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help.getByText('Next text in Atlas', { exact: true })).toBeVisible();
  await expect(help.getByText('Move down in the active text', { exact: true })).toBeVisible();
  await expect(help.getByText('Read at the active Atlas position', { exact: true })).toBeVisible();
  await expect(help.getByText('Next page', { exact: true })).toHaveCount(0);
  await help.getByRole('button', { name: 'close', exact: true }).click();
  await expect(readerHelp).toBeFocused();

  const canvases = reader.locator('[data-atlas-canvas]');
  const firstCanvas = canvases.first();
  await firstCanvas.evaluate((canvas) => { canvas.dataset.themeProbe = 'resident'; });
  const paintedColors = () => canvases.evaluateAll((nodes) => {
    const colors = new Set<string>();
    for (const node of nodes as HTMLCanvasElement[]) {
      const context = node.getContext('2d');
      if (!context) continue;
      const pixels = context.getImageData(0, 0, node.width, node.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if ((pixels[index + 3] ?? 0) > 250) {
          colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
        }
      }
    }
    return [...colors];
  });
  const expectedFirstSeries = () => page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--series-1');
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color.match(/[\d.]+/g)?.slice(0, 3).map(Number).join(',') ?? color;
  });
  const darkSeries = await expectedFirstSeries();
  await expect.poll(async () => (await paintedColors()).includes(darkSeries)).toBe(true);

  await reader.getByRole('button', { name: 'To scale', exact: true }).click();
  await plane.evaluate((element) => { element.scrollLeft = 420; });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const afterPresentation = await trace(page);
  expect(workerQueriesAfter(afterPresentation.events, mark)).toEqual([]);
  await expectNoBodyOverflow(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(expectedFirstSeries).not.toBe(darkSeries);
  const lightSeries = await expectedFirstSeries();
  await expect.poll(async () => (await paintedColors()).includes(lightSeries)).toBe(true);
  await expect(reader.locator('canvas[data-theme-probe="resident"]')).toHaveCount(1);

  await plane.focus();
  await plane.press('Shift+S');
  await expect(reader.getByRole('status', { name: 'Reader keyboard status' }))
    .toContainText('Speed reading is available in Read.');
  await expect(reader.locator('[data-rsvp-stage]')).toHaveCount(0);

  await plane.press('ArrowRight');
  await expect(reader.locator('.reader-position')).toContainText('text 2 of');
  await expect(plane).toBeFocused();
  await plane.press('Home');
  await expect(reader.locator('.reader-position')).toContainText('token 1 of');
  const beforeModifiedInput = await reader.locator('.reader-position').textContent();
  for (const wheelInit of [
    { ctrlKey: true, deltaX: 0, deltaY: 120 },
    { metaKey: true, deltaX: 0, deltaY: 120 },
    { shiftKey: true, deltaX: 0, deltaY: 120 },
    { deltaX: 120, deltaY: 60 },
  ]) {
    expect(await plane.evaluate((element, init) => {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(wheel);
      return wheel.defaultPrevented;
    }, wheelInit)).toBe(false);
  }
  await plane.press('Shift+ArrowDown');
  await expect(reader.locator('.reader-position')).toHaveText(beforeModifiedInput!);
  const beforeWheel = await reader.locator('.reader-position').textContent();
  expect(await plane.evaluate((element) => {
    const wheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: 0, deltaY: 120, deltaMode: 0,
    });
    element.dispatchEvent(wheel);
    return wheel.defaultPrevented;
  })).toBe(true);
  await expect.poll(() => reader.locator('.reader-position').textContent()).not.toBe(beforeWheel);
  await expect(reader.getByRole('status', { name: 'Reader keyboard status' }))
    .toContainText('Atlas.', { timeout: 2_000 });

  const activeRail = reader.locator('[data-atlas-active="true"] .reader-atlas-rail');
  const activeRailBox = await activeRail.boundingBox();
  expect(activeRailBox).not.toBeNull();
  const beforeDrag = await reader.locator('.reader-position').textContent();
  await dispatchReaderPointer(
    activeRail,
    'touch',
    { x: activeRailBox!.x + 2, y: activeRailBox!.y + 40 },
    { x: activeRailBox!.x + 50, y: activeRailBox!.y + 40 },
  );
  await expect(reader.locator('.reader-position')).toHaveText(beforeDrag!);
  const activeExtentBox = await activeRail.locator('.reader-atlas-extent').boundingBox();
  expect(activeExtentBox).not.toBeNull();
  await dispatchReaderPointer(activeRail, 'touch', {
    x: activeRailBox!.x + 2,
    y: activeExtentBox!.y + activeExtentBox!.height * 0.75,
  });
  await expect.poll(() => reader.locator('.reader-position').textContent()).not.toBe(beforeDrag);
  await expect(reader.getByRole('button', { name: 'Atlas', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');

  await plane.evaluate((element) => { element.scrollLeft = 0; });
  const thirdRail = reader.locator('[data-atlas-column]').nth(2).locator('.reader-atlas-rail');
  await thirdRail.click({ position: { x: 2, y: 32 } });
  await expect(reader.locator('.reader-position')).toContainText('text 3 of');
  await plane.evaluate((element) => { element.scrollLeft = 0; });
  await thirdRail.click({ position: { x: 2, y: 96 } });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(await plane.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);

  await reader.getByRole('button', { name: 'Equal', exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(reader.locator('.reader-atlas-ruler-compact')).toBeVisible();
  await expect(reader.locator('.reader-atlas-ruler-list')).toBeHidden();
  await expect(reader.locator('.reader-atlas-ruler-compact').getByRole('button')).toHaveCount(2);
  if (await page.evaluate(() => matchMedia('(pointer: coarse), (any-pointer: coarse)').matches)) {
    await expect(reader.locator('.reader-atlas-ruler-compact').getByRole('button').first())
      .toHaveCSS('min-height', '44px');
  }
  await expect.poll(() => plane.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight))).toBeLessThanOrEqual(1);
  await expect.poll(() => Promise.all([
    plane.evaluate((element) => element.clientHeight),
    reader.locator('[data-atlas-column]').first().locator('.reader-atlas-rail')
      .evaluate((rail) => rail.getBoundingClientRect().height),
  ]).then(([planeHeight, railHeight]) => railHeight - planeHeight))
    .toBeLessThanOrEqual(0);
  await expect(reader.getByRole('button', { name: 'Atlas', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await plane.press('Enter');
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Read', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(reader).toBeFocused();
});

test('Reader page turns roll over between adjacent texts', async ({ page }) => {
  const { reader } = await openReader(page);
  const heading = reader.getByRole('heading', { level: 2 });
  const title = await heading.textContent();
  const initialIndex = SHERLOCK.findIndex((entry) => title?.includes(entry.title));
  expect(initialIndex).toBeGreaterThanOrEqual(0);
  expect(initialIndex).toBeLessThan(SHERLOCK.length - 1);
  const initialTitle = SHERLOCK[initialIndex]!.title;
  const nextTitle = SHERLOCK[initialIndex + 1]!.title;
  const initialRange = await reader.locator('[data-reader-page]').getAttribute('data-reader-page');

  await reader.focus();
  await reader.press('End');
  await expect.poll(() => reader.locator('[data-reader-page]').getAttribute('data-reader-page'))
    .not.toBe(initialRange);
  await settledReaderRange(reader);
  const next = reader.locator('.reader-page-next');
  await expect(next).toBeEnabled();
  await next.click();
  await expect(heading).toContainText(nextTitle);
  expect((await settledReaderRange(reader))[0]).toBe(0);

  const previous = reader.locator('.reader-page-previous');
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(heading).toContainText(initialTitle);
  expect((await settledReaderRange(reader))[0]).toBeGreaterThan(0);
});

test('Reader stays viewport-bound and locks outer scrolling at iPad and phone widths', async ({
  page,
  browserName,
}) => {
  const { reader } = await openReader(page);
  const pageRange = await reader.locator('[data-reader-page]').getAttribute('data-reader-page');
  await reader.evaluate((element) => { element.dataset.ttProbe = 'reader-stays-mounted'; });
  const mark = (await trace(page)).events.at(-1)?.seq ?? -1;

  await expectReaderFillsViewport(page, reader, 768, 1024);
  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader).not.toHaveAttribute('aria-modal');
  await expect(page.locator('html')).toHaveClass(/reader-open/);
  expect(await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflowY,
    body: getComputedStyle(document.body).overflowY,
  }))).toEqual({ html: 'hidden', body: 'hidden' });

  if (browserName === 'chromium') {
    const beforeOuterScroll = await page.evaluate(() => window.scrollY);
    const header = await reader.locator('.reader-header').boundingBox();
    expect(header).not.toBeNull();
    await page.mouse.move(header!.x + 8, header!.y + 8);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(beforeOuterScroll);
  }
  await expectReaderFillsViewport(page, reader, 768, 1024);

  await expectReaderFillsViewport(page, reader, 390, 844);
  await expect(page.getByRole('region', { name: 'Corpus status' })).toHaveCount(0);
  await expect(page.locator('.utility-pane')).toHaveCount(0);
  await expect(page.locator('[inert]')).toHaveCount(0);
  expect(await page.locator('main button, main a, main input, main select, main textarea')
    .evaluateAll((elements, readerId) => elements.every(
      (element) => element.closest(`#${readerId}`) !== null,
    ), 'reader-region')).toBe(true);
  await expect(reader).toBeFocused();
  const pane = reader.locator('.reader-prose-pane');
  expect(await pane.evaluate(
    (element) => getComputedStyle(element).overflowY,
  )).toBe('hidden');
  expect(await reader.evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');
  expect(await reader.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe('none');
  expect(await reader.locator('[data-reader-page]').evaluate(
    (element) => {
      const style = getComputedStyle(element);
      // WebKit exposes this computed value only through its prefixed property.
      return style.getPropertyValue('user-select')
        || style.getPropertyValue('-webkit-user-select');
    },
  )).toBe('text');
  const fit = await pane.evaluate((element) => {
    const pageElement = element.querySelector<HTMLElement>('[data-reader-page]');
    const paneRect = element.getBoundingClientRect();
    const pageRect = pageElement?.getBoundingClientRect();
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      pageBottom: pageRect?.bottom ?? Number.POSITIVE_INFINITY,
      paneBottom: paneRect.bottom,
    };
  });
  expect(fit.pageBottom).toBeLessThanOrEqual(fit.paneBottom + 0.5);
  expect(fit.scrollHeight).toBeLessThanOrEqual(fit.clientHeight + 1);
  const compactRange = parseReaderRange(
    await reader.locator('[data-reader-page]').getAttribute('data-reader-page'),
  );
  const initialRange = parseReaderRange(pageRange);
  expect(compactRange[0]).toBe(initialRange[0]);
  expect(compactRange[1]).toBeLessThan(initialRange[1]);

  await expectReaderFillsViewport(page, reader, 320, 800);
  await expectReaderFillsViewport(page, reader, 1440, 900);
  await expect(reader).not.toHaveAttribute('role', 'dialog');
  await expect(reader).toHaveAttribute('data-tt-probe', 'reader-stays-mounted');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute('data-reader-page', pageRange!);
  expect(workerQueriesAfter((await trace(page)).events, mark)).toEqual([]);
});

test('prose taps select a reading cursor while blank gutters retain page turns', async ({ page }) => {
  const { reader } = await openReader(page);
  await expectReaderFillsViewport(page, reader, 390, 844);
  const pane = reader.locator('.reader-prose-pane');
  const source = reader.locator('[data-reader-page]');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const y = paneBox!.y + paneBox!.height / 2;
  const center = { x: paneBox!.x + paneBox!.width / 2, y };
  const right = { x: paneBox!.x + paneBox!.width - 4, y };
  const initial = await settledReaderRange(reader);
  const before = await trace(page);
  const queryMark = before.events.at(-1)?.seq ?? 0;

  const selectable = source.locator('[data-reader-offset]:not([data-reader-mark])')
    .filter({ hasText: /\S/ }).first();
  const selectableBox = await selectable.boundingBox();
  expect(selectableBox).not.toBeNull();
  const wordPoint = {
    x: selectableBox!.x + selectableBox!.width / 2,
    y: selectableBox!.y + selectableBox!.height / 2,
  };
  await dispatchReaderPointer(selectable, 'touch', wordPoint);
  await expect(source.locator('[data-reader-cursor="true"]')).toBeVisible();
  expect(await settledReaderRange(reader)).toEqual(initial);
  expect(workerQueriesAfter((await trace(page)).events, queryMark)).toEqual([]);
  expect(await source.locator('[data-reader-offset]').evaluateAll((spans) => spans.every(
    (span) => span.childNodes.length === 1 && span.firstChild?.nodeType === Node.TEXT_NODE,
  ))).toBe(true);
  const caretFallbacks = await source.evaluate((root) => {
    const span = root.querySelector<HTMLElement>('[data-reader-offset]');
    const text = span?.firstChild;
    if (!span || !text) throw new Error('reader offset span is unavailable');
    const rect = Array.from(span.getClientRects()).find(
      (candidate) => candidate.width > 0 && candidate.height > 0,
    );
    if (!rect) throw new Error('reader offset span has no painted fragment');
    const init = {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 91,
      isPrimary: true,
      button: 0,
      clientX: rect.left + 1,
      clientY: rect.top + rect.height / 2,
    };
    const ownPosition = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    const ownRange = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint');
    const ownElement = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
      if (descriptor) Object.defineProperty(document, name, descriptor);
      else delete (document as unknown as Record<string, unknown>)[name];
    };
    const fire = () => {
      span.dispatchEvent(new PointerEvent('pointerdown', init));
      span.dispatchEvent(new PointerEvent('pointerup', init));
    };
    let legacy = 0;
    let elementNode = 0;
    let fallback = 0;
    try {
      const range = document.createRange();
      range.setStart(text, Math.min(1, text.textContent?.length ?? 0));
      range.collapse(true);
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => null,
      });
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: () => { legacy += 1; return range; },
      });
      fire();

      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => {
          elementNode += 1;
          return { offsetNode: span, offset: 1, getClientRect: () => rect };
        },
      });
      fire();

      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => null,
      });
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: () => null,
      });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => { fallback += 1; return span; },
      });
      fire();
    } finally {
      restore('caretPositionFromPoint', ownPosition);
      restore('caretRangeFromPoint', ownRange);
      restore('elementFromPoint', ownElement);
    }
    return { legacy, elementNode, fallback };
  });
  expect(caretFallbacks).toEqual({ legacy: 1, elementNode: 1, fallback: 2 });

  const nearEdgeToken = await source.evaluate((root) => {
    const paneElement = root.closest<HTMLElement>('.reader-prose-pane');
    if (!paneElement) throw new Error('reader prose pane is unavailable');
    const paneRect = paneElement.getBoundingClientRect();
    const edge = Math.max(44, Math.min(120, paneRect.width * 0.18));
    for (const span of root.querySelectorAll<HTMLElement>('[data-reader-offset]')) {
      const text = span.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE || !text.textContent) continue;
      for (let index = 0; index < text.textContent.length; index += 1) {
        if (!/\S/.test(text.textContent[index] ?? '')) continue;
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = Array.from(range.getClientRects()).find(
          (candidate) => candidate.width > 0 && candidate.height > 0,
        );
        if (!rect) continue;
        const x = rect.left + rect.width / 2;
        if (x <= paneRect.left + edge || x >= paneRect.right - edge) {
          return { x, y: rect.top + rect.height / 2 };
        }
      }
    }
    return null;
  });
  expect(nearEdgeToken).not.toBeNull();
  await dispatchReaderPointer(source, 'touch', nearEdgeToken!);
  await expect(source.locator('[data-reader-cursor="true"]')).toBeVisible();
  expect(await settledReaderRange(reader)).toEqual(initial);

  const blankInlineEdge = await source.evaluate((root) => {
    const paneElement = root.closest<HTMLElement>('.reader-prose-pane');
    if (!paneElement) throw new Error('reader prose pane is unavailable');
    const paneRect = paneElement.getBoundingClientRect();
    const sourceRect = root.getBoundingClientRect();
    const edge = Math.max(44, Math.min(120, paneRect.width * 0.18));
    const x = Math.min(sourceRect.right - 2, paneRect.right - 4);
    if (x < paneRect.right - edge) return null;
    for (let y = sourceRect.top + 2; y < sourceRect.bottom - 2; y += 2) {
      if (document.elementFromPoint(x, y) === root) return { x, y };
    }
    return null;
  });
  expect(blankInlineEdge).not.toBeNull();
  await dispatchReaderPointer(source, 'touch', blankInlineEdge!);
  await expect(source).toHaveAttribute('data-reader-page', new RegExp(`^${initial[1]}:`));
  await reader.locator('.reader-page-previous').click();
  await expect(source).toHaveAttribute('data-reader-page', new RegExp(`^${initial[0]}:`));
  expect(await settledReaderRange(reader)).toEqual(initial);

  await dispatchReaderPointer(pane, 'touch', center);
  await dispatchReaderPointer(pane, 'mouse', right);
  const mark = reader.locator('[data-reader-mark]').first();
  await expect(mark).toBeVisible();
  await dispatchReaderPointer(mark, 'touch', right);
  await dispatchReaderPointer(
    reader.getByRole('button', { name: 'back', exact: true }),
    'touch',
    right,
  );
  const pointer = { pointerType: 'touch', isPrimary: true, button: 0 };
  const rightPointer = { ...pointer, clientX: right.x, clientY: right.y };
  await pane.dispatchEvent('pointerdown', { ...rightPointer, pointerId: 8 });
  await pane.dispatchEvent('pointercancel', { ...rightPointer, pointerId: 8 });
  await pane.dispatchEvent('pointerup', { ...rightPointer, pointerId: 8 });
  await pane.dispatchEvent('pointerdown', { ...rightPointer, pointerId: 9 });
  await pane.dispatchEvent('pointerup', { ...rightPointer, pointerId: 10 });
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);

  await reader.locator('[data-reader-page]').evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text || !text.textContent) throw new Error('reader page has no selectable text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(2, text.textContent.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await dispatchReaderPointer(pane, 'touch', right);
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  await dispatchReaderPointer(pane, 'touch', right, { x: center.x, y: center.y + 20 });
  await page.waitForTimeout(100);
  expect(await settledReaderRange(reader)).toEqual(initial);

  // A wide viewport has real blank gutters; their existing page-turn gesture remains.
  await expectReaderFillsViewport(page, reader, 1440, 900);
  const wideInitial = await settledReaderRange(reader);
  const wideBox = await pane.boundingBox();
  expect(wideBox).not.toBeNull();
  const wideRight = {
    x: wideBox!.x + wideBox!.width - 4,
    y: wideBox!.y + wideBox!.height / 2,
  };
  await dispatchReaderPointer(pane, 'touch', wideRight);
  await expect(reader.locator('[data-reader-page]'))
    .toHaveAttribute('data-reader-page', new RegExp(`^${wideInitial[1]}:`));
  const next = await settledReaderRange(reader);
  expect(next[0]).toBe(wideInitial[1]);

  const wideLeft = { x: wideBox!.x + 4, y: wideRight.y };
  await dispatchReaderPointer(pane, 'touch', wideLeft);
  await expect(reader.locator('[data-reader-page]'))
    .toHaveAttribute('data-reader-page', new RegExp(`^${wideInitial[0]}:`));
  expect(await settledReaderRange(reader)).toEqual(wideInitial);
});
