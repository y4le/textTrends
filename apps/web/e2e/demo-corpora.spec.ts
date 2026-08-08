import { expect, test } from '@playwright/test';
import { ASOIF, LOTR } from '../src/lib/project.ts';
import { awaitAllReady, awaitReadyCount, gotoPlace, trackCorpusRequests } from './helpers.ts';

test('the private built-in picker switches among TXT corpora with useful starter terms', async ({ page }) => {
  const requests = trackCorpusRequests(page);
  await page.goto('./');
  await awaitAllReady(page);
  await gotoPlace(page, 'corpus');

  const picker = page.getByLabel('Demo corpus');
  await expect(picker).toHaveValue('builtin/sherlock');

  const beforeAsoif = requests.length;
  await picker.selectOption('builtin/asoif');
  await awaitReadyCount(page, ASOIF.length);
  await expect(page.getByRole('region', { name: 'Scope' })).toContainText('A Song of Ice and Fire');
  await expect(page.getByRole('button', { name: 'A Game of Thrones', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Jon' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Tyrion' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Daenerys' })).toBeVisible();
  const asoifFiles = requests
    .slice(beforeAsoif)
    .filter((url) => new URL(url).pathname.includes('/corpora/asoif/'))
    .map((url) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!))
    .sort();
  expect(asoifFiles).toEqual(ASOIF.map(({ doc }) => `${doc}.txt`).sort());

  const beforeLotr = requests.length;
  await picker.selectOption('builtin/lotr');
  await awaitReadyCount(page, LOTR.length);
  await expect(page.getByRole('region', { name: 'Scope' })).toContainText('The Lord of the Rings');
  await expect(page.getByRole('button', { name: 'The Fellowship of the Ring', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Frodo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Gandalf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit members: Sauron' })).toBeVisible();
  const lotrFiles = requests
    .slice(beforeLotr)
    .filter((url) => new URL(url).pathname.includes('/corpora/lotr/'))
    .map((url) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!))
    .sort();
  expect(lotrFiles).toEqual(LOTR.map(({ doc }) => `${doc}.txt`).sort());
});
