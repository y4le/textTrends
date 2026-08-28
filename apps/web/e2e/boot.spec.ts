/**
 * Cold boot under the deployed base path (plan M6 bullet 1; corrected cold
 * expectations per the M6 consult §3): the module worker starts as a
 * same-origin asset under /textTrends/, the cold barrier names every Sherlock
 * docs missing BEFORE any fetch, ingest bytes genuinely transfer, each
 * document follows its per-doc phase order, and snapshots grow
 * monotonically in declared order. UI completion is asserted through
 * accessible semantics.
 */

import { expect, test } from '@playwright/test';
import { LOCAL_LIBRARY_DB_NAME } from '../src/lib/local-library.ts';
import { awaitAllReady, DOC_COUNT, events, gotoPlace, SHERLOCK, trace, trackCorpusRequests } from './helpers.ts';

test('cold boot: worker under base path, barrier-then-fetch, transfer, per-doc order, monotone snapshots', async ({ page, baseURL }) => {
  const corpusRequests = trackCorpusRequests(page);
  await page.goto('./');
  await awaitAllReady(page, { loadDemo: true });

  // The module worker is a same-origin asset under the deployed base.
  const workers = page.workers();
  expect(workers.length).toBe(1);
  expect(workers[0]!.url()).toContain(new URL(baseURL!).pathname);
  expect(new URL(workers[0]!.url()).origin).toBe(new URL(baseURL!).origin);

  const t = await trace(page);
  expect(t.dropped).toBe(0);

  // A fresh local workspace first opens one terminal empty generation. Loading
  // the demo then opens a normal full-Sherlock library generation.
  const begins = events(t, { direction: 'to-worker', t: 'begin-generation' });
  expect(begins.length).toBe(2);
  const barriers = events(t, { direction: 'from-worker', t: 'generation-ready' });
  expect(barriers.length).toBe(2);
  expect(barriers[0]!.missingCount).toBe(0);
  expect(barriers[0]!.readyCount).toBe(0);
  expect(barriers[1]!.missingCount).toBe(DOC_COUNT);
  const ingests = events(t, { direction: 'to-worker', t: 'ingest' });
  expect(ingests.length).toBe(DOC_COUNT);
  expect(barriers[1]!.seq).toBeLessThan(ingests[0]!.seq);

  // Exactly the manifest corpus files were fetched and integrity-checked
  // before activation. Their static paths remain transport details.
  expect(corpusRequests.length).toBe(DOC_COUNT);
  const requestedFiles = corpusRequests.map((u) => new URL(u).pathname.split('/').at(-1)).sort();
  expect(requestedFiles).toEqual(SHERLOCK.map(({ doc }) => `${encodeURIComponent(doc)}.txt`).sort());

  // Ingest bytes genuinely TRANSFER: detachment is synchronous, so the
  // byteLength observed immediately after postMessage is zero. The session
  // resolves barrier misses CONCURRENTLY, so ingests arrive in fetch-completion
  // order, not declared order — assert the SET by document (each manifest doc
  // ingested exactly once with its exact bytes) rather than a positional order.
  expect(new Set(ingests.map((event) => event.doc)).size).toBe(DOC_COUNT);
  const readDocumentIds = () => page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const workspace = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const docs = (workspace as { corpus?: { docs?: readonly { doc: string; meta: { title: string } }[] } } | undefined)?.corpus?.docs ?? [];
      return docs.map((document) => [document.meta.title, document.doc] as const);
    } finally {
      database.close();
    }
  }, LOCAL_LIBRARY_DB_NAME);
  await expect.poll(async () => (await readDocumentIds()).length).toBe(DOC_COUNT);
  const documentIds = new Map(await readDocumentIds());
  const ingestByDoc = new Map(ingests.map((event) => [event.doc, event]));
  for (const fixture of SHERLOCK) {
    const doc = documentIds.get(fixture.title);
    expect(doc, fixture.title).toBeDefined();
    expect(ingestByDoc.get(doc)?.transferBytesBefore, fixture.title).toBe(fixture.bytes);
    expect(ingestByDoc.get(doc)?.transferBytesAfter, fixture.title).toBe(0);
  }

  // Per-document phase order (no single global order — engines interleave):
  // the honest v4 pipeline is decode -> extract -> segment -> index ->
  // compose, with exactly one source-ready per cold-ingested doc
  // (emitted after a complete, verified extraction, before publication).
  for (const { doc } of ingests) {
    if (doc === undefined) throw new Error('an ingest trace event must name its document');
    const phases = events(t, { direction: 'from-worker', t: 'progress', doc }).map((e) => e.phase);
    expect(phases, doc).toEqual(['decode', 'extract', 'segment', 'index', 'compose']);
    const sourceReady = events(t, { direction: 'from-worker', t: 'source-ready', doc });
    expect(sourceReady.length, doc).toBe(1);
  }

  // Snapshot ready sets grow monotonically through the full manifest.
  const published = events(t, { direction: 'from-worker', t: 'snapshot-published' });
  expect(published.length).toBe(DOC_COUNT);
  const counts = published.map((e) => e.readyCount!);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
  expect(counts.at(-1)).toBe(DOC_COUNT);

  // UI completion through accessible semantics: the trend surface and the
  // Inputs text table with all three additive starter series.
  await expect(page.locator('svg').first()).toBeVisible();
  await gotoPlace(page, 'inputs');
  const bookAnalysis = page.getByRole('table', { name: 'Text details' });
  await expect(bookAnalysis).toBeVisible();
  await expect(bookAnalysis.getByRole('columnheader', { name: /Holmes/ })).toBeVisible();
  await expect(bookAnalysis.getByRole('columnheader', { name: /Watson/ })).toBeVisible();
  await expect(bookAnalysis.getByRole('columnheader', { name: /Moriarty/ })).toBeVisible();
});
