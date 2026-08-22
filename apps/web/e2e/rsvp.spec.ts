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
  const open = page.getByRole('grid', { name: 'Matches' }).getByRole('button').first();
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
  expect(initialAnchor).not.toBeNull();
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

  const play = reader.locator('.reader-rsvp-controls button').first();
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
  await play.press('Space');
  await expect(status).toContainText('paused');

  await reader.press('Shift+W');
  const pace = reader.getByRole('spinbutton', { name: 'Set pace in words per minute' });
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

test('rhythm controls preserve pace, presets, responsive grouping, and exact exit', async ({ page }) => {
  const reader = await openReader(page);
  await enterRsvp(reader);
  const status = reader.locator('.reader-rsvp-shell [role="status"]');
  const position = reader.locator('.reader-position');
  const stage = reader.getByRole('region', { name: 'Speed reading word' });
  const rhythm = reader.locator('.reader-rsvp-rhythm');

  await rhythm.locator('summary').click();
  await expect(rhythm).toHaveAttribute('open', '');
  await expect(status).toContainText('paused');

  const pace = reader.getByRole('spinbutton', { name: 'Set pace in words per minute' });
  await pace.fill('425');
  await pace.press('Enter');
  await expect(position).toContainText('425 WPM');

  const preset = reader.getByRole('combobox', { name: 'Rhythm preset' });
  const sentence = reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  const paragraph = reader.getByRole('spinbutton', { name: 'Paragraph rest in milliseconds' });
  const words = reader.getByRole('combobox', { name: 'Words at once' });
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

  await page.setViewportSize({ width: 900, height: 800 });
  await words.selectOption('3');
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '2');
  await expect(words).toHaveValue('3');
  await expect(words.locator('option[value="3"]')).toContainText('2 on narrow screens');
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(stage).toHaveAttribute('data-rsvp-words', '3');

  await rhythm.locator('summary').click();
  const play = reader.getByRole('button', { name: 'play', exact: true });
  const frameText = stage.locator('.reader-rsvp-word');
  const anchor = stage.locator('.reader-rsvp-anchor');
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

test('migrates the session pace and restores the full local rhythm', async ({ page }) => {
  await page.addInitScript(() => {
    const marker = 'texttrends/e2e-rsvp-migration';
    if (sessionStorage.getItem(marker) !== null) return;
    localStorage.removeItem('texttrends/rsvp-rhythm/2');
    sessionStorage.setItem('texttrends/rsvp-pace/1', JSON.stringify({ wpm: 425 }));
    sessionStorage.setItem(marker, 'ready');
  });

  let reader = await openReader(page);
  await enterRsvp(reader);
  await expect(reader.locator('.reader-position')).toContainText('425 WPM');
  const rhythm = reader.locator('.reader-rsvp-rhythm');
  await rhythm.locator('summary').click();
  await reader.getByRole('combobox', { name: 'Words at once' }).selectOption('2');
  const sentence = reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' });
  await sentence.fill('250');
  await sentence.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('texttrends/rsvp-rhythm/2');
    return raw === null ? null : JSON.parse(raw);
  })).toMatchObject({ wpm: 425, wordsPerFrame: 2, sentencePauseMs: 250 });

  await page.keyboard.press('Escape');
  reader = await openReader(page);
  await enterRsvp(reader);
  await expect(reader.locator('.reader-position')).toContainText('425 WPM');
  await expect(reader.getByRole('region', { name: 'Speed reading word' }))
    .toHaveAttribute('data-rsvp-words', '2');
  await reader.locator('.reader-rsvp-rhythm > summary').click();
  await expect(reader.getByRole('spinbutton', { name: 'Sentence rest in milliseconds' }))
    .toHaveValue('250');
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
    buffer: Buffer.from('Alpha beta.', 'utf-8'),
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
  await expect(stage).toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(stage).not.toHaveAttribute('data-rsvp-rest', 'true', { timeout: 3_000 });
  await expect(status).toContainText('End of document', { timeout: 5_000 });
  await expect(reader.getByRole('button', { name: 'completed', exact: true })).toBeDisabled();
  await expect(reader.getByRole('button', { name: 'return to Reader', exact: true })).toBeFocused();
});
