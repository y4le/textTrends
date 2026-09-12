import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';
import type { TraceSnapshot } from '../src/lib/trace.ts';

test.describe.configure({ mode: 'serial' });

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length === 0
    ? null : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1
    ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { n: sorted.length, min: at(0), median, p95: at(0.95), max: at(1) };
}

function summarize(snapshot: TraceSnapshot) {
  expect(snapshot.dropped, 'trace overflow invalidates query counts').toBe(0);
  const queries = snapshot.events.filter((event) => event.direction === 'to-worker' && event.t === 'query');
  return Object.fromEntries([...new Set(queries.map((event) => event.op!))].sort().map((op) => {
    const matching = queries.filter((event) => event.op === op);
    const latency: number[] = [];
    let cancelled = 0;
    let errors = 0;
    for (const query of matching) {
      const cancel = snapshot.events.find((event) => event.seq > query.seq && event.job === query.job && event.direction === 'to-worker' && event.t === 'cancel');
      const terminal = snapshot.events.find((event) => event.seq > query.seq && event.job === query.job && event.direction === 'from-worker' && ['result', 'error', 'cancelled'].includes(event.t));
      if ((cancel && (!terminal || cancel.at <= terminal.at)) || terminal?.t === 'cancelled') cancelled++;
      else if (terminal?.t === 'error') errors++;
      else if (terminal?.t === 'result') latency.push(terminal.at - query.at);
      else throw new Error(`unsettled ${op} job ${query.job}`);
    }
    return [op, { issued: matching.length, cancelled, errors, postToResultMs: distribution(latency) }];
  }));
}

async function settledTrace(page: Page) {
  let previousSeq = -1;
  await expect.poll(async () => {
    const snapshot = await trace(page);
    expect(snapshot.dropped).toBe(0);
    const unresolved = snapshot.events.filter((event) => event.direction === 'to-worker' && event.t === 'query').some((query) => !snapshot.events.some((event) => event.seq > query.seq && event.job === query.job && (
      event.direction === 'to-worker' && event.t === 'cancel'
      || event.direction === 'from-worker' && ['result', 'error', 'cancelled'].includes(event.t)
    )));
    const lastSeq = snapshot.events.at(-1)?.seq ?? -1;
    const stable = lastSeq === previousSeq;
    previousSeq = lastSeq;
    return !unresolved && stable;
  }, { timeout: 60_000, intervals: [100] }).toBe(true);
  return trace(page);
}

async function clearTrace(page: Page) {
  await page.evaluate(() => (window as unknown as { __ttE2E: { clearTrace(): void } }).__ttE2E.clearTrace());
}

async function renderClock(page: Page, selector: string, action: () => Promise<void>) {
  await page.evaluate((selector) => {
    const probe = { start: null as number | null, end: null as number | null };
    (window as unknown as { __ttRenderProbe: typeof probe }).__ttRenderProbe = probe;
    let frame = 0;
    const cleanup = () => {
      observer.disconnect();
      document.removeEventListener('click', start, true);
      document.removeEventListener('keydown', start, true);
      cancelAnimationFrame(frame);
    };
    const check = () => {
      if (probe.start === null || probe.end !== null || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const element = document.querySelector(selector);
        if (!element || element.getClientRects().length === 0) return;
        probe.end = performance.now();
        cleanup();
      });
    };
    const start = () => {
      if (probe.start !== null) return;
      probe.start = performance.now();
      check();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    document.addEventListener('click', start, true);
    document.addEventListener('keydown', start, true);
  }, selector);
  await action();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ttRenderProbe: { end: number | null } }).__ttRenderProbe.end), { timeout: 60_000 }).not.toBeNull();
  return page.evaluate(() => {
    const probe = (window as unknown as { __ttRenderProbe: { start: number; end: number } }).__ttRenderProbe;
    return probe.end - probe.start;
  });
}

async function tabClocks(page: Page) {
  const vocabularyMs = await renderClock(page, '.frequency-table [data-frequency-row]', () => gotoPlace(page, 'vocabulary'));
  const compareMs = await renderClock(page, '.compare-table-port[aria-busy="false"] .compare-axis-table', () => gotoPlace(page, 'compare'));
  return { vocabularyMs, compareMs };
}

const samples: Array<{ importFirstTrendMs: number; importTabs: Awaited<ReturnType<typeof tabClocks>>; rangeFirstTrendMs: number; rangeTabs: Awaited<ReturnType<typeof tabClocks>> }> = [];
for (let repetition = 1; repetition <= 5; repetition++) {
  test(`record eager hidden work and visible-result clocks ${repetition}/5`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto('./?fresh=1');
    const sample = page.getByRole('button', { name: 'Try the Sherlock Holmes sample', exact: true });
    await expect(sample).toBeVisible();
    await clearTrace(page);
    const importFirstTrendMs = await renderClock(page, '[data-series-path]', async () => {
      await sample.click();
      await gotoPlace(page, 'trends');
    });
    await awaitAllReady(page);
    const importTrace = await settledTrace(page);
    const importQueries = summarize(importTrace);
    expect(importQueries['freq-list']!.issued).toBeGreaterThan(0);
    expect(importQueries.keyness!.issued).toBeGreaterThan(0);
    const importTabs = await tabClocks(page);

    // Prime selection/rest mode without including that setup in the range window.
    await gotoPlace(page, 'trends');
    const slider = page.getByRole('slider', { name: 'Reading position scrubber' });
    await slider.focus();
    await slider.press('Home');
    await slider.press('s');
    await slider.press('ArrowRight');
    await slider.press('Enter');
    await gotoPlace(page, 'compare');
    await page.getByLabel('Left comparison input').selectOption('__selection__');
    await gotoPlace(page, 'trends');
    await page.getByRole('button', { name: 'Clear range', exact: true }).click();
    await slider.focus();
    await slider.press('Home');
    await slider.press('s');
    for (let step = 0; step < 30; step++) await slider.press('ArrowRight');
    await settledTrace(page);
    await expect(page.locator('[data-selected-overlay]')).toHaveCount(0);
    await clearTrace(page);
    const rangeFirstTrendMs = await renderClock(page, '[data-selected-overlay]', () => slider.press('Enter'));
    const rangeTrace = await settledTrace(page);
    const rangeQueries = summarize(rangeTrace);
    expect(rangeQueries['freq-list']!.issued).toBe(1);
    expect(rangeQueries.keyness!.issued).toBe(2);
    const rangeTabs = await tabClocks(page);
    const clocks = { importFirstTrendMs, importTabs, rangeFirstTrendMs, rangeTabs };
    samples.push(clocks);
    const result = { repetition, browser: testInfo.project.name, clocks, importQueries, rangeQueries, importTrace, rangeTrace };
    await testInfo.attach('hidden-queries.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(`HIDDEN_QUERIES ${JSON.stringify({ repetition, ...clocks, importQueries, rangeQueries })}`);
  });
}

test.afterAll(async () => {
  if (samples.length !== 5) return;
  console.log(`HIDDEN_QUERY_CLOCKS ${JSON.stringify({
    importFirstTrendMs: distribution(samples.map((s) => s.importFirstTrendMs)),
    importVocabularyMs: distribution(samples.map((s) => s.importTabs.vocabularyMs)),
    importCompareMs: distribution(samples.map((s) => s.importTabs.compareMs)),
    rangeFirstTrendMs: distribution(samples.map((s) => s.rangeFirstTrendMs)),
    rangeVocabularyMs: distribution(samples.map((s) => s.rangeTabs.vocabularyMs)),
    rangeCompareMs: distribution(samples.map((s) => s.rangeTabs.compareMs)),
  })}`);
});
