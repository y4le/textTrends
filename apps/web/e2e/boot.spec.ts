/**
 * Cold boot under the deployed base path (plan M6 bullet 1; corrected cold
 * expectations per the M6 consult §3): the module worker starts as a
 * same-origin asset under /textTrends/, the cold barrier names all six
 * docs missing BEFORE any fetch, ingest bytes genuinely transfer, each
 * document follows its per-doc phase order, and snapshots grow
 * monotonically in declared order. UI completion is asserted through
 * accessible semantics.
 */

import { expect, test } from '@playwright/test';
import { awaitAllReady, DOC_COUNT, events, SHERLOCK, trace, trackCorpusRequests } from './helpers.ts';

test('cold boot: worker under base path, barrier-then-fetch, transfer, per-doc order, monotone snapshots', async ({ page, baseURL }) => {
  const corpusRequests = trackCorpusRequests(page);
  await page.goto('./');
  await awaitAllReady(page);

  // The module worker is a same-origin asset under the deployed base.
  const workers = page.workers();
  expect(workers.length).toBe(1);
  expect(workers[0]!.url()).toContain(new URL(baseURL!).pathname);
  expect(new URL(workers[0]!.url()).origin).toBe(new URL(baseURL!).origin);

  const t = await trace(page);
  expect(t.dropped).toBe(0);

  // Protocol v4 cold shape: ONE begin-generation, then ONE generation-ready
  // naming all six docs missing, BEFORE the first ingest post. No second
  // all-ready barrier follows cold ingest.
  const begins = events(t, { direction: 'to-worker', t: 'begin-generation' });
  expect(begins.length).toBe(1);
  const barriers = events(t, { direction: 'from-worker', t: 'generation-ready' });
  expect(barriers.length).toBe(1);
  expect(barriers[0]!.missingCount).toBe(DOC_COUNT);
  const ingests = events(t, { direction: 'to-worker', t: 'ingest' });
  expect(ingests.length).toBe(DOC_COUNT);
  expect(barriers[0]!.seq).toBeLessThan(ingests[0]!.seq);

  // Exactly the six manifest corpus files were fetched, after the barrier.
  expect(corpusRequests.length).toBe(DOC_COUNT);

  // Ingest bytes genuinely TRANSFER: detachment is synchronous, so the
  // byteLength observed immediately after postMessage is zero. The session
  // resolves barrier misses CONCURRENTLY, so ingests arrive in fetch-completion
  // order, not declared order — assert the SET by document (each manifest doc
  // ingested exactly once with its exact bytes) rather than a positional order.
  const ingestByDoc = new Map(ingests.map((e) => [e.doc, e]));
  expect(ingestByDoc.size).toBe(DOC_COUNT);
  for (const { doc, bytes } of SHERLOCK) {
    const ingest = ingestByDoc.get(doc);
    expect(ingest, doc).toBeDefined();
    expect(ingest!.transferBytesBefore, doc).toBe(bytes);
    expect(ingest!.transferBytesAfter, doc).toBe(0);
  }

  // Per-document phase order (no single global order — engines interleave):
  // the honest v4 pipeline is decode -> extract -> segment -> index ->
  // structure -> compose, with exactly one source-ready per cold-ingested doc
  // (emitted after a complete, verified extraction, before publication).
  for (const { doc } of SHERLOCK) {
    const phases = events(t, { direction: 'from-worker', t: 'progress', doc }).map((e) => e.phase);
    expect(phases, doc).toEqual(['decode', 'extract', 'segment', 'index', 'structure', 'compose']);
    const sourceReady = events(t, { direction: 'from-worker', t: 'source-ready', doc });
    expect(sourceReady.length, doc).toBe(1);
  }

  // Snapshot ready sets grow monotonically to six.
  const published = events(t, { direction: 'from-worker', t: 'snapshot-published' });
  expect(published.length).toBe(DOC_COUNT);
  const counts = published.map((e) => e.readyCount!);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
  expect(counts.at(-1)).toBe(DOC_COUNT);

  // UI completion through accessible semantics: the trend surface, the
  // exact-totals table with both default series, and concordance rows.
  await expect(page.locator('svg').first()).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
  await expect(page.getByText(/Holmes/i).first()).toBeVisible();
});
