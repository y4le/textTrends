import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceV1 } from '@texttrends/core';
import { awaitReadyCount, gotoPlace, openQuickAdd, workspaceRecord } from './helpers.ts';
import { readBackup, writeBackup, BACKUP_SCHEMA } from '../src/lib/workspace-backup.ts';
import { captureBackupPreferences } from '../src/lib/workspace-backup-preferences.ts';
import { emptyLibraryWorkspace } from '../src/lib/workspace-state.ts';

function authored(workspace: WorkspaceV1) {
  return { ...workspace, corpus: { ...workspace.corpus, docs: workspace.corpus.docs.map(({ warm: _warm, ...doc }) => doc) } };
}

async function download(page: Page, path: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save workspace file', exact: true }).click();
  const file = await event;
  expect(file.suggestedFilename()).toMatch(/\.ttws$/);
  await file.saveAs(path);
  await expect(page.getByRole('dialog', { name: 'Save workspace file', exact: true })).toHaveCount(0);
}

test('a downloaded workspace recreates sources, terms, order, comparisons, and settings in a fresh browser', async ({ page, browser }, testInfo) => {
  await page.goto('./?p=inputs');
  await page.getByLabel('Add files — import and analyze').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('Alpha alpha beta.\r\n'.repeat(100)) },
    { name: 'beta.html', mimeType: 'text/html', buffer: Buffer.from(`<html><body><p>${'Beta beta alpha. '.repeat(100)}</p></body></html>`) },
  ]);
  await awaitReadyCount(page, 2);
  await page.getByRole('button', { name: 'Move beta up', exact: true }).click();
  await page.getByRole('region', { name: 'Add texts' }).getByRole('button', { name: 'Show options' }).click();
  await page.getByLabel('Save files to library').setInputFiles({ name: 'later.md', mimeType: 'text/markdown', buffer: Buffer.from('# Read later\nAn inactive saved text.') });
  await expect(page.getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(3);

  await gotoPlace(page, 'trends');
  for (const name of ['alpha', 'beta']) {
    const term = await openQuickAdd(page);
    await term.fill(name);
    await term.press('Enter');
  }
  await expect(page.locator('.term-bucket-toggle')).toHaveCount(2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
  await settings.getByLabel('Size and spacing').fill('0');
  await settings.getByLabel('Bins per text', { exact: true }).fill('32');
  await settings.getByRole('combobox', { name: 'Measure', exact: true }).selectOption('count');
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await gotoPlace(page, 'compare');
  await page.getByLabel('Left comparison input', { exact: true }).selectOption({ label: 'beta' });
  await page.getByLabel('Right comparison input', { exact: true }).selectOption({ label: 'alpha' });
  await gotoPlace(page, 'inputs');
  const path = testInfo.outputPath('workspace.ttws');
  await download(page, path);
  const backup = await readBackup(new Blob([await readFile(path)]));
  expect(backup.manifest.sources).toHaveLength(3);
  expect(backup.manifest.workspace.notebook.groups).toHaveLength(2);

  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const restored = await fresh.newPage();
    await restored.goto(new URL('?p=inputs', page.url()).href);
    await expect(restored.getByRole('button', { name: 'Load workspace file', exact: true })).toBeEnabled();
    await restored.getByLabel('Choose workspace file').setInputFiles(path);
    const pane = restored.getByRole('dialog', { name: 'Load workspace file', exact: true });
    await expect(pane).toContainText('3 saved texts, 2 active texts, and 2 terms');
    await expect(pane.getByRole('button', { name: 'Replace workspace and load' })).toBeVisible();
    expect(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await pane.getByRole('button', { name: 'Replace workspace and load' }).click();
    await awaitReadyCount(restored, 2);
    await expect(restored.getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(3);
    await expect(restored.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(restored.locator('html')).toHaveAttribute('data-density', 'compact');
    await expect.poll(async () => authored(await workspaceRecord(restored) as WorkspaceV1)).toEqual(backup.manifest.workspace);
    await gotoPlace(restored, 'compare');
    await expect(restored.getByLabel('Left comparison input', { exact: true })).toHaveValue(backup.manifest.workspace.views.compare.documentA!);
    await expect(restored.getByLabel('Right comparison input', { exact: true })).toHaveValue(backup.manifest.workspace.views.compare.documentB!);
    await gotoPlace(restored, 'trends');
    await expect(restored.locator('.term-bucket-toggle')).toHaveCount(2);
    await restored.reload();
    await awaitReadyCount(restored, 2);
    await expect.poll(async () => authored(await workspaceRecord(restored) as WorkspaceV1)).toEqual(backup.manifest.workspace);
  } finally { await fresh.close(); }
});

test('cancel and invalid files preserve the current workspace; confirmed replacement fences an older tab', async ({ page, context }, testInfo) => {
  await page.goto('./?p=inputs');
  await page.getByLabel('Add files — import and analyze').setInputFiles({ name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('original original text') });
  await awaitReadyCount(page, 1);
  const path = testInfo.outputPath('original.ttws');
  await download(page, path);
  const before = (await readBackup(new Blob([await readFile(path)]))).manifest.workspace;
  await page.getByLabel('Choose workspace file').setInputFiles(path);
  const pane = page.getByRole('dialog', { name: 'Load workspace file', exact: true });
  await expect(pane.getByRole('button', { name: 'Replace workspace and load' })).toBeVisible();
  await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(pane).toHaveCount(0);
  await expect.poll(async () => authored(await workspaceRecord(page) as WorkspaceV1)).toEqual(before);
  await page.getByLabel('Choose workspace file').setInputFiles({ name: 'broken.ttws', mimeType: 'application/zip', buffer: Buffer.from('not a workspace') });
  await expect(pane.getByRole('alert')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Replace workspace and load' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => authored(await workspaceRecord(page) as WorkspaceV1)).toEqual(before);

  const old = await context.newPage();
  await old.goto(page.url());
  await awaitReadyCount(old, 1);
  const empty = await writeBackup({ schema: BACKUP_SCHEMA, createdAt: 0, workspace: emptyLibraryWorkspace(), sources: [], settings: captureBackupPreferences({ local: null, session: null }) }, async () => { throw new Error('no sources'); });
  await page.getByLabel('Choose workspace file').setInputFiles({ name: 'empty.ttws', mimeType: 'application/zip', buffer: Buffer.from(await empty.arrayBuffer()) });
  await pane.getByRole('button', { name: 'Replace workspace and load' }).click();
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(1);
  await gotoPlace(old, 'trends');
  const term = await openQuickAdd(old);
  await term.fill('original');
  await term.press('Enter');
  await expect(old.getByText(/This workspace was replaced in another tab/)).toBeVisible();
  expect(await workspaceRecord(page)).toEqual(emptyLibraryWorkspace());
  await old.close();
});

for (const blocked of [false, true]) test(`a committed restore recovers after reload with settings storage ${blocked ? 'still blocked' : 'available'}`, async ({ page }) => {
  await page.goto('./?p=inputs');
  await page.getByLabel('Add files — import and analyze').setInputFiles({ name: 'previous.txt', mimeType: 'text/plain', buffer: Buffer.from('previous text') });
  await awaitReadyCount(page, 1);
  const backup = await writeBackup({
    schema: BACKUP_SCHEMA, createdAt: 0, workspace: emptyLibraryWorkspace(), sources: [],
    settings: { ...captureBackupPreferences({ local: null, session: null }), display: { density: 'compact', theme: 'dark' } },
  }, async () => { throw new Error('no sources'); });
  await page.getByLabel('Choose workspace file').setInputFiles({ name: 'settings.ttws', mimeType: 'application/zip', buffer: Buffer.from(await backup.arrayBuffer()) });
  const pane = page.getByRole('dialog', { name: 'Load workspace file', exact: true });
  await expect(pane.getByRole('button', { name: 'Replace workspace and load' })).toBeVisible();
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === 'texttrends/matches-columns/3') throw new DOMException('Settings storage unavailable', 'QuotaExceededError');
      remove.call(this, key);
    };
  });
  await pane.getByRole('button', { name: 'Replace workspace and load' }).click();
  await expect(pane.getByRole('alert')).toContainText('workspace was saved, but reopening did not finish');
  await expect(pane.getByRole('button', { name: 'close', exact: true })).toBeDisabled();
  expect(await workspaceRecord(page)).toEqual(emptyLibraryWorkspace());
  if (blocked) await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Settings storage is blocked', 'SecurityError'); } });
  });
  await pane.getByRole('button', { name: 'Reload to finish' }).click();
  await expect(page.getByRole('button', { name: 'Load workspace file', exact: true })).toBeEnabled();
  if (blocked) {
    await expect(page.getByText(/Your texts and terms were loaded.*settings are still pending/)).toBeVisible();
  } else {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  }
  await expect(page.getByText('No active inputs. Nothing is being analyzed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Saved texts' }).getByRole('listitem')).toHaveCount(1);
});
