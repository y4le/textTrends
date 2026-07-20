/**
 * Browser timing baseline (plan M6; M6 consult §10) — SERIAL, never
 * retried: a failed timing sample must be a visible failure. Semantic
 * performance gates live in the functional specs (zero re-tokenization on
 * warm, etc.); this project RECORDS defined clocks as artifacts and gates
 * only the one budget the plan states: cancel acknowledgement p95 < 250ms
 * over >= 20 samples. Other thresholds wait for a named baseline —
 * unmeasured numbers must not be frozen as CI policy.
 *
 * Clock definitions (main-thread trace stamps):
 * - coldBarrierMs:   begin-generation post -> cold generation-ready
 * - coldFirstT1Ms:   first ingest post -> first snapshot-published
 * - coldAllReadyMs:  first ingest post -> sixth snapshot-published
 * - warmReopenMs:    begin-generation post -> warm generation-ready
 * - trendQueryMs:    query post -> matching result (median of samples)
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, awaitCacheSettled, DOC_COUNT, events, trace } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test('record cold/warm/query clocks; gate cancel ack p95 < 250ms', async ({ page }, testInfo) => {
  await page.goto('./');
  await awaitAllReady(page);

  const cold = await trace(page);
  const beginAt = events(cold, { direction: 'to-worker', t: 'begin-generation' })[0]!.at;
  const barrierAt = events(cold, { direction: 'from-worker', t: 'generation-ready' })[0]!.at;
  const ingestAt = events(cold, { direction: 'to-worker', t: 'ingest' })[0]!.at;
  const published = events(cold, { direction: 'from-worker', t: 'snapshot-published' });
  const coldBarrierMs = barrierAt - beginAt;
  const coldFirstT1Ms = published[0]!.at - ingestAt;
  const coldAllReadyMs = published[DOC_COUNT - 1]!.at - ingestAt;

  await awaitCacheSettled(page);
  await page.reload();
  await awaitAllReady(page);
  const warm = await trace(page);
  const warmBeginAt = events(warm, { direction: 'to-worker', t: 'begin-generation' })[0]!.at;
  const warmBarrierAt = events(warm, { direction: 'from-worker', t: 'generation-ready' })[0]!.at;
  const warmReopenMs = warmBarrierAt - warmBeginAt;

  // Query latency samples through the real UI (trend + kwic per input).
  const input = page.getByLabel(/terms to compare/i);
  const queryLatencies: number[] = [];
  for (const terms of ['watson', 'moriarty', 'adler', 'lestrade', 'baskerville']) {
    const before = ((await trace(page)).events.at(-1)?.seq ?? -1);
    await input.fill(terms);
    await input.press('Enter');
    await expect
      .poll(async () => (await trace(page)).events.filter((e) => e.seq > before && e.direction === 'from-worker' && e.t === 'result').length)
      .toBeGreaterThan(0);
    const t = await trace(page);
    const post = t.events.find((e) => e.seq > before && e.direction === 'to-worker' && e.t === 'query');
    const result = t.events.find((e) => e.seq > before && e.direction === 'from-worker' && e.t === 'result');
    if (post && result) queryLatencies.push(result.at - post.at);
  }

  // Cancel-ack p95 over >= 20 real acknowledgements (harness page).
  await page.goto('./e2e-harness.html');
  await page.waitForFunction(() => window.__ttHarness?.ready === true);
  const cancels = await page.evaluate(() => window.__ttHarness!.runCancelProbe(20));
  const acks = [...cancels.ackMs].sort((a, b) => a - b);
  const p95 = acks[Math.min(acks.length - 1, Math.ceil(acks.length * 0.95) - 1)]!;

  const record = {
    corpus: { docs: DOC_COUNT, name: 'sherlock-bundled' },
    coldBarrierMs,
    coldFirstT1Ms,
    coldAllReadyMs,
    warmReopenMs,
    queryLatencies,
    cancelAckMs: acks,
    cancelAckP95Ms: p95,
    cancelCompletedInstead: cancels.completedInstead,
    userAgent: await page.evaluate(() => navigator.userAgent),
    headless: true,
    at: new Date().toISOString(),
  };
  await testInfo.attach('browser-timings.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });
  console.log(`[bench] cold barrier ${coldBarrierMs.toFixed(0)}ms · first T1 ${coldFirstT1Ms.toFixed(0)}ms · all ready ${coldAllReadyMs.toFixed(0)}ms · warm reopen ${warmReopenMs.toFixed(0)}ms · cancel p95 ${p95.toFixed(1)}ms (${acks.length} acks)`);

  // The one stated budget (phase1-plan): cancel acknowledgement p95 < 250ms.
  expect(acks.length).toBeGreaterThanOrEqual(20);
  expect(p95).toBeLessThan(250);
});
