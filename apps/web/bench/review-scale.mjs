// Reproduce the October 2026 review measurements; no network or corpus writes.
// Node 24: node --expose-gc --experimental-transform-types <this-file> MODE ROOT [ARGS]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, rootArgument, ...args] = process.argv.slice(2);
const root = resolve(rootArgument ?? '.');
const moduleAt = (path) => import(pathToFileURL(`${root}/${path}`).href);
const report = (value) => console.log(JSON.stringify(value, null, 2));
if (!global.gc) throw new Error('Run with --expose-gc');

if (mode === 'publication') {
  const docs = Number(args[0] ?? 256);
  const tokensPerDoc = Number(args[1] ?? 33984);
  if (!Number.isSafeInteger(docs) || docs < 1 || docs > 256
    || !Number.isSafeInteger(tokensPerDoc) || tokensPerDoc < 1
    || docs * tokensPerDoc > 10_000_000) {
    throw new Error('Use 1..256 documents and positive whole token counts, at most 10M total');
  }
  const { harness, begin, coldIngest } = await moduleAt('apps/web/test/support/engine-harness.ts');
  const { buildDocSpec } = await moduleAt('apps/web/test/support/spec-fixtures.ts');
  // Four disjoint vocabulary bands exercise global-vocabulary publication,
  // rather than hiding that cost behind a four-word repeated source.
  const wordAt = (index) => {
    let word = 'w';
    for (let digit = 0; digit < 5; digit++) {
      word += String.fromCharCode(97 + index % 26);
      index = Math.floor(index / 26);
    }
    return word;
  };
  const texts = Array.from({ length: Math.min(4, docs) }, (_, band) =>
    Array.from({ length: tokensPerDoc }, (_, i) => wordAt(band * tokensPerDoc + i)).join(' ') + '.');
  const templates = await Promise.all(texts.map((text) => buildDocSpec('d0', text)));
  const specs = Array.from({ length: docs }, (_, i) => ({ ...templates[i % texts.length], doc: `d${i}` }));
  const engine = harness(); // Real worker engine, empty in-memory cache, shipped caps.
  await begin(engine, specs);
  let firstCompose, lastPublication;
  engine.onEmit((message) => {
    if (message.t === 'progress' && message.phase === 'compose') firstCompose ??= performance.now();
    if (message.t === 'snapshot-published') lastPublication = performance.now();
  });
  global.gc();
  const started = performance.now();
  await Promise.all(specs.map((spec, i) => coldIngest(engine, 'g', spec.doc, texts[i % texts.length], 10 + i)));
  await engine.flush();
  const coldMs = performance.now() - started;
  const errors = engine.all('error');
  if (errors.length) throw new Error(JSON.stringify(errors));
  const final = engine.last('snapshot-published');
  if (final.readyDocs.length !== docs || firstCompose === undefined || lastPublication === undefined) {
    throw new Error('Incomplete publication');
  }
  // Checks happen after the clock; memory is deliberately not a peak claim.
  report({ docs, tokensPerDoc, tokens: docs * tokensPerDoc,
    vocabulary: tokensPerDoc * texts.length, sourceVariants: texts.length,
    publications: engine.all('snapshot-published').length,
    ready: final.readyDocs.length, snapshot: final.snapshot,
    coldMs, publicationTailMs: lastPublication - firstCompose });
} else if (mode === 'canonical') {
  const { canonicalJson } = await moduleAt('packages/core/src/contract/hash.ts');
  const keys = Array.from({ length: 92000 }, (_, i) => `type-${i}-café`);
  const expected = JSON.stringify(keys);
  for (let i = 0; i < 5; i++) canonicalJson(keys);
  const samples = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    const json = canonicalJson(keys);
    samples.push(performance.now() - start);
    if (json !== expected) throw new Error('Identity changed');
  }
  samples.sort((a, b) => a - b);
  report({ types: keys.length, samples: samples.length, medianMs: samples[10],
    minMs: samples[0], maxMs: samples.at(-1), utf16: expected.length });
} else if (mode === 'residency') {
  if (args[0] !== 'adopt' && args[0] !== 'copy') throw new Error('Choose adopt or copy');
  const adopt = args[0] === 'adopt';
  const coreAt = (path) => moduleAt(`packages/core/src/${path}`);
  const { createDocumentIndex } = await coreAt('index/build.ts');
  const { segment } = await coreAt('segment/intl.ts');
  const { DEFAULT_INDEX_RECIPE } = await coreAt('contract/recipes.ts');
  const { makeReadyDocument, composeSnapshot } = await coreAt('snapshot/compose.ts');
  const { createBindingSession, bindShardsIncremental, internalShardOf } = await coreAt('ops/binding.ts');
  const docs = 256, perDoc = 33984;
  let ready = new Map();
  const expected = [];
  const text = 'wolf fox hare bear. '.repeat(perDoc / 4);
  for (let i = 0; i < docs; i++) {
    const id = `d${i}`;
    expected.push(id);
    const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
    ready.set(id, await makeReadyDocument(id, shard));
  }
  const snapshot = await composeSnapshot('memory', expected, ready);
  global.gc();
  const indexedArrayBuffers = process.memoryUsage().arrayBuffers;
  const session = createBindingSession();
  let shardMap = new Map([...ready].map(([id, doc]) => [id, doc.shard]));
  const bound = await bindShardsIncremental(session, snapshot, shardMap);
  if (bound.docs().length !== docs) throw new Error('Incomplete binding');
  if (adopt) ready = new Map([...ready].map(([id, doc]) => [id, { ...doc, shard: internalShardOf(bound, id) }]));
  shardMap = null;
  await new Promise((done) => setImmediate(done));
  global.gc();
  await new Promise((done) => setImmediate(done));
  global.gc();
  report({ docs, tokens: docs * perDoc, adopt, indexedArrayBuffers,
    residentArrayBuffers: process.memoryUsage().arrayBuffers,
    live: [ready.size, bound.docs().length, !!session] });
} else if (mode === 'epub-child') {
  const { extractEpub } = await moduleAt('packages/epub/dist/epub-reader.js');
  const bytes = new Uint8Array(readFileSync(args[0]));
  global.gc();
  console.log(JSON.stringify({ phase: 'ready', baseline: process.memoryUsage().rss, archiveBytes: bytes.length }));
  process.stdin.once('data', () => {
    const start = performance.now();
    try {
      const result = extractEpub(bytes, { retainSectionText: false });
      console.log(JSON.stringify({ phase: 'done', ms: performance.now() - start,
        textUtf16: result.text.length, title: result.metadata?.title,
        sections: result.sections.length, rss: process.memoryUsage().rss }));
    } catch (error) {
      console.log(JSON.stringify({ phase: 'error', code: error.code, message: error.message }));
      process.exitCode = 1;
    }
    process.stdin.destroy();
  });
} else if (mode === 'epub') {
  if (process.platform !== 'linux' || !args[0]) throw new Error('Linux /proc and an EPUB file path are required');
  const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url),
    'epub-child', root, resolve(args[0])], { stdio: ['pipe', 'pipe', 'inherit'] });
  let pending = '', ready, done, peak = 0, samples = 0, interval;
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n');
      const value = JSON.parse(pending.slice(0, index));
      pending = pending.slice(index + 1);
      if (value.phase === 'ready') {
        ready = value;
        peak = value.baseline;
        interval = setInterval(() => {
          try {
            const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
            peak = Math.max(peak, Number(status.match(/^VmRSS:\s+(\d+) kB/m)[1]) * 1024);
            samples++;
          } catch { /* The child may have exited between samples. */ }
        }, 2);
        child.stdin.write('go\n');
      } else {
        done = value;
        clearInterval(interval);
        if (value.rss) peak = Math.max(peak, value.rss);
      }
    }
  });
  child.on('error', (error) => { clearInterval(interval); throw error; });
  child.on('close', (code) => {
    clearInterval(interval);
    if (code !== 0 || !ready || done?.phase !== 'done') {
      report({ ready, done, exitCode: code });
      process.exitCode = 1;
      return;
    }
    report({ ...ready, ...done, phasePeakRss: peak, phaseGrowth: peak - ready.baseline, samples });
  });
} else {
  throw new Error('Choose publication, canonical, residency or epub');
}
