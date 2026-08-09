// texttrends CLI — Node benchmark/portability harness over @texttrends/core
// (per the portable-core decision, synthesis §8.10): prove the core runs
// headlessly and measure it. Runs on Node's native type stripping (invoke as
// `node packages/cli/src/main.ts`); a built distributable with a `bin` entry
// comes later with real subcommands.

import { fork } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildResolver,
  CapError,
  composeSnapshot,
  createDocumentIndex,
  DEFAULT_INDEX_RECIPE,
  makeReadyDocument,
  modeKey,
  OCCURRENCE_LIMITS_V1,
  occurrencePayloadBytes,
  occurrences,
  resolveSelection,
  segment,
  type DocumentIndexV1,
  type MatchMode,
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
  shards: Map<string, DocumentIndexV1>;
  snapshot: Awaited<ReturnType<typeof composeSnapshot>>;
  selection: Awaited<ReturnType<typeof resolveSelection>>;
  resolvers: Map<string, Map<string, Resolver>>;
  common: [string, number];
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
  const ready = new Map<string, Awaited<ReturnType<typeof makeReadyDocument>>>();
  for (let i = 0; i < files.length; i++) {
    const shard = (await indexFile(files[i] as string, texts[i] as string)).shard;
    shards.set(docs[i] as string, shard);
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
  const common = [...frequencies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
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
      { id: 'phrase', kind: 'phrase', surfaces: [common[0], common[0]], match: folded, crossSentence: false },
    ],
  };

  return {
    files,
    shards,
    snapshot,
    selection,
    resolvers,
    common,
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
  default:
    process.stdout.write('usage: node --expose-gc packages/cli/src/main.ts <bench|bench-occurrences> <dir>\n');
    process.exitCode = command === undefined ? 0 : 1;
}
