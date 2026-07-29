/**
 * reader-page/1 dense-page benchmark (slice-2 ruling §G): a mid-document
 * page over a term with tens of thousands of occurrences — the mark-slicing
 * path (binary search + bounded straddler walk) must stay flat no matter
 * how dense the document is. NON-GATING; recorded to the retained benchmark
 * artifact surface (testInfo.attach), median of 7 after 2 warmups. Runs the
 * REAL engine node-side (it is environment-agnostic), so a checkpoint
 * removal or a pathological slice regression is observable here.
 */

import { expect, test } from '@playwright/test';
import { begin, coldIngest, harness } from '../test/support/engine-harness.ts';
import { buildDocSpec } from '../test/support/spec-fixtures.ts';

const FOLDED = { case: 'folded', diacritics: 'folded' } as const;
const group = { id: 'g1', members: [{ id: 'm1', kind: 'token' as const, surface: 'wolf', match: FOLDED }], countOverlaps: false };

test('record dense reader-page medians over a 60k-occurrence document (non-gating)', async ({}, testInfo) => {
  const n = 60_000;
  const text = 'wolf '.repeat(n).trim();
  const h = harness();
  const spec = await buildDocSpec('a', text);
  await begin(h, [spec]);
  await coldIngest(h, 'g', 'a', text, 10);
  const snap = h.last('snapshot-published').snapshot;

  const query = {
    op: 'reader-page',
    tracks: [{ seriesId: 's1', group }],
    request: { method: 'reader-page/1', doc: 'a', cursor: { kind: 'around', token: n >> 1 }, maxTokens: 400 },
  };
  const run = async (job: number, cursor = query.request.cursor) => {
    const t0 = process.hrtime.bigint();
    await h.send({
      t: 'query',
      job,
      snapshot: snap,
      query: { ...query, request: { ...query.request, cursor } } as never,
    });
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (let i = 0; i < 2; i++) await run(100 + i); // warm the occurrence cache
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) samples.push(await run(200 + i));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  // Exercise the stateless canonical walk at maximum depth as a separate,
  // non-gating regression sample.
  const deepPageMs = await run(300, { kind: 'before', token: n });

  const res = h.last('result');
  if (res.data.op !== 'reader-page') throw new Error('expected reader-page');
  const record = {
    method: 'reader-page/1',
    docOccurrences: n,
    pageTokens: res.data.page.tokens.end - res.data.page.tokens.start,
    pageMarks: res.data.page.marks.length,
    samples: { warmups: 2, runs: 7, statistic: 'median' },
    densePageMs: median,
    deepPageMs,
    at: new Date().toISOString(),
  };
  await testInfo.attach('reader-bench.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });
  console.log(`[bench] reader dense page ${median.toFixed(2)}ms · ${record.pageTokens} tokens · ${record.pageMarks} marks`);
  expect(Number.isFinite(median) && Number.isFinite(deepPageMs)).toBe(true); // non-gating
});
