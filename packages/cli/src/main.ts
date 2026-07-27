// texttrends CLI — Node benchmark/portability harness over @texttrends/core
// (per the portable-core decision, synthesis §8.10): prove the core runs
// headlessly and measure it. Only `bench` exists today. Runs on Node's native
// type stripping (invoke as `node packages/cli/src/main.ts`); a built
// distributable with a `bin` entry comes later with real subcommands.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDocumentIndex,
  DEFAULT_INDEX_RECIPE,
  segment,
  type DocumentIndexV1,
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

const [, , command, arg] = process.argv;
switch (command) {
  case 'bench':
    await bench(arg ?? 'text/sherlock');
    break;
  default:
    process.stdout.write('usage: node --expose-gc packages/cli/src/main.ts bench <dir>\n');
    process.exitCode = command === undefined ? 0 : 1;
}
