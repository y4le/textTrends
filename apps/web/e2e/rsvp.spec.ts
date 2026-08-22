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
  const faster = reader.getByRole('button', { name: /^Faster,/ });
  const firstControl = reader.getByRole('button', { name: 'shortcuts', exact: true });
  await firstControl.focus();
  await firstControl.press('Shift+Tab');
  await expect(faster).toBeFocused();
  await faster.press('Tab');
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
  await expect(status).toContainText('End of document', { timeout: 5_000 });
  await expect(reader.getByRole('button', { name: 'completed', exact: true })).toBeDisabled();
  await expect(reader.getByRole('button', { name: 'return to Reader', exact: true })).toBeFocused();
});
