import { expect, test, type Page } from '@playwright/test';
import { awaitAllReady, gotoPlace, trace } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

type Timing = { start: number | null; mutation: number | null; dom: number | null; visible: number | null };

async function measure(page: Page, place: 'trends' | 'vocabulary' | 'compare') {
  const before = await trace(page);
  expect(before.dropped).toBe(0);
  const lastSeq = before.events.at(-1)?.seq ?? -1;
  await page.evaluate((place) => {
    performance.clearMarks(`tt:render:${place}`);
    const probe: Timing = { start: null, mutation: null, dom: null, visible: null };
    (window as unknown as { __ttPlaceProbe: Timing }).__ttPlaceProbe = probe;
    const selector = place === 'trends' ? '[data-series-path]' : place === 'vocabulary'
      ? '.frequency-table [data-frequency-row]'
      : '.compare-table-port[aria-busy="false"] .compare-axis-table';
    let frame = 0;
    const check = () => {
      if (probe.start === null) return;
      probe.mutation ??= performance.now();
      const element = document.querySelector(selector);
      if (!element) return;
      probe.dom ??= performance.now();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (element.getClientRects().length === 0) return;
        probe.visible = performance.now();
        observer.disconnect();
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.querySelector('.place-region')!, { subtree: true, childList: true, attributes: true });
    document.addEventListener('click', () => { probe.start = performance.now(); }, { once: true, capture: true });
  }, place);
  await gotoPlace(page, place);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __ttPlaceProbe: Timing }).__ttPlaceProbe.visible)).not.toBeNull();
  const timing = await page.evaluate((place) => {
    const p = (window as unknown as { __ttPlaceProbe: Timing }).__ttPlaceProbe;
    const start = p.start!;
    const module = performance.getEntriesByName(`tt:module:${place}`)[0]!.startTime;
    const renders = performance.getEntriesByName(`tt:render:${place}`).map((entry) => entry.startTime - start);
    return {
      moduleMs: module - start,
      renderMs: renders,
      firstMutationMs: p.mutation! - start,
      domMs: p.dom! - start,
      visibleMs: p.visible! - start,
      resources: (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter((entry) => entry.startTime >= start && entry.name.endsWith('.js'))
        .map((entry) => ({ name: new URL(entry.name).pathname.split('/').at(-1), startMs: entry.startTime - start, endMs: entry.responseEnd - start })),
    };
  }, place);
  const after = await trace(page);
  expect(after.dropped).toBe(0);
  expect(after.events.filter((event) => event.seq > lastSeq && event.direction === 'to-worker' && event.t === 'query')).toEqual([]);
  return timing;
}

for (let repetition = 1; repetition <= 5; repetition++) {
  test(`cold place breakdown ${repetition}/5`, async ({ page }, testInfo) => {
    await page.goto('./?fresh=1');
    await page.getByRole('button', { name: 'Try the Sherlock Holmes sample', exact: true }).click();
    await awaitAllReady(page);
    // Require a quiet protocol window; no tab result may hide pending analysis.
    await expect.poll(async () => {
      const snapshot = await trace(page);
      const queries = snapshot.events.filter((e) => e.direction === 'to-worker' && e.t === 'query');
      return queries.every((q) => snapshot.events.some((e) => e.seq > q.seq && e.job === q.job && (
        e.direction === 'to-worker' && e.t === 'cancel'
        || e.direction === 'from-worker' && ['result', 'error', 'cancelled'].includes(e.t)
      )));
    }).toBe(true);
    const coldTrends = await measure(page, 'trends');
    const coldVocabulary = await measure(page, 'vocabulary');
    const coldCompare = await measure(page, 'compare');
    const warmTrends = await measure(page, 'trends');
    const warmVocabulary = await measure(page, 'vocabulary');
    const warmCompare = await measure(page, 'compare');
    const result = { repetition, browser: page.context().browser()!.version(), coldTrends, coldVocabulary, coldCompare, warmTrends, warmVocabulary, warmCompare };
    await testInfo.attach('cold-place.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(`COLD_PLACE ${JSON.stringify(result)}`);
  });
}
