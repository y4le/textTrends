import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  awaitAllReady,
  awaitReadyCount,
  clearDemoInputs,
  gotoPlace,
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
  const match = /token ([\d,]+) of/.exec(position ?? '');
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

test('the semi-hidden RSVP surface anchors words and owns its keyboard controls', async ({ page }) => {
  const reader = await openReader(page);

  await reader.getByRole('button', { name: 'shortcuts', exact: true }).click();
  let shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts.getByRole('heading', { name: 'Speed reader' })).toHaveCount(0);
  await page.keyboard.press('?');

  await enterRsvp(reader);
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const word = stage.locator('.reader-rsvp-word');
  const anchor = stage.locator('.reader-rsvp-anchor');
  await expect(reader.locator('[data-reader-page]')).toHaveCount(0);
  await expect(reader.locator('.workbench-dock')).toHaveAttribute('inert', '');
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
  await reader.press('h');
  await expect(position).toContainText('275 WPM');
  await reader.press('ArrowRight');
  await expect(position).toContainText('300 WPM');
  const protectedPosition = await position.textContent();
  for (const key of ['PageDown', 'Home', 'w', 'Control+f']) {
    await reader.press(key);
    await expect(reader.getByRole('region', { name: 'Speed reading word' })).toBeVisible();
    await expect(position).toHaveText(protectedPosition!);
  }

  const back = reader.getByRole('button', { name: 'back', exact: true });
  const play = reader.locator('.reader-rsvp-controls > button').nth(1);
  const firstControl = reader.getByRole('button', { name: 'shortcuts', exact: true });
  const rhythm = reader.locator('.reader-rsvp-rhythm > summary');
  await firstControl.focus();
  await firstControl.press('Shift+Tab');
  await expect(rhythm).toBeFocused();
  await rhythm.press('Tab');
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
  shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
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

test('Escape and a consumed click elsewhere return to the exact Reader token', async ({ page }) => {
  const reader = await openReader(page);
  await enterRsvp(reader);
  await page.keyboard.press('Space');
  const position = reader.locator('.reader-position');
  const escapeToken = displayedToken(await position.textContent());
  await page.keyboard.press('Escape');
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${escapeToken}:`),
  );

  await expect(reader.locator('.reader-prose-pane')).not.toHaveAttribute('data-reader-fitting');
  await enterRsvp(reader);
  await page.keyboard.press('Space');
  const clickToken = displayedToken(await position.textContent());
  await reader.getByRole('region', { name: 'Speed reading word' }).click({ position: { x: 8, y: 8 } });
  await expect(reader.getByRole('region', { name: 'Speed reading word' })).toHaveCount(0);
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${clickToken}:`),
  );

  await expect(reader).toHaveAttribute('data-reader-fit-size', /^\d+x\d+$/);
  await enterRsvp(reader);
  await page.keyboard.press('Space');
  const footerToken = displayedToken(await position.textContent());
  const footerBox = await reader.locator('.workbench-dock').boundingBox();
  expect(footerBox).not.toBeNull();
  await page.mouse.click(
    footerBox!.x + footerBox!.width / 2,
    footerBox!.y + footerBox!.height / 2,
  );
  await expect(reader.getByRole('region', { name: 'Speed reading word' })).toHaveCount(0);
  await expect(reader.locator('[data-reader-page]')).toHaveAttribute(
    'data-reader-page',
    new RegExp(`^${footerToken}:`),
  );
});

test('display and rhythm controls preserve pace, responsive grouping, and exact exit', async ({ page }) => {
  const reader = await openReader(page);
  await enterRsvp(reader);
  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  const position = reader.locator('.reader-position');
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const rhythm = reader.locator('.reader-rsvp-rhythm');

  await rhythm.locator('summary').click();
  await expect(rhythm).toHaveAttribute('open', '');
  await expect(status).toContainText('paused');

  const pace = reader.getByRole('spinbutton', { name: 'Pace in words per minute' });
  await expect(pace).toHaveAttribute('max', '2000');
  await pace.fill('2000');
  await pace.press('Enter');
  await expect(position).toContainText('2,000 WPM');
  const speedNote = reader.locator('.reader-rsvp-speed-note');
  await expect(speedNote).toContainText('Showing 2 or 3 words at once');
  await expect(speedNote).toContainText('Boundary rests are zero at this pace');
  await pace.fill('425');
  await pace.press('Enter');
  await expect(position).toContainText('425 WPM');
  await expect(speedNote).toHaveCount(0);

  const preset = reader.getByRole('combobox', { name: 'Rhythm preset' });
  const sentence = reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  const paragraph = reader.getByRole('spinbutton', { name: 'Paragraph rest in milliseconds' });
  const charLimit = reader.getByRole('spinbutton', { name: 'Frame character limit in characters' });
  const words = reader.getByRole('group', { name: /^Words at once/ });
  const oneWord = words.getByRole('radio', { name: '1 word at once' });
  const twoWords = words.getByRole('radio', { name: '2 words at once' });
  const threeWords = words.getByRole('radio', { name: '3 words at once' });
  await expect(charLimit).toHaveAttribute('aria-disabled', 'true');
  await charLimit.focus();
  await expect(charLimit).toBeFocused();
  await expect(charLimit).toHaveAccessibleDescription('applies with 2+ words');
  await charLimit.press('ArrowUp');
  await expect(charLimit).toHaveValue('30');
  await charLimit.press('Tab');
  await expect(preset).toBeFocused();
  await page.setViewportSize({ width: 900, height: 800 });
  await oneWord.focus();
  await expect.poll(() => oneWord.evaluate((input) => (
    getComputedStyle(input.closest('.reader-rsvp-words-option')!).outlineStyle
  ))).toBe('solid');
  await oneWord.press('ArrowRight');
  await expect(twoWords).toBeChecked();
  await expect(charLimit).not.toHaveAttribute('aria-disabled', 'true');
  await charLimit.fill('12');
  await charLimit.press('Enter');
  await expect(charLimit).toHaveValue('12');
  await expect(status).toContainText('character limit 12 characters');
  await expect(position).toContainText('425 WPM');
  await expect(charLimit).toHaveValue('12');
  await twoWords.press('Space');
  await expect(status).toContainText('paused');
  await chooseWordsAtOnce(words, 3);
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');
  await preset.selectOption('study');
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
  await reader.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(preset).toHaveValue('natural');
  await expect(position).toContainText('300 WPM');
  await expect(threeWords).toBeChecked();
  await expect(charLimit).toHaveValue('12');

  await expect(stage).toHaveAttribute('data-rsvp-words', '3');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '2');
  await expect(charLimit).not.toHaveAttribute('aria-disabled', 'true');
  await expect(threeWords).toBeChecked();
  await expect(words.locator('.reader-rsvp-words-caption')).toContainText('3 becomes 2 here');
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');

  await rhythm.locator('summary').click();
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
  const rhythm = reader.locator('.reader-rsvp-rhythm');
  await rhythm.locator('summary').click();
  await chooseWordsAtOnce(reader.getByRole('group', { name: /^Words at once/ }), 2);
  const charLimit = reader.getByRole('spinbutton', { name: 'Frame character limit in characters' });
  await charLimit.fill('40');
  await charLimit.press('Enter');

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

test('migrates v2 preferences and restores the full local frame and rhythm', async ({ page }) => {
  await page.addInitScript(() => {
    const marker = 'texttrends/e2e-rsvp-migration';
    if (sessionStorage.getItem(marker) !== null) return;
    localStorage.removeItem('texttrends/rsvp-rhythm/3');
    localStorage.setItem('texttrends/rsvp-rhythm/2', JSON.stringify({
      wpm: 425,
      wordsPerFrame: 1,
      sentencePauseMs: 350,
      paragraphPauseMs: 700,
      lengthEmphasis: 100,
    }));
    sessionStorage.setItem(marker, 'ready');
  });

  let reader = await openReader(page);
  await enterRsvp(reader);
  await expect(reader.locator('.reader-position')).toContainText('425 WPM');
  const rhythm = reader.locator('.reader-rsvp-rhythm');
  await rhythm.locator('summary').click();
  await chooseWordsAtOnce(reader.getByRole('group', { name: /^Words at once/ }), 2);
  const sentence = reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  await sentence.fill('250');
  await sentence.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('texttrends/rsvp-rhythm/3');
    return raw === null ? null : JSON.parse(raw);
  })).toMatchObject({
    wpm: 425, wordsPerFrame: 2, frameCharLimit: 30, sentencePauseMs: 250,
  });

  await page.keyboard.press('Escape');
  reader = await openReader(page);
  await enterRsvp(reader);
  await expect(reader.locator('.reader-position')).toContainText('425 WPM');
  await expect(reader.getByRole('region', { name: 'Speed reading word' }))
    .toHaveAttribute('data-rsvp-words', '2');
  await reader.locator('.reader-rsvp-rhythm > summary').click();
  await expect(reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' }))
    .toHaveValue('250');
  await expect(reader.getByRole('spinbutton', { name: 'Frame character limit in characters' }))
    .toHaveValue('30');
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
  const back = reader.getByRole('button', { name: 'back', exact: true });
  await expect(back).toBeDisabled();
  await expect(reader.locator('.reader-position'))
    .toContainText('paragraph rest 700 ms (500 ms here)');
  await expect(stage).toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(stage).not.toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(status).toContainText('End of document', { timeout: 5_000 });
  await expect(reader.getByRole('button', { name: 'completed', exact: true })).toBeDisabled();
  await expect(reader.getByRole('button', { name: 'return to Reader', exact: true })).toBeFocused();
  await expect(back).toBeEnabled();
  await back.click();
  await expect(status).toContainText('paused');
  await expect(status).not.toContainText('End of document');
  await expect(reader.getByRole('button', { name: 'play', exact: true })).toBeEnabled();
  await expect(reader.getByRole('note', { name: 'Paused sentence context' })).toBeVisible();
});
