// texttrends CLI — Node benchmark/portability harness over @texttrends/core
// The portability harness proves the core runs
// headlessly and measure it. Runs on Node's native type stripping (invoke as
// `node packages/cli/src/main.ts`); a built distributable with a `bin` entry
// comes later with real subcommands.

import { fork } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildResolver,
  bindShardsIncremental,
  bindTextsVerified,
  CapError,
  company,
  composeSnapshot,
  createBindingSession,
  createCompanyScratch,
  createDestinationsScratch,
  createDocumentIndex,
  DEFAULT_INDEX_RECIPE,
  destinationScratchBytes,
  DESTINATION_MAX_RESULTS,
  DESTINATION_WINDOW_TOKENS_V1,
  makeReadyDocument,
  materializeDestinations,
  modeKey,
  OCCURRENCE_LIMITS_V1,
  occurrencePayloadBytes,
  occurrences,
  planDestinationWindowSpikeV0,
  planDestinations,
  resolveSelection,
  segment,
  verifyText,
  type DocumentIndexV1,
  COMPANY_GAP_EDGES_V1,
  type MatchMode,
  type NumericOccurrences,
  type Resolver,
  type TermGroupSpec,
} from '@texttrends/core';

interface FileTiming {
  name: string;
  chars: number;
  tokens: number;
  vocab: number;
  segmentMs: number;
  buildMs: number;
}

async function indexFile(
  path: string,
  text: string,
): Promise<{ timing: FileTiming; shard: DocumentIndexV1 }> {
  const t0 = performance.now();
  const seg = await segment(text, 'en');
  const t1 = performance.now();
  const shard = await createDocumentIndex(text, seg, DEFAULT_INDEX_RECIPE);
  const t2 = performance.now();
  return {
    timing: {
      name: path.split('/').pop() ?? path,
      chars: text.length,
      tokens: shard.tokenTypeIds.length,
      vocab: shard.vocabulary.length,
      segmentMs: t1 - t0,
      buildMs: t2 - t1,
    },
    shard,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

type Gc = () => void;
function tryGc(): boolean {
  const gc = (globalThis as { gc?: Gc }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
    return true;
  }
  return false;
}

interface MemSample {
  rssMB: number;
  heapMB: number;
  arrayBuffersMB: number;
}
function sampleMem(): MemSample {
  const m = process.memoryUsage();
  return {
    rssMB: Math.round(m.rss / 1e6),
    heapMB: Math.round(m.heapUsed / 1e6),
    arrayBuffersMB: Math.round(m.arrayBuffers / 1e6),
  };
}

/**
 * Methodology (documented in docs/design/benchmarks.md): file contents are
 * preloaded (I/O excluded); one warmup iteration is discarded (JIT-warmed
 * steady state is what a long-lived worker sees on all but its first
 * documents); the reported total is the median of the measured iterations.
 *
 * Memory attribution requires --expose-gc: collect after preload for a
 * baseline (sources + runtime), collect again with only the final shard set
 * retained, and report the DELTA as retained-shard memory. Without
 * --expose-gc the harness reports raw process samples labeled as such —
 * they include uncollected transients and must not be quoted as shard cost.
 */
async function bench(dir: string, iterations = 3): Promise<void> {
  const files = readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile() && !p.endsWith('.md'))
    .sort();
  const texts = files.map((p) => readFileSync(p, 'utf8'));

  const gcAvailable = tryGc();
  const baseline = sampleMem(); // sources + runtime, post-gc when available

  await Promise.all(files.map((p, i) => indexFile(p, texts[i] as string))); // warmup

  const totals: number[] = [];
  let lastRows: FileTiming[] = [];
  let retained: DocumentIndexV1[] = [];
  for (let it = 0; it < iterations; it++) {
    retained = [];
    lastRows = [];
    for (let i = 0; i < files.length; i++) {
      const { timing, shard } = await indexFile(files[i] as string, texts[i] as string);
      lastRows.push(timing);
      retained.push(shard);
    }
    totals.push(lastRows.reduce((s, r) => s + r.segmentMs + r.buildMs, 0));
  }

  tryGc(); // with only `retained` (+ sources) alive
  const withShards = sampleMem();
  const medianMs = median(totals);
  const tokens = lastRows.reduce((s, r) => s + r.tokens, 0);

  process.stdout.write(
    JSON.stringify(
      {
        method: {
          command: 'node --expose-gc packages/cli/src/main.ts bench <dir>',
          io: 'excluded (files preloaded)',
          warmupIterations: 1,
          measuredIterations: iterations,
          reported: 'median of iteration totals; per-file rows from final iteration',
          node: process.version,
        },
        rows: lastRows.map((r) => ({
          ...r,
          segmentMs: Math.round(r.segmentMs),
          buildMs: Math.round(r.buildMs),
        })),
        total: {
          chars: lastRows.reduce((s, r) => s + r.chars, 0),
          tokens,
          medianMs: Math.round(medianMs),
          iterationTotalsMs: totals.map((t) => Math.round(t)),
          tokensPerSec: Math.round(tokens / (medianMs / 1000)),
        },
        memory: gcAvailable
          ? {
              attribution: 'gc-baselined delta = retained final shard set',
              baselinePostPreload: baseline,
              withRetainedShards: withShards,
              retainedShardDelta: {
                heapMB: withShards.heapMB - baseline.heapMB,
                arrayBuffersMB: withShards.arrayBuffersMB - baseline.arrayBuffersMB,
              },
              retainedShards: retained.length,
            }
          : {
              attribution:
                'RAW PROCESS SAMPLES (run with --expose-gc for attributable deltas); includes uncollected transients',
              baselinePostPreload: baseline,
              endOfRun: withShards,
            },
      },
      null,
      2,
    ) + '\n',
  );
}

interface OccurrenceBenchmarkFixture {
  files: string[];
  sourceTexts: Map<string, string>;
  shards: Map<string, DocumentIndexV1>;
  snapshot: Awaited<ReturnType<typeof composeSnapshot>>;
  selection: Awaited<ReturnType<typeof resolveSelection>>;
  resolvers: Map<string, Map<string, Resolver>>;
  common: [string, number];
  typesByFrequency: readonly [string, number][];
  nearCap: { surface: string; postings: number; members: number };
  nearCapGroup: TermGroupSpec;
  capGroup: TermGroupSpec;
}

interface OccurrencePhaseResult {
  phase: 'near-cap-construction' | 'cap-pressure';
  group: string;
  ms: number;
  occurrences: number | null;
  payloadBytes: number | null;
  capMessage: string | null;
  warmCacheRead: { ms: number; hit: boolean };
}

interface OccurrencePhaseMemory {
  measured: boolean;
  method: string;
  baselineMiB?: number;
  sampledPeakMiB?: number;
  sampledPeakDeltaMiB?: number;
  samples?: number;
  reason?: string;
}

async function prepareOccurrenceBenchmark(dir: string): Promise<OccurrenceBenchmarkFixture> {
  const files = readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile() && !p.endsWith('.md'))
    .sort();
  const texts = files.map((p) => readFileSync(p, 'utf8'));
  const docs = files.map((path, index) => `bench-${index}-${path.split('/').pop() ?? index}`);
  const shards = new Map<string, DocumentIndexV1>();
  const sourceTexts = new Map<string, string>();
  const ready = new Map<string, Awaited<ReturnType<typeof makeReadyDocument>>>();
  for (let i = 0; i < files.length; i++) {
    const shard = (await indexFile(files[i] as string, texts[i] as string)).shard;
    shards.set(docs[i] as string, shard);
    sourceTexts.set(docs[i] as string, texts[i] as string);
    ready.set(docs[i]!, await makeReadyDocument(docs[i]! as never, shard));
  }
  const snapshot = await composeSnapshot('occurrence-benchmark' as never, docs as never, ready as never);
  const selection = await resolveSelection(snapshot, { docs: docs as never });
  const folded: MatchMode = { case: 'folded', diacritics: 'sensitive' };
  const exact: MatchMode = { case: 'sensitive', diacritics: 'sensitive' };
  const resolvers = new Map<string, Map<string, Resolver>>();
  const frequencies = new Map<string, number>();
  for (let d = 0; d < docs.length; d++) {
    const doc = docs[d]!;
    const shard = shards.get(doc)!;
    const foldedResolver = await buildResolver(shard, DEFAULT_INDEX_RECIPE, folded);
    const exactResolver = await buildResolver(shard, DEFAULT_INDEX_RECIPE, exact);
    resolvers.set(doc, new Map([
      [modeKey(folded), foldedResolver],
      [modeKey(exact), exactResolver],
    ]));
    for (let local = 0; local < shard.vocabulary.length; local++) {
      const count = (shard.postings.offsets[local + 1] ?? 0) - (shard.postings.offsets[local] ?? 0);
      const key = shard.vocabulary[local]!;
      frequencies.set(key, (frequencies.get(key) ?? 0) + count);
    }
  }
  const typesByFrequency = [...frequencies]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const common = typesByFrequency[0];
  if (!common) throw new Error('occurrence benchmark corpus contains no tokens');
  const nearCapCandidate = [...frequencies]
    .flatMap(([surface, postings]) => {
      const members = Math.min(
        32,
        Math.floor(OCCURRENCE_LIMITS_V1.maxOccurrences / postings),
      );
      return members > 0 ? [{ surface, postings, members, total: postings * members }] : [];
    })
    .sort((a, b) => b.total - a.total || b.postings - a.postings || a.surface.localeCompare(b.surface))[0];
  if (!nearCapCandidate) {
    throw new Error('occurrence benchmark corpus has no exact type below the occurrence cap');
  }
  const nearCapGroup: TermGroupSpec = {
    id: 'near-cap-common-group',
    countOverlaps: true,
    members: Array.from({ length: nearCapCandidate.members }, (_, index) => ({
      id: `token-${index}`,
      kind: 'token' as const,
      surface: nearCapCandidate.surface,
      match: exact,
    })),
  };
  const capGroup: TermGroupSpec = {
    id: 'adversarial-common-group',
    countOverlaps: true,
    members: [
      { id: 'token', kind: 'token', surface: common[0], match: folded },
      { id: 'prefix', kind: 'prefix', stem: common[0], match: folded },
      {
        id: 'phrase', kind: 'phrase',
        elements: [
          { kind: 'token', surface: common[0] },
          { kind: 'token', surface: common[0] },
        ],
        match: folded, crossSentence: false,
      },
    ],
  };

  return {
    files,
    sourceTexts,
    shards,
    snapshot,
    selection,
    resolvers,
    common,
    typesByFrequency,
    nearCap: nearCapCandidate,
    nearCapGroup,
    capGroup,
  };
}

function waitForParentGo(phase: OccurrencePhaseResult['phase']): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown): void => {
      if (
        typeof message === 'object'
        && message !== null
        && (message as { type?: unknown }).type === 'go'
        && (message as { phase?: unknown }).phase === phase
      ) {
        process.off('message', onMessage);
        resolve();
      }
    };
    process.on('message', onMessage);
  });
}

async function runOccurrencePhase(
  fixture: OccurrenceBenchmarkFixture,
  phase: OccurrencePhaseResult['phase'],
  group: TermGroupSpec,
  groupDescription: string,
): Promise<void> {
  tryGc();
  process.send?.({ type: 'phase-ready', phase });
  await waitForParentGo(phase);
  const started = performance.now();
  let value: ReturnType<typeof occurrences> | null = null;
  let capMessage: string | null = null;
  try {
    value = occurrences(
      fixture.snapshot,
      fixture.shards,
      fixture.resolvers,
      fixture.selection,
      group,
    );
  } catch (error) {
    if (!(error instanceof CapError)) throw error;
    capMessage = error.message;
  }
  if (phase === 'near-cap-construction' && value === null) {
    throw new Error(`calculated near-cap group was unexpectedly rejected: ${capMessage}`);
  }
  const coldMs = performance.now() - started;
  const cache = new Map<string, ReturnType<typeof occurrences>>();
  if (value) cache.set('result', value);
  const warmStarted = performance.now();
  const warm = cache.get('result') ?? null;
  const warmMs = performance.now() - warmStarted;
  process.send?.({
    type: 'phase-result',
    result: {
      phase,
      group: groupDescription,
      ms: Math.round(coldMs * 10) / 10,
      occurrences: value?.pos.length ?? null,
      payloadBytes: value ? occurrencePayloadBytes(value) : null,
      capMessage,
      warmCacheRead: {
        ms: Math.round(warmMs * 1000) / 1000,
        hit: warm !== null,
      },
    } satisfies OccurrencePhaseResult,
  });
}

async function benchOccurrencesWorker(dir: string): Promise<void> {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('bench-occurrences-worker is internal and requires an IPC parent');
  }
  const fixture = await prepareOccurrenceBenchmark(dir);
  process.send?.({
    type: 'fixture',
    method: {
      corpusFiles: fixture.files.length,
      corpusTokens: [...fixture.shards.values()].reduce(
        (sum, shard) => sum + shard.tokenTypeIds.length,
        0,
      ),
      commonType: fixture.common[0],
      commonTypePostings: fixture.common[1],
      nearCapType: fixture.nearCap.surface,
      nearCapTypePostings: fixture.nearCap.postings,
      nearCapMembers: fixture.nearCap.members,
    },
  });
  await runOccurrencePhase(
    fixture,
    'near-cap-construction',
    fixture.nearCapGroup,
    `${fixture.nearCapGroup.members.length} duplicate exact token members; countOverlaps=true`,
  );
  await runOccurrencePhase(
    fixture,
    'cap-pressure',
    fixture.capGroup,
    'token + same-surface prefix + repeated-common two-token phrase; countOverlaps=true',
  );
  process.send?.({ type: 'complete' });
  process.disconnect?.();
}

function linuxRssKiB(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Run occurrence construction in a child so the parent event loop can
 * sample current RSS while the child is synchronously inside the kernel.
 * This avoids attributing the earlier indexing high-water mark to the
 * occurrence phase. Linux exposes per-process current RSS via `/proc`; on
 * other platforms the JSON explicitly marks the memory gate untested. */
async function benchOccurrences(dir: string): Promise<void> {
  const child = fork(fileURLToPath(import.meta.url), ['bench-occurrences-worker', dir], {
    execArgv: process.execArgv.includes('--expose-gc')
      ? process.execArgv
      : [...process.execArgv, '--expose-gc'],
    silent: true,
  });
  // The worker protocol is IPC-only. Drain an accidental stdout write so it
  // cannot fill the pipe and deadlock the benchmark before the watchdog fires.
  child.stdout?.resume();
  const fixture = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const phases: OccurrencePhaseResult[] = [];
    const memory: Record<string, OccurrencePhaseMemory> = {};
    let method: Record<string, unknown> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let baselineKiB: number | null = null;
    let peakKiB: number | null = null;
    let samples = 0;
    let activePhase: OccurrencePhaseResult['phase'] | null = null;
    let completed = false;
    const watchdog = setTimeout(() => {
      child.kill();
      reject(new Error('occurrence benchmark child exceeded the 5 minute watchdog'));
    }, 5 * 60_000);

    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (error) => {
      if (timer) clearInterval(timer);
      clearTimeout(watchdog);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (timer) clearInterval(timer);
      clearTimeout(watchdog);
      if (!completed) reject(new Error(`occurrence benchmark child exited ${code ?? signal}`));
    });
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const event = message as {
        type?: string;
        phase?: OccurrencePhaseResult['phase'];
        result?: OccurrencePhaseResult;
        method?: Record<string, unknown>;
      };
      if (event.type === 'fixture' && event.method) {
        method = event.method;
        return;
      }
      if (event.type === 'phase-ready' && event.phase) {
        activePhase = event.phase;
        baselineKiB = linuxRssKiB(child.pid!);
        peakKiB = baselineKiB;
        samples = baselineKiB === null ? 0 : 1;
        if (baselineKiB !== null) {
          timer = setInterval(() => {
            const rss = linuxRssKiB(child.pid!);
            if (rss === null) return;
            samples++;
            peakKiB = Math.max(peakKiB ?? rss, rss);
          }, 1);
        }
        child.send({ type: 'go', phase: event.phase });
        return;
      }
      if (event.type === 'phase-result' && event.result) {
        if (timer) clearInterval(timer);
        timer = null;
        const finalRssKiB = linuxRssKiB(child.pid!);
        if (finalRssKiB !== null) {
          samples++;
          peakKiB = Math.max(peakKiB ?? finalRssKiB, finalRssKiB);
        }
        const phase = activePhase ?? event.result.phase;
        memory[phase] = baselineKiB !== null && peakKiB !== null
          ? {
              measured: true,
              method: 'parent sampled child /proc VmRSS every 1 ms during occurrence construction',
              baselineMiB: Math.round((baselineKiB / 1024) * 10) / 10,
              sampledPeakMiB: Math.round((peakKiB / 1024) * 10) / 10,
              sampledPeakDeltaMiB: Math.round(((peakKiB - baselineKiB) / 1024) * 10) / 10,
              samples,
            }
          : {
              measured: false,
              method: 'phase-local current-RSS sampling unavailable',
              reason: 'this platform does not expose Linux /proc/<pid>/status VmRSS',
            };
        phases.push(event.result);
        activePhase = null;
        return;
      }
      if (event.type === 'complete') {
        completed = true;
        clearTimeout(watchdog);
        resolve({
          method: {
            command: 'node --expose-gc packages/cli/src/main.ts bench-occurrences <dir>',
            ...method,
            isolation: 'index in child; parent samples only each signalled occurrence phase',
          },
          phases: phases.map((phase) => ({ ...phase, memory: memory[phase.phase] })),
        });
      }
    });
  });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

const BENCH_TRACK_OFFSETS = [0, 7, 37, 101, 301] as const;

function shiftedBenchmarkTracks(
  fixture: OccurrenceBenchmarkFixture,
  occurrence: NumericOccurrences,
): readonly {
  readonly seriesId: string;
  readonly groupId: string;
  readonly occurrences: NumericOccurrences;
}[] {
  const maxSpanByDoc = new Uint32Array(fixture.snapshot.docs.length);
  for (let index = 0; index < occurrence.pos.length; index++) {
    const doc = occurrence.docOrdinal[index]!;
    maxSpanByDoc[doc] = Math.max(maxSpanByDoc[doc]!, occurrence.spanTokens[index]!);
  }
  const shiftedOccurrence = (offset: number): NumericOccurrences => {
    const pos = new Uint32Array(occurrence.pos.length);
    for (let index = 0; index < pos.length; index++) {
      const doc = occurrence.docOrdinal[index]!;
      const ceiling = fixture.snapshot.docs[doc]!.tokenCount - maxSpanByDoc[doc]!;
      pos[index] = Math.min(occurrence.pos[index]! + offset, ceiling);
    }
    return { ...occurrence, pos };
  };
  return BENCH_TRACK_OFFSETS.map((offset, index) => ({
    seriesId: `bench-${index}`,
    groupId: `bench-group-${index}`,
    occurrences: shiftedOccurrence(offset),
  }));
}

/** Five cache-admissible near-cap vectors whose positions are interleaved over
 * the real snapshot geometry. Unlike duplicate-member term fixtures, these
 * maximize distinct anchor positions, which is the Destinations hot path. */
function interleavedDestinationBenchmarkTracks(
  fixture: OccurrenceBenchmarkFixture,
): readonly {
  readonly seriesId: string;
  readonly groupId: string;
  readonly occurrences: NumericOccurrences;
}[] {
  const trackCount = 5;
  const corpusTokens = fixture.snapshot.docs.reduce((sum, doc) => sum + doc.tokenCount, 0);
  const occurrencesPerTrack = Math.min(OCCURRENCE_LIMITS_V1.maxOccurrences, corpusTokens);
  return Array.from({ length: trackCount }, (_, track) => {
    const docOrdinal = new Uint32Array(occurrencesPerTrack);
    const pos = new Uint32Array(occurrencesPerTrack);
    const spanTokens = new Uint32Array(occurrencesPerTrack);
    spanTokens.fill(1);
    let doc = 0;
    for (let index = 0; index < occurrencesPerTrack; index++) {
      const global = Math.floor(
        ((index * trackCount + track) * corpusTokens)
        / (occurrencesPerTrack * trackCount),
      );
      while (
        doc + 1 < fixture.snapshot.docs.length
        && global >= fixture.snapshot.docs[doc + 1]!.sequenceTokenBase
      ) doc++;
      docOrdinal[index] = doc;
      pos[index] = global - fixture.snapshot.docs[doc]!.sequenceTokenBase;
    }
    return {
      seriesId: `bench-${track}`,
      groupId: `bench-group-${track}`,
      occurrences: {
        snapshot: fixture.snapshot.id,
        selection: fixture.selection.hash,
        docOrdinal,
        pos,
        spanTokens,
        memberOffsets: new Uint32Array(occurrencesPerTrack + 1),
        memberOrdinals: new Uint32Array(),
      },
    };
  });
}

/** Cached-occurrence Company benchmark. Five logical tracks use shifted,
 * document-valid position buffers derived from one near-cap occurrence vector.
 * Immutable provenance arrays remain borrowed, keeping fixture overhead small
 * while exercising gap bucketing and directional classification rather than
 * measuring only the identical-vector overlap fast path. */
async function benchCompany(dir: string, iterations = 5): Promise<void> {
  const fixture = await prepareOccurrenceBenchmark(dir);
  const occurrence = occurrences(
    fixture.snapshot,
    fixture.shards,
    fixture.resolvers,
    fixture.selection,
    fixture.nearCapGroup,
  );
  const tracks = shiftedBenchmarkTracks(fixture, occurrence);
  const request = { method: 'company/1' as const, gapEdges: COMPANY_GAP_EDGES_V1 };
  const run = async () => company(
    fixture.snapshot,
    fixture.selection,
    tracks,
    request,
    createCompanyScratch(tracks, fixture.snapshot.docs.length),
    async () => {},
  );
  await run(); // JIT warmup, discarded
  const samples: number[] = [];
  let result: Awaited<ReturnType<typeof run>> | null = null;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    result = await run();
    samples.push(performance.now() - started);
  }
  if (!result) throw new Error('company benchmark did not run');
  const medianMs = median(samples);
  const totalOccurrences = tracks.reduce((sum, track) => sum + track.occurrences.pos.length, 0);
  const histogramBucketsPopulated = new Set<number>();
  let overlapClassifications = 0;
  for (const pair of result.pairs) {
    pair.fromA.forEach((count, bucket) => {
      if (count > 0) histogramBucketsPopulated.add(bucket);
    });
    pair.fromB.forEach((count, bucket) => {
      if (count > 0) histogramBucketsPopulated.add(bucket);
    });
    overlapClassifications += pair.overlapA + pair.overlapB;
  }
  process.stdout.write(`${JSON.stringify({
    method: {
      command: 'node --expose-gc packages/cli/src/main.ts bench-company <dir>',
      corpusFiles: fixture.files.length,
      corpusTokens: fixture.snapshot.docs.reduce((sum, doc) => sum + doc.tokenCount, 0),
      tracks: tracks.length,
      occurrencesPerTrack: occurrence.pos.length,
      positionOffsets: BENCH_TRACK_OFFSETS,
      totalOccurrences,
      pairCount: result.pairs.length,
      warmupIterations: 1,
      measuredIterations: iterations,
      reported: 'median of cached-occurrence kernel runs; scratch creation included',
      node: process.version,
    },
    timing: {
      medianMs: Math.round(medianMs * 10) / 10,
      samplesMs: samples.map((sample) => Math.round(sample * 10) / 10),
      sourceOccurrenceVisits: (tracks.length - 1) * totalOccurrences,
      overlapClassifications,
      histogramBucketsPopulated: histogramBucketsPopulated.size,
    },
    output: {
      bytesUtf8Json: Buffer.byteLength(JSON.stringify(result)),
      pairs: result.pairs.length,
    },
  }, null, 2)}\n`);
}

/** Cached-occurrence Destinations benchmark. Planning includes fresh bounded
 * scratch; source binding is prepared outside the measured phases. */
async function benchDestinations(dir: string, iterations = 5): Promise<void> {
  const fixture = await prepareOccurrenceBenchmark(dir);
  const tracks = interleavedDestinationBenchmarkTracks(fixture);
  const request = {
    method: 'destinations/1' as const,
    windowTokens: DESTINATION_WINDOW_TOKENS_V1,
    limit: DESTINATION_MAX_RESULTS,
    focus: null,
  } as const;
  const runPlan = () => planDestinations(
    fixture.snapshot,
    fixture.selection,
    tracks,
    request,
    createDestinationsScratch(tracks, fixture.snapshot.docs.length),
    async () => {},
  );
  await runPlan();
  await runPlan();
  const planSamples: number[] = [];
  let plan: Awaited<ReturnType<typeof runPlan>> | null = null;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    plan = await runPlan();
    planSamples.push(performance.now() - started);
  }
  if (!plan) throw new Error('destinations planning benchmark did not run');

  const binding = createBindingSession();
  const boundShards = await bindShardsIncremental(binding, fixture.snapshot, fixture.shards);
  const verifiedTexts = new Map<string, Awaited<ReturnType<typeof verifyText>>>();
  for (const [doc, text] of fixture.sourceTexts) verifiedTexts.set(doc, await verifyText(text));
  const boundTexts = await bindTextsVerified(fixture.snapshot, boundShards, verifiedTexts);
  const runMaterialize = () => materializeDestinations(
    fixture.snapshot,
    plan!,
    boundShards,
    boundTexts,
    tracks,
  );
  runMaterialize();
  runMaterialize();
  const materializeSamples: number[] = [];
  let result: ReturnType<typeof runMaterialize> | null = null;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    result = runMaterialize();
    materializeSamples.push(performance.now() - started);
  }
  if (!result) throw new Error('destinations materialization benchmark did not run');
  const scratch = createDestinationsScratch(tracks, fixture.snapshot.docs.length);
  process.stdout.write(`${JSON.stringify({
    method: {
      command: 'node --expose-gc packages/cli/src/main.ts bench-destinations <dir>',
      corpusFiles: fixture.files.length,
      corpusTokens: fixture.snapshot.docs.reduce((sum, doc) => sum + doc.tokenCount, 0),
      tracks: tracks.length,
      occurrencesPerTrack: tracks[0]!.occurrences.pos.length,
      totalOccurrences: tracks.reduce((sum, track) => sum + track.occurrences.pos.length, 0),
      positionFixture: 'five interleaved cache-admissible vectors over real snapshot geometry',
      windowTokens: request.windowTokens,
      warmupIterations: 2,
      measuredIterations: iterations,
      node: process.version,
    },
    planning: {
      medianMs: Math.round(median(planSamples) * 10) / 10,
      samplesMs: planSamples.map((sample) => Math.round(sample * 10) / 10),
      scratchBytes: destinationScratchBytes(scratch),
      destinations: plan.destinations.length,
    },
    materialization: {
      medianMs: Math.round(median(materializeSamples) * 100) / 100,
      samplesMs: materializeSamples.map((sample) => Math.round(sample * 100) / 100),
    },
    output: {
      bytesUtf8Json: Buffer.byteLength(JSON.stringify(result)),
      destinations: result.destinations.length,
      marks: result.destinations.reduce((sum, item) => sum + item.snippet.marks.length, 0),
    },
  }, null, 2)}\n`);
}

/** Deterministic real-kernel policy spike used before destinations/1 is
 * admitted to the worker protocol. It compares window widths across four
 * qualitatively different track sets and reports the full Company edge mass. */
async function spikeOverview(dir: string): Promise<void> {
  const fixture = await prepareOccurrenceBenchmark(dir);
  const exact: MatchMode = { case: 'sensitive', diacritics: 'sensitive' };
  const groupFor = (surface: string, index: number): TermGroupSpec => ({
    id: `spike-${index}`,
    countOverlaps: false,
    members: [{ id: `token-${index}`, kind: 'token', surface, match: exact }],
  });
  const distinct = fixture.typesByFrequency.filter(([, count]) => count > 0);
  const commonTypes = distinct.slice(0, 5);
  const rareType = [...distinct].reverse().find(([, count]) => count >= 2) ?? distinct.at(-1);
  if (commonTypes.length < 5 || rareType === undefined) {
    throw new Error('overview spike needs at least five observed token types');
  }
  const makeTracks = (types: readonly [string, number][]) => types.map(([surface], index) => ({
    seriesId: `spike-${index}`,
    groupId: surface,
    occurrences: occurrences(
      fixture.snapshot,
      fixture.shards,
      fixture.resolvers,
      fixture.selection,
      groupFor(surface, index),
    ),
  }));
  const rare = makeTracks([rareType]);
  const cooccurring = makeTracks(commonTypes.slice(0, 2));
  const commonRare = makeTracks([commonTypes[0]!, rareType]);
  const nearCap = occurrences(
    fixture.snapshot,
    fixture.shards,
    fixture.resolvers,
    fixture.selection,
    fixture.nearCapGroup,
  );
  const capPressure = shiftedBenchmarkTracks(fixture, nearCap);
  const scenarios = [
    ['rare', rare],
    ['co-occurring-common', cooccurring],
    ['common-plus-rare', commonRare],
    ['five-track-cap-pressure', capPressure],
  ] as const;
  const destinationResults = [];
  for (const [scenario, tracks] of scenarios) {
    for (const windowTokens of [300, 400, 600] as const) {
      const plan = await planDestinationWindowSpikeV0(
        fixture.snapshot,
        fixture.selection,
        tracks,
        {
          method: 'destinations/1',
          windowTokens,
          limit: DESTINATION_MAX_RESULTS,
          focus: null,
        },
        createDestinationsScratch(tracks, fixture.snapshot.docs.length),
        async () => {},
      );
      destinationResults.push({
        scenario,
        windowTokens,
        trackTotals: plan.tracks.map((track) => track.total),
        resultCount: plan.destinations.length,
        docsRepresented: new Set(plan.destinations.map((item) => item.docOrdinal)).size,
        meanPresentTracks: plan.destinations.length === 0 ? 0 : Math.round(
          100 * plan.destinations.reduce((sum, item) => sum + item.presentTracks, 0)
          / plan.destinations.length,
        ) / 100,
        top: plan.destinations.slice(0, 3).map((item) => ({
          docOrdinal: item.docOrdinal,
          tokens: item.tokens,
          counts: item.counts,
          score: item.score,
        })),
      });
    }
  }
  const companyResults = [];
  for (const [scenario, tracks] of [
    ['co-occurring-common', cooccurring],
    ['common-plus-rare', commonRare],
  ] as const) {
    const result = await company(
      fixture.snapshot,
      fixture.selection,
      tracks,
      { method: 'company/1', gapEdges: COMPANY_GAP_EDGES_V1 },
      createCompanyScratch(tracks, fixture.snapshot.docs.length),
      async () => {},
    );
    const pair = result.pairs[0]!;
    companyResults.push({
      scenario,
      trackTotals: result.tracks.map((track) => track.total),
      fromA: pair.fromA,
      fromB: pair.fromB,
      overlapA: pair.overlapA,
      overlapB: pair.overlapB,
      noneA: pair.noneA,
      noneB: pair.noneB,
    });
  }
  process.stdout.write(`${JSON.stringify({
    method: {
      command: 'node packages/cli/src/main.ts spike-overview <dir>',
      corpusFiles: fixture.files.length,
      corpusTokens: fixture.snapshot.docs.reduce((sum, doc) => sum + doc.tokenCount, 0),
      commonTypes,
      rareType,
    },
    company: {
      gapEdges: COMPANY_GAP_EDGES_V1,
      scenarios: companyResults,
    },
    destinations: destinationResults,
  }, null, 2)}\n`);
}

const [, , command, arg] = process.argv;
switch (command) {
  case 'bench':
    await bench(arg ?? 'text/sherlock');
    break;
  case 'bench-occurrences':
    await benchOccurrences(arg ?? 'text/sherlock');
    break;
  case 'bench-occurrences-worker':
    await benchOccurrencesWorker(arg ?? 'text/sherlock');
    break;
  case 'bench-company':
    await benchCompany(arg ?? 'text/sherlock');
    break;
  case 'bench-destinations':
    await benchDestinations(arg ?? 'text/sherlock');
    break;
  case 'spike-overview':
    await spikeOverview(arg ?? 'text/sherlock');
    break;
  default:
    process.stdout.write('usage: node --expose-gc packages/cli/src/main.ts <bench|bench-occurrences|bench-company|bench-destinations|spike-overview> <dir>\n');
    process.exitCode = command === undefined ? 0 : 1;
}
