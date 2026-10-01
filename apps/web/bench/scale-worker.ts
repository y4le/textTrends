import { setImmediate } from 'node:timers/promises';
import { DISPERSION_EXACT_MAX, DISPERSION_BUCKET_BUDGET, DEFAULT_INDEX_RECIPE, defaultExtractionRecipes, hashExtractionRecipe, INGEST_CAPS_V0, type IngestCapsV0 } from '@texttrends/core';
import { WorkerEngineV4 } from '../src/worker/engine-v4.ts';
import type { ArtifactStore } from '../src/worker/store.ts';
import type { FromWorkerV4, GenerationDocSpecV4, QueryOpV4 } from '../src/worker/protocol-v4.ts';
import { SCALE_FIXTURE, scaleDocument, scaleDocumentLength, scaleWord } from './scale-fixture.ts';

const tokens = Number(process.argv[2]);
const override = process.argv[3] === 'engine';
if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 50_000_000) throw new Error('tokens must be 1..50000000');
if (!globalThis.gc || !process.send) throw new Error('run through scale.mjs with --expose-gc');
const send = (value: unknown) => process.send!(value);
const collect = () => { globalThis.gc!(); globalThis.gc!(); };
async function phase(name: string, run: () => Promise<unknown>) {
  collect();
  const baseline = process.memoryUsage();
  const go = new Promise<void>((resolve) => process.once('message', () => resolve()));
  send({ kind: 'ready', name, baseline });
  await go;
  const start = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - start;
  collect();
  const retained = process.memoryUsage();
  const entry = { name, elapsedMs, baseline, retained, result };
  send({ kind: 'phase', ...entry });
}
// Exercise structured-clone allocation on writes but discard artifacts, like a
// cold cache with no JS-resident backing map. This is not IndexedDB I/O timing.
const store: ArtifactStore = {
  getExtraction: async () => ({ kind: 'miss' }),
  putExtraction: async () => {}, deleteExtraction: async () => {},
  getText: async () => ({ kind: 'miss' }), getShard: async () => ({ kind: 'miss' }),
  putText: async (_key, text) => { structuredClone(text); },
  putShard: async (_key, shard) => { structuredClone(shard); },
  deleteText: async () => {}, deleteShard: async () => {}, close: () => {},
};
const errors: Array<{ code: string; message: string }> = [];
let snapshot: string | null = null;
let readyDocs: readonly string[] = [];
let result: Extract<FromWorkerV4, { t: 'result' }>['data'] | null = null;
let publications = 0;
// This benchmark-only override never changes the shipped application caps.
const caps = override ? {
  ...INGEST_CAPS_V0, maxProjectSourceBytes: 512 * 1024 * 1024, maxProjectTextUtf16: 512 * 1024 * 1024,
} as IngestCapsV0 : INGEST_CAPS_V0;
const engine = new WorkerEngineV4(store, (message, transfers) => {
  // Exercise result transfer/detachment; do not retain messages/source bodies.
  const delivered = transfers?.length ? structuredClone(message, { transfer: [...transfers] }) : message;
  if (delivered.t === 'snapshot-published') { snapshot = delivered.snapshot; readyDocs = delivered.readyDocs; publications++; }
  if (delivered.t === 'result') result = delivered.data;
  if (delivered.t === 'error') errors.push({ code: delivered.code, message: delivered.message });
}, async () => { await setImmediate(); }, caps);
const recipe = (await defaultExtractionRecipes()).txt;
const recipeHash = await hashExtractionRecipe(recipe);
const docs: GenerationDocSpecV4[] = [];
const documentTokens: number[] = [];
for (let remaining = tokens, i = 0; remaining > 0; i++) {
  const count = Math.min(remaining, SCALE_FIXTURE.tokensPerDocument);
  documentTokens.push(count);
  docs.push({ doc: `d${i}`, language: 'en', source: { format: 'txt', byteLength: scaleDocumentLength(count) },
    extraction: { recipe, recipeHash, expectedTextLengthUtf16: scaleDocumentLength(count) } });
  remaining -= count;
}
let job = 0;
await phase('admission', async () => {
  await engine.handle({ v: 4, t: 'begin-generation', job: ++job, generation: 'scale', docs, indexRecipe: DEFAULT_INDEX_RECIPE });
  return { errors: [...errors] };
});
if (errors.length === 0) {
  await phase('ingest-and-bind', async () => {
    for (let i = 0; i < docs.length; i++) {
      const bytes = new TextEncoder().encode(scaleDocument(documentTokens[i]!, i));
      await engine.handle({ v: 4, t: 'ingest', job: ++job, generation: 'scale', doc: docs[i]!.doc, bytes: bytes.buffer });
      if (errors.length) break;
    }
    return { publications, readyDocuments: readyDocs.length, errors: [...errors] };
  });
}
if (errors.length === 0 && (snapshot === null || readyDocs.length !== docs.length)) throw new Error('admitted corpus did not fully publish');
if (errors.length === 0 && snapshot !== null) {
  const group = { id: 'rare', members: [{ id: 'm', kind: 'token' as const, surface: scaleWord(900), match: { case: 'folded' as const, diacritics: 'sensitive' as const } }], countOverlaps: false };
  const tracks = [{ seriesId: 'rare', group }];
  const selection = { docs: [...readyDocs] };
  const queries: QueryOpV4[] = [
    { op: 'inventory', selection, request: { method: 'inventory/1', rhythmBinsPerDoc: 0, mattrWindow: 100 } },
    { op: 'trend', selection, group, request: { coordinate: 'declared-sequence', bins: { mode: 'per-doc', count: 4 } } },
    { op: 'dispersion', selection, tracks, request: { method: 'dispersion/1', exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET } },
    { op: 'freq-list', selection, request: { method: 'freq-list/2', filter: { minCount: 1, minDocFreq: 1, classes: ['lexical', 'numeral'] }, sort: { by: 'count', dir: -1 }, page: { offset: 0, limit: 50 }, dispersion: true } },
    { op: 'keyness', request: { method: 'keyness-g2-2x2/1', effect: 'log-ratio-halves/1', a: { docs: [readyDocs[0]!] }, b: { docs: readyDocs.slice(1) }, filter: { minCountTotal: 2, minDocFreqTotal: 1, classes: ['lexical', 'numeral'] }, sort: { by: 'g2', dir: -1 }, page: { offset: 0, limit: 50 }, side: 'a' } },
    { op: 'reader-page', tracks, request: { method: 'reader-page/1', doc: readyDocs[0]!, cursor: { kind: 'from', token: 0 }, maxTokens: 400 } },
  ];
  for (const query of queries) {
    if (query.op === 'keyness' && readyDocs.length < 2) continue;
    for (let repeat = 0; repeat < 7; repeat++) {
      result = null;
      await phase(`${query.op}/${repeat < 2 ? 'warmup' : 'sample'}-${repeat < 2 ? repeat + 1 : repeat - 1}`, async () => {
        const errorsBefore = errors.length;
        await engine.handle({ v: 4, t: 'query', job: ++job, snapshot, query });
        const delivered = result as Extract<FromWorkerV4, { t: 'result' }>['data'] | null;
        if (errors.length !== errorsBefore || delivered?.op !== query.op) throw new Error(`query failed: ${JSON.stringify(errors)}`);
        if (delivered.op === 'inventory' && delivered.inventory.totals.tokens !== tokens) throw new Error('fixture token count mismatch');
        return { op: delivered.op };
      });
    }
  }
}
send({ kind: 'complete', tokens, mode: override ? 'engine-override' : 'product-caps', fixture: SCALE_FIXTURE, caps, sourceBytes: docs.reduce((n, d) => n + d.source.byteLength, 0), errors, node: process.version, platform: process.platform, arch: process.arch });
process.disconnect();
