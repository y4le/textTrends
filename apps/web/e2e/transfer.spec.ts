/**
 * Worker-to-main typed-result transfer (plan M6 bullet; M6 consult §4):
 * wrap the REAL worker's postMessage from the worker execution context,
 * issue a fresh trend query, and prove (a) a non-empty transfer list was
 * posted, (b) its buffers were DETACHED by the browser after the post,
 * and (c) repeated queries still answer — canonical shard storage intact.
 * Main-to-worker ingest transfer is proven in boot.spec via trace stamps.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, gotoPlace, submitAndAwaitFreshResults, trace } from './helpers.ts';

test('trend results transfer their buffers; the resident index survives', async ({ page }) => {
  await page.goto('./');
  await awaitAllReady(page);

  const worker = page.workers()[0]!;
  await worker.evaluate(() => {
    const scope = self as unknown as {
      postMessage(m: unknown, t?: Transferable[]): void;
      __ttTransferDiag: { listLength: number; before: number[]; after: number[] }[];
    };
    scope.__ttTransferDiag = [];
    const original = scope.postMessage.bind(scope);
    scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
      const m = message as { t?: string; data?: { op?: string } };
      const isTrend = m?.t === 'result' && m?.data?.op === 'trend';
      const buffers = isTrend && Array.isArray(transfer) ? (transfer as ArrayBuffer[]) : null;
      const before = buffers ? buffers.map((b) => b.byteLength) : [];
      original(message, transfer);
      if (buffers) {
        scope.__ttTransferDiag.push({
          listLength: buffers.length,
          before,
          after: buffers.map((b) => b.byteLength), // detached => 0
        });
      }
    };
  });

  // A fresh query through the real UI — awaited by ITS OWN job's result,
  // never satisfied by anything that settled earlier.
  await submitAndAwaitFreshResults(page, 'watson, mycroft');

  const diag = await worker.evaluate(
    () => (self as unknown as { __ttTransferDiag: { listLength: number; before: number[]; after: number[] }[] }).__ttTransferDiag,
  );
  expect(diag.length).toBeGreaterThan(0);
  for (const entry of diag) {
    expect(entry.listLength).toBeGreaterThan(0);
    for (const b of entry.before) expect(b).toBeGreaterThan(0);
    for (const a of entry.after) expect(a).toBe(0); // REAL browser detachment
  }

  // Query AGAIN after the detachment above settled: EVERY fresh job (trend
  // per series + KWIC) must deliver, and the claim is DATA-LEVEL — a
  // detached resident postings array could still yield an empty-but-
  // successful result, so the exact-totals corpus row must show Watson's
  // exact corpus total (551 token matches under the checked-in corpus and
  // default recipe).
  const markBeforeRequery = (await trace(page)).events.at(-1)!.seq;
  await submitAndAwaitFreshResults(page, 'watson');
  // The Watson COUNT cell specifically (cell 0 is the row header's sibling
  // token denominator, which is itself multi-digit and must not satisfy
  // this assertion — review round 3): exact known value for the bundled
  // corpus under the default recipe, computed via the same fold semantics.
  await gotoPlace(page, 'inputs');
  const corpusRow = page.getByRole('row', { name: /^corpus/ });
  await expect(corpusRow).toBeVisible();
  await expect(corpusRow.getByRole('cell').nth(1).locator('.selectable-stat')).toHaveText(/^551 ·/);
  const t = await trace(page);
  // SNAPSHOT_UNKNOWN is the DESIGNED supersede signal for queries racing
  // progressive snapshot publication (the store reissues); any OTHER error
  // after buffer transfer would indicate a damaged resident index.
  const errors = t.events.filter(
    (e) => e.seq > markBeforeRequery && e.direction === 'from-worker' && e.t === 'error' && e.code !== 'SNAPSHOT_UNKNOWN',
  );
  expect(errors).toEqual([]);
});
