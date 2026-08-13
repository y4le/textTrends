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
import { awaitAllReady, awaitCacheSettled, DOC_COUNT, events, trace, clearNotebook, gotoPlace, openQuickAdd } from './helpers.ts';
import type { ProtocolTraceEvent } from '../src/lib/trace.ts';

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
  let warm = await trace(page);
  await expect.poll(async () => {
    warm = await trace(page);
    return events(warm, { direction: 'from-worker', t: 'generation-ready' }).length;
  }).toBeGreaterThan(0);
  const warmBeginAt = events(warm, { direction: 'to-worker', t: 'begin-generation' })[0]!.at;
  const warmBarrierAt = events(warm, { direction: 'from-worker', t: 'generation-ready' })[0]!.at;
  const warmReopenMs = warmBarrierAt - warmBeginAt;

  // Footer passage latency after the intentional one-time hover-entry dwell.
  // The observer distinguishes the retained stale page from the fresh page,
  // while protocol stamps split scheduling, worker, and DOM-settle time on the
  // same main-thread performance clock.
  const footerSlider = page.getByRole('slider', { name: 'Corpus footer position' });
  const footerBox = await footerSlider.boundingBox();
  if (!footerBox) throw new Error('footer slider has no layout box');
  await page.mouse.move(footerBox.x + footerBox.width * 0.12, footerBox.y + 5);
  await expect(page.getByRole('button', { name: /Open reader at .* token/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const footer = document.querySelector('.workbench-footer');
    if (!footer) throw new Error('footer is not mounted');
    const scope = window as unknown as {
      __ttFooterPassageProbe?: { armed: boolean; startedAt: number; settledAt: number | null };
    };
    scope.__ttFooterPassageProbe = { armed: false, startedAt: 0, settledAt: null };
    new MutationObserver(() => {
      const probe = scope.__ttFooterPassageProbe;
      const passage = footer.querySelector('.footer-passage');
      if (
        probe?.armed
        && passage
        && !passage.classList.contains('footer-passage-stale')
        && passage.querySelector('#footer-passage-node')
      ) {
        probe.settledAt = performance.now();
        probe.armed = false;
      }
    }).observe(footer, { attributes: true, childList: true, subtree: true });
  });
  const footerPassageSamples: Array<{
    pointerToQueryMs: number;
    workerMs: number;
    resultToDomMs: number;
    totalMs: number;
  }> = [];
  for (const ratio of [0.31, 0.55, 0.79, 0.43, 0.68]) {
    const beforeSeq = (await trace(page)).events.at(-1)?.seq ?? -1;
    const startedAt = await page.evaluate(() => {
      const probe = (window as unknown as {
        __ttFooterPassageProbe: { armed: boolean; startedAt: number; settledAt: number | null };
      }).__ttFooterPassageProbe;
      probe.startedAt = performance.now();
      probe.settledAt = null;
      probe.armed = true;
      return probe.startedAt;
    });
    await page.mouse.move(footerBox.x + footerBox.width * ratio, footerBox.y + 5);
    await expect.poll(() => page.evaluate(() => (
      window as unknown as { __ttFooterPassageProbe: { settledAt: number | null } }
    ).__ttFooterPassageProbe.settledAt)).not.toBeNull();
    const settledAt = await page.evaluate(() => (
      window as unknown as { __ttFooterPassageProbe: { settledAt: number } }
    ).__ttFooterPassageProbe.settledAt);
    const t = await trace(page);
    const post = t.events.find((event) => event.seq > beforeSeq
      && event.direction === 'to-worker'
      && event.t === 'query'
      && event.op === 'reader-page');
    const result = post
      ? t.events.find((event) => event.seq > beforeSeq
          && event.direction === 'from-worker'
          && event.t === 'result'
          && event.job === post.job)
      : undefined;
    if (!post || !result) throw new Error('footer passage trace did not settle a correlated query');
    footerPassageSamples.push({
      pointerToQueryMs: post.at - startedAt,
      workerMs: result.at - post.at,
      resultToDomMs: settledAt - result.at,
      totalMs: settledAt - startedAt,
    });
  }

  // Query latency samples through the real UI (trend + Concordance window per input).
  const queryLatencies: number[] = [];
  for (const terms of ['watson', 'moriarty', 'adler', 'lestrade', 'baskerville']) {
    // Fresh single-term comparison per sample (append-only notebook): the
    // measured burst must stay one trend + one Concordance window, comparable across runs.
    await clearNotebook(page);
    const before = ((await trace(page)).events.at(-1)?.seq ?? -1);
    const input = await openQuickAdd(page);
    await input.fill(terms);
    await input.press('Enter');
    await page.getByRole('dialog', { name: 'Manage terms' })
      .getByRole('button', { name: 'Done', exact: true }).click();
    // Correlate by JOB id: a late-settling result from a superseded removal
    // burst (clearNotebook does not await) must never be recorded as this
    // term's latency (review-C).
    let post: ProtocolTraceEvent | undefined;
    let result: ProtocolTraceEvent | undefined;
    await expect
      .poll(async () => {
        const t = await trace(page);
        post = t.events.find((e) => e.seq > before && e.direction === 'to-worker' && e.t === 'query' && e.op === 'trend');
        if (!post) return 'no fresh trend query';
        result = t.events.find((e) => e.seq > before && e.direction === 'from-worker' && e.t === 'result' && e.job === post!.job);
        return result ? 'correlated result' : 'awaiting the trend result';
      })
      .toBe('correlated result');
    queryLatencies.push(result!.at - post!.at);
  }

  // Record continuous-Concordance publication and residency shape. These are
  // descriptive clocks until enough baselines exist; bounded DOM remains a
  // semantic gate here and in the large-result functional spec.
  await gotoPlace(page, 'concordance');
  const concordance = page.getByRole('grid', { name: 'Concordance' });
  await expect(concordance).toBeVisible({ timeout: 30_000 });
  const concordanceRows = Number(await concordance.getAttribute('aria-rowcount')) - 1;
  const concordanceMountedRows = await concordance.locator('.kwic-virtual-row').count();
  const concordanceScrollPublishMs: number[] = [];
  const corpusPosition = page.getByRole('slider', { name: 'Corpus footer position' });
  for (const ratio of [0.11, 0.53, 0.89]) {
    const previous = await corpusPosition.getAttribute('aria-valuenow');
    const startedAt = await page.evaluate(() => performance.now());
    await concordance.evaluate((node, targetRatio) => {
      const port = node as HTMLElement;
      port.scrollTop = (port.scrollHeight - port.clientHeight) * targetRatio;
    }, ratio);
    await expect(corpusPosition).not.toHaveAttribute('aria-valuenow', previous ?? '');
    concordanceScrollPublishMs.push(
      await page.evaluate((start) => performance.now() - start, startedAt),
    );
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
    footerPassageSamples,
    queryLatencies,
    concordance: {
      logicalRows: concordanceRows,
      mountedRows: concordanceMountedRows,
      scrollToCursorMs: concordanceScrollPublishMs,
    },
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
  const footerTotals = footerPassageSamples.map((sample) => sample.totalMs).sort((a, b) => a - b);
  const footerMedian = footerTotals[Math.floor(footerTotals.length / 2)]!;
  const medianOf = (field: keyof (typeof footerPassageSamples)[number]) => {
    const values = footerPassageSamples.map((sample) => sample[field]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  };
  console.log(`[bench] cold barrier ${coldBarrierMs.toFixed(0)}ms · first T1 ${coldFirstT1Ms.toFixed(0)}ms · all ready ${coldAllReadyMs.toFixed(0)}ms · warm reopen ${warmReopenMs.toFixed(0)}ms · footer passage ${footerMedian.toFixed(1)}ms median (${medianOf('pointerToQueryMs').toFixed(1)} schedule + ${medianOf('workerMs').toFixed(1)} worker + ${medianOf('resultToDomMs').toFixed(1)} DOM) · cancel p95 ${p95.toFixed(1)}ms (${acks.length} acks)`);

  // Cancellation acknowledgement budget: p95 < 250ms.
  expect(acks.length).toBeGreaterThanOrEqual(20);
  expect(p95).toBeLessThan(250);
  expect(footerPassageSamples.every((sample) => Object.values(sample).every(Number.isFinite)))
    .toBe(true);
  expect(concordanceRows).toBeGreaterThan(0);
  expect(concordanceMountedRows).toBeLessThan(120);
  expect(concordanceScrollPublishMs.every(Number.isFinite)).toBe(true);
});
