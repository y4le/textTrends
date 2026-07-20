/**
 * versionchange-closes-worker-store (M6 consult §8): a same-origin upgrade
 * open from the page's main realm must not stay blocked — the worker-held
 * connection closes, persistence degrades with CACHE_UNAVAILABLE, and
 * resident analysis keeps answering from memory. (A naturally BLOCKED v1
 * open cannot occur while every connection requests the same version; that
 * race stays covered by the injected-opener unit test.)
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, DB_NAME, events, submitAndAwaitFreshResults, trace } from './helpers.ts';

test('a database upgrade elsewhere closes the worker store; queries continue from memory', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  // Raw upgrade open from the app page's main realm — same origin, same
  // BrowserContext, crossing the main/worker IDB connection boundary.
  const upgraded = await page.evaluate(
    ({ dbName }) =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open(dbName, 2);
        const timeout = setTimeout(() => resolve('blocked'), 10_000);
        req.onblocked = () => {
          /* keep waiting: the worker should close its connection */
        };
        req.onupgradeneeded = () => {
          /* stores already exist; nothing to create */
        };
        req.onsuccess = () => {
          clearTimeout(timeout);
          req.result.close();
          resolve('upgraded');
        };
        req.onerror = () => {
          clearTimeout(timeout);
          resolve(`error: ${String(req.error)}`);
        };
      }),
    { dbName: DB_NAME },
  );
  expect(upgraded).toBe('upgraded'); // NOT left blocked

  await expect
    .poll(async () => events(await trace(page), { direction: 'from-worker', t: 'warning', code: 'CACHE_UNAVAILABLE' }).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  // Resident snapshots still answer NEW queries — awaited by the fresh
  // job's own result, after persistence was closed.
  await submitAndAwaitFreshResults(page, 'baskerville');
});
