import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  activateReaderCommand,
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
  submitAndAwaitFreshResults,
} from './helpers.ts';

async function openReader(page: Page): Promise<Locator> {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await page.getByRole('navigation', { name: 'Workbench sections' })
    .getByRole('link', { name: 'Matches', exact: true }).click();
  const open = page.getByRole('grid', { name: 'Matches' })
    .getByRole('rowgroup')
    .getByRole('button')
    .first();
  await expect(open).toBeVisible();
  await open.click();
  const reader = page.getByRole('main', { name: /Reader:/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  await expect(reader.locator('.reader-prose-pane')).not.toHaveAttribute('data-reader-fitting');
  await expect(reader).toHaveAttribute('data-reader-fit-size', /^\d+x\d+$/);
  return reader;
}

function displayedToken(position: string | null): number {
  const match = /token ([\d,]+)/.exec(position ?? '');
  expect(match).not.toBeNull();
  return Number(match![1]!.replaceAll(',', '')) - 1;
}

async function enterRsvp(reader: Locator): Promise<void> {
  await reader.focus();
  await reader.press('Shift+S');
  await expect(reader.getByRole('region', { name: 'Speed reading word' })).toBeVisible();
  await expect(reader).toHaveAttribute('data-shortcut-context', 'rsvp');
}

async function chooseWordsAtOnce(group: Locator, value: 1 | 2 | 3): Promise<void> {
  await group.locator(`.reader-rsvp-words-option:has(input[value="${value}"])`).click();
}

test('a visible Reader control starts paused Speed reading at the selected word', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });
  await gotoPlace(page, 'inputs');
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'wolf alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. '.repeat(20),
      'utf-8',
    ),
  });
  await awaitReadyCount(page, 1);
  await submitAndAwaitFreshResults(page, 'wolf');
  await gotoPlace(page, 'matches');
  await page.getByRole('grid', { name: 'Matches' })
    .getByRole('rowgroup').getByRole('button').first().click();

  const reader = page.getByRole('main', { name: /Reader:/ });
  const source = reader.locator('[data-reader-page]');
  await expect(source).toBeVisible();
  const layout = reader.locator('.reader-read-layout');
  await expect(layout).toHaveAttribute('data-reader-layout', /^(bar|rails)$/);
  const title = await layout.getAttribute('data-reader-layout') === 'rails'
    ? reader.locator('.reader-wide-position > strong')
    : reader.locator('.reader-control-position > strong');
  await expect(title).toHaveText('one');
  await expect(layout).not.toContainText(/text \d+ of/);
  const arrivalSpeed = reader.getByRole('button', {
    name: 'Open Speed reader paused at the reading cursor',
    exact: true,
  });
  await expect(arrivalSpeed).toBeEnabled();

  const target = source.locator('[data-reader-offset]').filter({ hasText: /\S/ }).nth(2);
  await target.click();
  const cursor = source.locator('[data-reader-cursor-start="true"]');
  await expect(cursor).toBeVisible();
  const selectedWord = (await cursor.textContent())?.trim() ?? '';
  expect(selectedWord.length).toBeGreaterThan(0);

  const speed = reader.getByRole('button', {
    name: `Open Speed reader paused from “${selectedWord}”`,
    exact: true,
  });
  await expect(speed).toBeVisible();
  const readerProgress = reader.getByRole('slider', { name: /Position in/ });
  const selectedProgress = await readerProgress.getAttribute('data-reader-progress');
  if (testInfo.project.name === 'webkit-compact') {
    expect((await speed.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await speed.click();

  await expect(reader.locator('.reader-rsvp-shell [role="status"]')).toContainText('paused');
  await expect(reader.getByRole('region', { name: 'Speed reading word' })
    .locator('.reader-rsvp-word')).toHaveText(selectedWord);
  const speedProgress = reader.getByRole('slider', { name: /Position in/ });
  await expect(speedProgress).toHaveCount(1);
  await expect(speedProgress).toHaveAttribute('data-reader-progress', selectedProgress ?? '');
  await expect(speedProgress).not.toHaveAttribute('aria-live');
  await page.keyboard.press('Space');
  await expect(speedProgress).not.toHaveAttribute('data-reader-progress', selectedProgress ?? '');
});

test('mobile Speed reading gives the word stage the portrait and landscape viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const reader = await openReader(page);
  await enterRsvp(reader);

  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const controls = reader.locator('.reader-rsvp-controls-region');
  const progress = reader.getByRole('slider', { name: /Position in/ });
  await expect(reader.locator('.workbench-dock')).toHaveCount(0);
  await expect(progress).toHaveCount(1);
  await expect(progress).toBeVisible();
  await expect(progress.locator('.reader-progress-fill')).toHaveCSS('transition-duration', '0s');
  const railBox = await progress.boundingBox();
  const cursorBox = await progress.locator('.reader-progress-cursor').boundingBox();
  expect(railBox).not.toBeNull();
  expect(cursorBox).not.toBeNull();
  expect(cursorBox!.x).toBeGreaterThanOrEqual(railBox!.x);
  expect(cursorBox!.x + cursorBox!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width + 0.5);
  await expect(reader).toHaveAttribute('data-reader-footer', 'false');
  await expect.poll(() => controls.evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const portraitTargets = await reader.locator(
    '.reader-rsvp-topbar > button, .reader-rsvp-movement > button, '
      + '.reader-rsvp-pace-stepper > button, '
      + '.reader-rsvp-pace input, .reader-rsvp-words-option, .reader-rsvp-preset select',
  ).evaluateAll((elements) => elements
    .filter((element) => (element as HTMLElement).offsetParent !== null)
    .map((element) => element.getBoundingClientRect().height));
  expect(portraitTargets.length).toBeGreaterThan(5);
  expect(Math.min(...portraitTargets)).toBeGreaterThanOrEqual(44);
  const [slowerBox, paceBox, fasterBox] = await Promise.all([
    reader.getByRole('button', { name: /Slower/ }).boundingBox(),
    reader.getByRole('spinbutton', { name: 'Pace in words per minute' }).boundingBox(),
    reader.getByRole('button', { name: /Faster/ }).boundingBox(),
  ]);
  if (!slowerBox || !paceBox || !fasterBox) throw new Error('Speed pace controls have no layout');
  expect(Math.abs(slowerBox.x + slowerBox.width - paceBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(paceBox.x + paceBox.width - fasterBox.x)).toBeLessThanOrEqual(1);
  await expect(reader.getByRole('spinbutton', { name: 'Pace in words per minute' }))
    .toHaveCSS('appearance', 'textfield');
  expect((await stage.boundingBox())?.height).toBeGreaterThan(200);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(reader).toHaveAttribute('data-reader-footer', 'false');
  await expect(stage).toBeVisible();
  await expect.poll(() => controls.evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const landscapeTargets = await reader.locator(
    '.reader-rsvp-topbar > button, .reader-rsvp-movement > button, '
      + '.reader-rsvp-pace-stepper > button, '
      + '.reader-rsvp-pace input, .reader-rsvp-words-option, .reader-rsvp-preset select',
  ).evaluateAll((elements) => elements
    .filter((element) => (element as HTMLElement).offsetParent !== null)
    .map((element) => element.getBoundingClientRect().height));
  expect(landscapeTargets.length).toBeGreaterThan(5);
  expect(Math.min(...landscapeTargets)).toBeGreaterThanOrEqual(44);
  const landscapeViewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(landscapeViewport.scrollWidth).toBeLessThanOrEqual(landscapeViewport.clientWidth);
  expect(landscapeViewport.scrollHeight).toBeLessThanOrEqual(landscapeViewport.clientHeight);
  expect((await stage.boundingBox())?.height).toBeGreaterThan(100);

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(reader.getByRole('button', { name: 'Return to Reader', exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Open Speed settings', exact: true })).toBeVisible();
  await expect(progress).toHaveCount(1);
  await expect.poll(() => controls.evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const compactViewport = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(compactViewport.root).toBeLessThanOrEqual(compactViewport.client);
  expect(compactViewport.body).toBeLessThanOrEqual(compactViewport.client);
  await page.locator('html').evaluate((element) => { element.style.fontSize = '200%'; });
  await expect.poll(() => controls.evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const zoomedViewport = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(zoomedViewport.root).toBeLessThanOrEqual(zoomedViewport.client);
  expect(zoomedViewport.body).toBeLessThanOrEqual(zoomedViewport.client);
  await expect(reader.getByRole('button', { name: 'Return to Reader', exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Open Speed settings', exact: true })).toBeVisible();

  await reader.getByRole('button', { name: 'Return to Reader', exact: true }).click();
  await expect(reader).toHaveAttribute('data-reader-footer', 'false');
  await expect(reader.locator('.workbench-dock')).toHaveCount(0);
  const entrance = reader.getByRole('button', { name: /Open Speed reader paused/ });
  await expect(entrance).toBeVisible();
  expect((await entrance.boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

test('the semi-hidden RSVP surface anchors words and owns its keyboard controls', async ({ page }) => {
  const reader = await openReader(page);

  await activateReaderCommand(page, reader, 'Open Reader help');
  let shortcuts = page.getByRole('dialog', { name: 'Help' });
  await expect(shortcuts.getByRole('heading', { name: 'Speed reader' })).toBeVisible();
  await expect(shortcuts.getByText('Toggle Speed reader', { exact: true })).toBeVisible();
  await page.keyboard.press('?');

  await enterRsvp(reader);
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const word = stage.locator('.reader-rsvp-word');
  const anchor = stage.locator('.reader-rsvp-anchor');
  await expect(reader.locator('[data-reader-page]')).toHaveCount(0);
  await expect(reader.locator('.workbench-dock')).toHaveCount(0);
  await expect(reader.locator('.reader-rsvp-shell [role="status"]')).toContainText('playing');

  const initialWord = await word.textContent();
  const initialAnchor = await anchor.boundingBox();
  const playingWordBox = await word.boundingBox();
  expect(initialAnchor).not.toBeNull();
  expect(playingWordBox).not.toBeNull();
  await expect.poll(() => word.textContent()).not.toBe(initialWord);
  const nextAnchor = await anchor.boundingBox();
  const readerBox = await reader.boundingBox();
  expect(nextAnchor).not.toBeNull();
  expect(readerBox).not.toBeNull();
  expect(nextAnchor!.x + nextAnchor!.width / 2)
    .toBeCloseTo(initialAnchor!.x + initialAnchor!.width / 2, 1);
  expect(nextAnchor!.x + nextAnchor!.width / 2)
    .toBeCloseTo(readerBox!.x + readerBox!.width / 2, 1);

  await page.keyboard.press('Space');
  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  await expect(status).toContainText('paused');
  const context = reader.getByRole('note', { name: 'Paused sentence context' });
  await expect(context).toBeVisible();
  await expect(context).not.toHaveAttribute('aria-live');
  await expect(context.locator('mark')).toHaveText(await word.textContent() ?? '');
  const pausedWordBox = await word.boundingBox();
  expect(pausedWordBox).not.toBeNull();
  expect(pausedWordBox!.y).toBeCloseTo(playingWordBox!.y, 1);
  await context.click();
  await expect(stage).toBeVisible();
  await expect(context).toBeFocused();
  const position = reader.locator('.reader-position');
  await expect(position).toContainText('300 WPM');
  const tokenBeforeWordKeys = displayedToken(await position.textContent());
  await reader.press('h');
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(tokenBeforeWordKeys - 1);
  await reader.press('ArrowRight');
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(tokenBeforeWordKeys);
  await reader.press('j');
  await expect(position).toContainText('275 WPM');
  await reader.press('ArrowUp');
  await expect(position).toContainText('300 WPM');
  const protectedPosition = await position.textContent();
  for (const key of ['PageDown', 'Home', 'w', 'Control+f']) {
    await reader.press(key);
    await expect(reader.getByRole('region', { name: 'Speed reading word' })).toBeVisible();
    await expect(position).toHaveText(protectedPosition!);
  }

  const back = reader.getByRole('button', { name: 'Previous passage', exact: true });
  const play = reader.getByRole('button', { name: /^(play|pause)$/ });
  const firstControl = reader.getByRole('button', { name: 'Return to Reader', exact: true });
  const lastControl = reader.getByRole('combobox', { name: 'Rhythm preset' });
  await firstControl.focus();
  await firstControl.press('Shift+Tab');
  await expect(lastControl).toBeFocused();
  await lastControl.press('Tab');
  await expect(firstControl).toBeFocused();
  await play.focus();
  await play.press('Space');
  await expect(status).toContainText('playing');
  await expect(context).toHaveCount(0);
  await expect(back).toBeEnabled();
  const tokenBeforeBack = displayedToken(await position.textContent());
  await back.click();
  await expect(status).toContainText('paused');
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBeLessThanOrEqual(tokenBeforeBack);
  await expect(context).toBeVisible();
  const tokenBeforePausedBack = displayedToken(await position.textContent());
  await back.click();
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBeLessThan(tokenBeforePausedBack);

  await reader.press('Shift+W');
  const pace = reader.getByRole('spinbutton', { name: 'Pace in words per minute' });
  await expect(pace).toBeFocused();
  await pace.fill('425');
  await pace.press('Enter');
  await expect(position).toContainText('425 WPM');
  await expect(play).toBeFocused();

  await play.press('Space');
  await expect(status).toContainText('playing');
  await play.press('?');
  shortcuts = page.getByRole('dialog', { name: 'Help' });
  await expect(shortcuts.getByRole('heading', { name: 'Speed reader' })).toBeVisible();
  await expect(shortcuts.getByRole('heading', { name: 'Reader', exact: true })).toHaveCount(0);
  await expect(shortcuts.getByRole('button', { name: /Find in corpus/ })).toHaveCount(0);
  await expect(status).toContainText('paused');
  await page.keyboard.press('?');
  await expect(shortcuts).toHaveCount(0);
  await expect(status).toContainText('paused');
  await expect(play).toBeFocused();

  const token = displayedToken(await position.textContent());
  await reader.press('Shift+W');
  await expect(pace).toBeFocused();
  await pace.press('Shift+S');
  await expect(reader.getByRole('region', { name: 'Speed reading word' })).toHaveCount(0);
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${token}:`),
  );
});

test('Speed word/passage controls, frame taps, and progress dragging seek exactly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reader = await openReader(page);
  await enterRsvp(reader);
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const position = reader.locator('.reader-position');
  const words = reader.getByRole('group', { name: /^Words at once/ });
  await chooseWordsAtOnce(words, 3);

  const previousPassage = reader.getByRole('button', { name: 'Previous passage', exact: true });
  const previousWord = reader.getByRole('button', { name: 'Previous word', exact: true });
  const play = reader.getByRole('button', { name: 'play', exact: true });
  const nextWord = reader.getByRole('button', { name: 'Next word', exact: true });
  const nextPassage = reader.getByRole('button', { name: 'Next passage', exact: true });
  await expect(reader.locator('.reader-rsvp-movement > button')).toHaveCount(5);
  await expect(previousPassage).toBeVisible();
  await expect(previousWord).toBeVisible();
  await expect(play).toBeVisible();
  await expect(nextWord).toBeVisible();
  await expect(nextPassage).toBeVisible();

  const wordStart = displayedToken(await position.textContent());
  await nextWord.click();
  await expect.poll(async () => displayedToken(await position.textContent())).toBe(wordStart + 1);
  await previousWord.click();
  await expect.poll(async () => displayedToken(await position.textContent())).toBe(wordStart);

  let frameTokens: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    frameTokens = await stage.locator('[data-rsvp-frame-token]').evaluateAll((elements) =>
      [...new Set(elements.map((element) => Number(
        (element as HTMLElement).dataset.rsvpFrameToken,
      )))],
    );
    if (frameTokens.length > 1) break;
    await nextWord.click();
  }
  expect(frameTokens.length).toBeGreaterThan(1);
  const clickedToken = frameTokens[1]!;
  const slipPointer = {
    pointerType: 'mouse', pointerId: 19, isPrimary: true, button: 0,
    clientX: 20, clientY: 20,
  };
  await stage.locator(`[data-rsvp-frame-token="${frameTokens[0]}"]`).last()
    .dispatchEvent('pointerdown', slipPointer);
  await stage.locator(`[data-rsvp-frame-token="${clickedToken}"]`).last()
    .dispatchEvent('pointerup', slipPointer);
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(clickedToken);
  await expect(stage.locator(`[data-rsvp-frame-token="${clickedToken}"]`)).not.toHaveCount(0);

  const context = reader.getByRole('note', { name: 'Paused sentence context' });
  const contextRange = async (): Promise<readonly [number, number]> => {
    let range: readonly [number, number] | null = null;
    await expect.poll(async () => {
      const match = /^(\d+):(\d+)$/.exec(
        await context.getAttribute('data-rsvp-context') ?? '',
      );
      if (match === null) return false;
      const candidate = [Number(match[1]), Number(match[2])] as const;
      const active = displayedToken(await position.textContent());
      if (active < candidate[0] || active >= candidate[1]) return false;
      range = candidate;
      return true;
    }).toBe(true);
    if (range === null) throw new Error('Speed passage has no token range');
    return range;
  };
  const frameStart = displayedToken(await position.textContent());
  const firstPassage = await contextRange();
  await nextPassage.click();
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(firstPassage[1]);
  const secondPassage = await contextRange();
  expect(secondPassage[0]).toBeLessThanOrEqual(firstPassage[1]);
  await previousPassage.click();
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(frameStart);

  const progress = reader.getByRole('slider', { name: /Position in/ });
  const progressBox = await progress.boundingBox();
  if (!progressBox) throw new Error('Speed position slider has no layout box');
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest('[role="slider"]')?.getAttribute('role') ?? ''
  ), { x: progressBox.x + progressBox.width / 2, y: progressBox.y + 8.5 })).toBe('slider');

  await progress.press('Home');
  await expect.poll(async () => displayedToken(await position.textContent())).toBe(0);
  await expect(progress).not.toHaveAttribute('data-seeking', 'true');
  let canonicalStart = 0;
  const visitedPassages = [canonicalStart];
  for (let step = 0; step < 2; step++) {
    const passage = await contextRange();
    await nextPassage.click();
    canonicalStart = passage[1];
    await expect.poll(async () => displayedToken(await position.textContent()))
      .toBe(canonicalStart);
    visitedPassages.push(canonicalStart);
    const landingPassage = await contextRange();
    expect(landingPassage[0]).toBeLessThanOrEqual(passage[1]);
  }
  for (const prior of visitedPassages.slice(0, -1).reverse()) {
    await previousPassage.click();
    await expect.poll(async () => displayedToken(await position.textContent())).toBe(prior);
  }
  for (const later of visitedPassages.slice(1)) {
    await nextPassage.click();
    await expect.poll(async () => displayedToken(await position.textContent())).toBe(later);
  }
  await nextWord.click();
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(canonicalStart + 1);
  const priorPassage = await contextRange();
  await previousPassage.click();
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(priorPassage[0] - 1);

  const tokenCount = Number(await progress.getAttribute('aria-valuemax'));
  const targetToken = Math.round(0.7 * (tokenCount - 1));
  const y = progressBox.y + progressBox.height / 2;
  const pointer = {
    pointerType: 'mouse', pointerId: 23, isPrimary: true, button: 0,
  };
  await progress.dispatchEvent('pointerdown', {
    ...pointer,
    clientX: progressBox.x + progressBox.width * 0.3,
    clientY: y,
  });
  await progress.dispatchEvent('pointermove', {
    ...pointer,
    clientX: progressBox.x + progressBox.width * 0.7,
    clientY: y,
  });
  await expect(progress).toHaveAttribute('data-seeking', 'true');
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(targetToken);
  await expect(stage.locator(`[data-rsvp-frame-token="${targetToken}"]`)).not.toHaveCount(0);
  await progress.dispatchEvent('pointerup', {
    ...pointer,
    clientX: progressBox.x + progressBox.width * 0.7,
    clientY: y,
  });
  await expect(progress).not.toHaveAttribute('data-seeking', 'true');

  const keyboardTarget = targetToken + Math.max(1, Math.round((tokenCount - 1) / 100));
  await progress.focus();
  await progress.press('ArrowRight');
  await expect.poll(async () => displayedToken(await position.textContent()))
    .toBe(keyboardTarget);
});

test('stage taps toggle playback while only explicit exits return to Reader', async ({ page }) => {
  const reader = await openReader(page);
  await enterRsvp(reader);
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  const position = reader.locator('.reader-position');
  await expect(status).toContainText('playing');

  await stage.click({ position: { x: 8, y: 8 } });
  await expect(status).toContainText('paused');
  await expect(stage).toBeVisible();
  await stage.click({ position: { x: 8, y: 8 } });
  await expect(status).toContainText('playing');

  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  await stage.dispatchEvent('pointerdown', {
    pointerType: 'touch', pointerId: 31, isPrimary: true, button: 0,
    clientX: stageBox!.x + 20, clientY: stageBox!.y + 20,
  });
  await stage.dispatchEvent('pointerup', {
    pointerType: 'touch', pointerId: 31, isPrimary: true, button: 0,
    clientX: stageBox!.x + 40, clientY: stageBox!.y + 20,
  });
  await expect(status).toContainText('playing');

  await reader.locator('.reader-rsvp-identity').click();
  await expect(stage).toBeVisible();
  await expect(status).toContainText('playing');
  const escapeToken = displayedToken(await position.textContent());
  await page.keyboard.press('Escape');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${escapeToken}:`),
  );

  await expect(reader.locator('.reader-prose-pane')).not.toHaveAttribute('data-reader-fitting');
  await enterRsvp(reader);
  await page.keyboard.press('Space');
  const returnToken = displayedToken(await position.textContent());
  await expect(reader.locator('.workbench-dock')).toHaveCount(0);

  await reader.getByRole('button', { name: 'Return to Reader', exact: true }).click();
  await expect(reader.getByRole('region', { name: 'Speed reading word' })).toHaveCount(0);
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${returnToken}:`),
  );
  await expect(reader.locator('[data-reader-cursor-start="true"]')).toBeVisible();
});

test('display and rhythm controls preserve pace, responsive grouping, and exact exit', async ({ page }) => {
  const reader = await openReader(page);
  await enterRsvp(reader);
  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  const position = reader.locator('.reader-position');
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const pace = reader.getByRole('spinbutton', { name: 'Pace in words per minute' });
  const settingsTrigger = reader.getByRole('button', {
    name: 'Open Speed settings',
    exact: true,
  });
  const settings = page.getByRole('dialog', { name: 'Speed settings' });
  const preset = reader.locator('.reader-rsvp-preset select');
  const words = reader.getByRole('group', { name: /^Words at once/ });
  const oneWord = words.getByRole('radio', { name: '1 word at once' });
  const twoWords = words.getByRole('radio', { name: '2 words at once' });
  const threeWords = words.getByRole('radio', { name: '3 words at once' });
  await expect(reader.getByRole('button', { name: 'help', exact: true })).toHaveCount(0);

  await expect(pace).toHaveAttribute('max', '2000');
  await pace.fill('2000');
  await pace.press('Enter');
  await expect(position).toContainText('2,000 WPM');
  const stageBoxBeforeSettings = await stage.boundingBox();
  await settingsTrigger.click();
  await expect(settings).toBeVisible();
  await expect(status).toContainText('paused');
  await expect(settings.getByRole('heading', { name: 'Timing notes' })).toBeVisible();
  await expect(settings).toContainText('Showing 2 or 3 words at once');
  await expect(settings).toContainText('Boundary rests are zero at this pace');
  await expect.poll(() => page.locator('#root').evaluate((root) => (root as HTMLElement).inert))
    .toBe(true);
  expect(await stage.boundingBox()).toEqual(stageBoxBeforeSettings);

  let charLimit = settings.getByRole('spinbutton', { name: 'Frame character limit in characters' });
  let sentence = settings.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  await expect(charLimit).toHaveAttribute('aria-disabled', 'true');
  await charLimit.focus();
  await expect(charLimit).toBeFocused();
  await expect(charLimit).toHaveAccessibleDescription('applies with 2+ words');
  await charLimit.press('ArrowUp');
  await expect(charLimit).toHaveValue('30');
  await charLimit.press('Tab');
  await expect(sentence).toBeFocused();
  await settings.getByRole('button', { name: 'Speed reader help', exact: true }).click();
  await expect(settings).toHaveCount(0);
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help.getByRole('heading', { name: 'Speed reader' })).toBeVisible();
  await help.getByRole('button', { name: 'close', exact: true }).click();
  await expect(help).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();
  expect(await stage.boundingBox()).toEqual(stageBoxBeforeSettings);

  await pace.fill('425');
  await pace.press('Enter');
  await expect(position).toContainText('425 WPM');
  await page.setViewportSize({ width: 900, height: 800 });
  await oneWord.focus();
  await expect.poll(() => oneWord.evaluate((input) => (
    getComputedStyle(input.closest('.reader-rsvp-words-option')!).outlineStyle
  ))).toBe('solid');
  await oneWord.press('ArrowRight');
  await expect(twoWords).toBeChecked();
  await preset.selectOption('study');
  await expect(status).toContainText('paused');

  await settingsTrigger.click();
  await expect(settings).toBeVisible();
  sentence = settings.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  const paragraph = settings.getByRole('spinbutton', { name: 'Paragraph rest in milliseconds' });
  charLimit = settings.getByRole('spinbutton', { name: 'Frame character limit in characters' });
  await expect(charLimit).not.toHaveAttribute('aria-disabled', 'true');
  await charLimit.fill('12');
  await charLimit.press('Enter');
  await expect(charLimit).toHaveValue('12');
  await expect(settings.getByRole('status')).toContainText('character limit 12 characters');
  await expect(position).toContainText('425 WPM');
  await expect(sentence).toHaveValue('500');
  await expect(paragraph).toHaveValue('900');
  await expect(position).toContainText('425 WPM');

  await paragraph.click();
  await paragraph.press('Control+A');
  await paragraph.pressSequentially('1200');
  await paragraph.press('Enter');
  await expect(paragraph).toHaveValue('1200');

  await sentence.fill('250');
  await sentence.press('Enter');
  await expect(preset).toHaveValue('custom');
  await settings.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(preset).toHaveValue('natural');
  await expect(position).toContainText('300 WPM');
  await expect(charLimit).toHaveValue('12');
  await settings.getByRole('button', { name: 'close', exact: true }).click();

  await chooseWordsAtOnce(words, 3);
  await expect(threeWords).toBeChecked();
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '2');
  await expect(threeWords).toBeChecked();
  await expect(words).toHaveAccessibleName(/3 is limited to 2 on this narrow screen/);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');

  const play = reader.getByRole('button', { name: 'play', exact: true });
  const frameText = stage.locator('.reader-rsvp-word');
  const anchor = stage.locator('.reader-rsvp-anchor');
  await expect.poll(() => frameText.evaluate((element) => getComputedStyle(element).whiteSpace))
    .toBe('pre');
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  const columns: number[] = [];
  for (const [value, expected] of [[1, 0.5], [2, 0.42], [3, 0.36]] as const) {
    await chooseWordsAtOnce(words, value);
    await expect(stage).toHaveAttribute('data-rsvp-words', String(value));
    const box = await anchor.boundingBox();
    expect(box).not.toBeNull();
    const column = (box!.x + box!.width / 2 - stageBox!.x) / stageBox!.width;
    columns.push(column);
    expect(column).toBeCloseTo(expected, 2);
  }
  expect(columns[0]).toBeGreaterThan(columns[1]!);
  expect(columns[1]).toBeGreaterThan(columns[2]!);

  const anchorCenters: number[] = [];
  const initialAnchor = await anchor.boundingBox();
  expect(initialAnchor).not.toBeNull();
  anchorCenters.push(initialAnchor!.x + initialAnchor!.width / 2);
  let previousFrame = await frameText.textContent();
  await play.click();
  for (let index = 0; index < 4; index++) {
    await expect.poll(() => frameText.textContent(), { timeout: 5_000 }).not.toBe(previousFrame);
    previousFrame = await frameText.textContent();
    const box = await anchor.boundingBox();
    expect(box).not.toBeNull();
    anchorCenters.push(box!.x + box!.width / 2);
  }
  expect(Math.max(...anchorCenters) - Math.min(...anchorCenters)).toBeLessThan(1);

  const before = await position.textContent();
  await expect.poll(() => position.textContent(), { timeout: 5_000 }).not.toBe(before);
  await reader.getByRole('button', { name: 'pause', exact: true }).click();
  const exitToken = displayedToken(await position.textContent());
  await page.keyboard.press('Escape');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${exitToken}:`),
  );
});

test('a forty-character frame stays anchored and clips locally at 320px', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'wide-rsvp.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Electroencephalogram mischaracterization remains readable.',
      'utf-8',
    ),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('Enter');

  const reader = page.getByRole('main', { name: /Reader: wide-rsvp/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  await enterRsvp(reader);
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  await chooseWordsAtOnce(reader.getByRole('group', { name: /^Words at once/ }), 2);
  await reader.getByRole('button', { name: 'Open Speed settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Speed settings' });
  const charLimit = settings.getByRole('spinbutton', { name: 'Frame character limit in characters' });
  await charLimit.fill('40');
  await charLimit.press('Enter');
  await settings.getByRole('button', { name: 'close', exact: true }).click();

  const frameText = stage.locator('.reader-rsvp-word');
  await expect(frameText).toHaveText('Electroencephalogram mischaracterization');
  const graphemeCount = await frameText.evaluate((element) => Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(element.textContent ?? ''),
  ).length);
  expect(graphemeCount).toBe(40);
  const [compactWideStage, compactWideAnchor] = await Promise.all([
    stage.boundingBox(),
    stage.locator('.reader-rsvp-anchor').boundingBox(),
  ]);
  expect(compactWideStage).not.toBeNull();
  expect(compactWideAnchor).not.toBeNull();
  const compactWideAnchorRatio = (
    compactWideAnchor!.x + compactWideAnchor!.width / 2 - compactWideStage!.x
  ) / compactWideStage!.width;

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '2');
  await expect(frameText).toHaveText('Electroencephalogram mischaracterization');
  const compactLine = await frameText.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(styles.lineHeight),
      textOverflowsRow: element.scrollWidth > element.clientWidth,
    };
  });
  expect(compactLine.height).toBeLessThanOrEqual(compactLine.lineHeight * 1.05);
  expect(compactLine.textOverflowsRow).toBe(true);
  const compactOverflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(compactOverflow.root).toBeLessThanOrEqual(compactOverflow.client);
  expect(compactOverflow.body).toBeLessThanOrEqual(compactOverflow.client);
  const [compactStage, compactAnchor] = await Promise.all([
    stage.boundingBox(),
    stage.locator('.reader-rsvp-anchor').boundingBox(),
  ]);
  expect(compactStage).not.toBeNull();
  expect(compactAnchor).not.toBeNull();
  expect((compactAnchor!.x + compactAnchor!.width / 2 - compactStage!.x) / compactStage!.width)
    .toBeCloseTo(compactWideAnchorRatio, 2);
});

test('reduced-motion preference enters RSVP paused', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reader = await openReader(page);
  await enterRsvp(reader);
  await expect(reader.locator('.reader-rsvp-shell [role="status"]')).toContainText('paused');
  await expect(reader.getByRole('button', { name: 'play', exact: true })).toBeFocused();
});

test('document completion pauses and keeps focus inside RSVP', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true, placeAfterLoad: 'inputs' });
  await clearDemoInputs(page);
  await page.getByLabel('Add files').setInputFiles({
    name: 'short-rsvp.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
      'utf-8',
    ),
  });
  await awaitReadyCount(page, 1);
  await gotoPlace(page, 'trends');
  const slider = page.getByRole('slider', { name: 'Corpus footer position' });
  await slider.focus();
  await slider.press('Enter');
  const reader = page.getByRole('main', { name: /Reader: short-rsvp/ });
  await expect(reader.locator('[data-reader-page]')).toBeVisible();
  await expect(reader).toHaveAttribute('data-reader-fit-size', /^\d+x\d+$/);
  await enterRsvp(reader);

  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const back = reader.getByRole('button', { name: 'Previous passage', exact: true });
  const previousWord = reader.getByRole('button', { name: 'Previous word', exact: true });
  await expect(back).toBeDisabled();
  await expect(reader.locator('.reader-rsvp-identity'))
    .toContainText('paragraph rest 700 ms (500 ms here)');
  await expect(stage).toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(stage).not.toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(status).toContainText('End of document', { timeout: 5_000 });
  await expect(reader.getByRole('button', { name: 'completed', exact: true })).toBeDisabled();
  await expect(reader.getByRole('button', { name: 'Return to Reader', exact: true })).toBeFocused();
  await expect(back).toBeDisabled();
  await expect(previousWord).toBeEnabled();
  await previousWord.click();
  await expect(status).toContainText('paused');
  await expect(status).not.toContainText('End of document');
  await expect(reader.getByRole('button', { name: 'play', exact: true })).toBeEnabled();
  await expect(reader.getByRole('note', { name: 'Paused sentence context' })).toBeVisible();
});
