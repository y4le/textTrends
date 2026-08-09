/**
 * e2e protocol harness — compiled ONLY in `--mode e2e` builds (M6 consult
 * §2): destructive protocol probes against the REAL WorkerClient and the
 * real built worker asset, isolated from the auto-loading application
 * store. Each probe is a FIXED semantic experiment returning JSON-able
 * data; nothing here exposes the client, the worker, or raw postMessage
 * to the page.
 */

import { WorkerClient, type SnapshotInfo } from '../lib/client.ts';
import { RingTrace, type ProtocolTraceEvent } from '../lib/trace.ts';
import type { GenerationDocSpecV4 } from '../shared/analysis-contract.ts';
import {
  DEFAULT_INDEX_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashSourceBytes,
  hashText,
} from '@texttrends/core';

const encoder = new TextEncoder();

/** Small synthetic document with a dense common term — fast to build, and
 *  a trend query over it still spans several cancellation checkpoints. */
const DOC_TEXT = 'the wolf ran far over the hill. a wolf slept by the door. '.repeat(800);

function docBytes(): ArrayBuffer {
  return encoder.encode(DOC_TEXT).buffer as ArrayBuffer;
}

/** A real v4 spec for the synthetic ASCII document — `availability: 'external'`
 *  (the harness holds and supplies the bytes; no bundled URL, no persisted
 *  source), with independently computed source/text/recipe hashes. */
async function probeSpec(doc: string): Promise<GenerationDocSpecV4> {
  const { txt } = await defaultExtractionRecipes();
  const bytes = encoder.encode(DOC_TEXT);
  const [expectedHash, expectedText, recipeHash] = await Promise.all([
    hashSourceBytes(bytes),
    hashText(DOC_TEXT),
    hashExtractionRecipe(txt),
  ]);
  return {
    doc,
    language: 'en',
    source: { expectedHash, byteLength: bytes.length, format: 'txt', availability: 'external' },
    extraction: { recipe: txt, recipeHash, expectedText },
  };
}

const wolfGroup = {
  id: 'g:probe',
  members: [
    {
      id: 'm:probe',
      kind: 'token' as const,
      surface: 'the',
      match: { case: 'folded' as const, diacritics: 'folded' as const },
    },
  ],
  countOverlaps: false,
};

function waitFor<T>(
  subscribe: (resolve: (value: T) => void) => void,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

interface GenerationRaceResult {
  readonly ok: boolean;
  /** Trace events (sanitized metadata) for the test to assert against. */
  readonly events: readonly ProtocolTraceEvent[];
  readonly staleAfterReplacement: readonly ProtocolTraceEvent[];
  readonly bSnapshotQueryCount: number | null;
}

/**
 * Plan M6 bullet: a recipe/generation change mid-ingest creates a new
 * generation and the OLD one never publishes after replacement. Real task
 * queue, real transferred bytes, real engine gates.
 */
async function runGenerationRace(): Promise<GenerationRaceResult> {
  const trace = new RingTrace(20_000);
  const client = new WorkerClient(trace);
  const spec = await probeSpec('race-doc');

  const snapshots: SnapshotInfo[] = [];
  let snapshotWaiter: ((s: SnapshotInfo) => void) | null = null;
  client.onSnapshot((s) => {
    snapshots.push(s);
    snapshotWaiter?.(s);
  });

  const openA = client.openGeneration('race-A', [spec], DEFAULT_INDEX_RECIPE);
  await openA.result; // barrier: race-doc missing
  // Start A's REAL ingest and immediately replace the generation with a
  // semantically different, still-valid provisional recipe — no await
  // between the two posts, so the worker races them on its task queue.
  client.ingest('race-A', 'race-doc', docBytes());
  const recipeB = { ...DEFAULT_INDEX_RECIPE, apostrophes: { policy: 'keep' as const } };
  const openB = client.openGeneration('race-B', [spec], recipeB);
  await openB.result;
  client.ingest('race-B', 'race-doc', docBytes());

  // Bind explicitly to race-B's snapshot (generation, not just readyDocs
  // membership) so a legally-completed race-A snapshot can never be selected.
  const bSnapshot = await waitFor<SnapshotInfo>(
    (resolve) => {
      const existing = snapshots.find((s) => s.generation === 'race-B' && s.readyDocs.includes('race-doc'));
      if (existing) resolve(existing);
      else snapshotWaiter = (s) => { if (s.generation === 'race-B' && s.readyDocs.includes('race-doc')) resolve(s); };
    },
    30_000,
    'race-B snapshot',
  );

  // Which A events arrived after the worker PROCESSED B's replacement?
  // Staleness is measured against B's first FROM-worker event (its barrier —
  // the earliest observable proof the generation was replaced), NOT B's
  // to-worker post: an A event produced while A was still current (e.g.
  // source-ready, emitted after extract but before A's next task-queue yield
  // lets B run) legitimately follows B's post in delivery order (6c consult
  // §Q4). This is the tightest MAIN-THREAD-observable marker; the definitive
  // proof that A cannot publish after B is installed is the engine unit suite
  // (composition/query generation-replacement and cancellation gates).
  const all = trace.snapshot().events;
  const bReplacedSeq = all.find((e) => e.direction === 'from-worker' && e.generation === 'race-B')?.seq ?? Number.MAX_SAFE_INTEGER;
  const staleAfterReplacement = all.filter(
    (e) =>
      e.direction === 'from-worker' &&
      e.generation === 'race-A' &&
      e.seq > bReplacedSeq &&
      (e.t === 'snapshot-published' || e.t === 'source-ready' || e.t === 'result'),
  );

  // The replacement generation answers queries with real data.
  let bSnapshotQueryCount: number | null = null;
  const query = client.query(bSnapshot.snapshot, {
    op: 'trend',
    selection: { docs: ['race-doc'] },
    group: wolfGroup,
    request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } },
  });
  const data = await query.result;
  if (data.op === 'trend') {
    bSnapshotQueryCount = [...data.trend.count].reduce((a, b) => a + b, 0);
  }

  return {
    ok: staleAfterReplacement.length === 0 && (bSnapshotQueryCount ?? 0) > 0,
    events: all,
    staleAfterReplacement,
    bSnapshotQueryCount,
  };
}

interface CancelProbeResult {
  /** Round-trip cancel acknowledgements, ms (query post → cancelled). */
  readonly ackMs: readonly number[];
  /** Queries that completed before the cancel was observed — legal. */
  readonly completedInstead: number;
  readonly iterations: number;
}

/**
 * Cancellation transport probe: query-then-cancel on the same tick, over
 * the REAL task queue. Collects at least `wantAcks` acknowledgements (a
 * p95 needs samples, not one race) unless the iteration cap trips.
 */
async function runCancelProbe(wantAcks: number): Promise<CancelProbeResult> {
  const trace = new RingTrace(50_000);
  const client = new WorkerClient(trace);
  const spec = await probeSpec('cancel-doc');

  const snapshotReady = waitFor<SnapshotInfo>(
    (resolve) => client.onSnapshot((s) => resolve(s)),
    30_000,
    'cancel-probe snapshot',
  );
  const open = client.openGeneration('cancel-gen', [spec], DEFAULT_INDEX_RECIPE);
  await open.result;
  client.ingest('cancel-gen', 'cancel-doc', docBytes());
  const snapshot = await snapshotReady;

  const ackMs: number[] = [];
  let completedInstead = 0;
  let iterations = 0;
  const maxIterations = wantAcks * 10;
  while (ackMs.length < wantAcks && iterations < maxIterations) {
    iterations++;
    const query = client.query(snapshot.snapshot, {
      op: 'trend',
      selection: { docs: ['cancel-doc'] },
      group: wolfGroup,
      request: { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 40 } },
    });
    query.cancel(); // same tick — the worker sees query, then cancel, queued
    try {
      await query.result;
      completedInstead++;
    } catch {
      // Rejected as cancelled: measure post→cancelled from trace stamps.
      const events = trace.snapshot().events;
      const post = [...events].reverse().find((e) => e.direction === 'to-worker' && e.t === 'query');
      const ack = [...events].reverse().find((e) => e.direction === 'from-worker' && e.t === 'cancelled');
      if (post && ack && ack.seq > post.seq) ackMs.push(ack.at - post.at);
    }
  }
  return { ackMs, completedInstead, iterations };
}

declare global {
  interface Window {
    __ttHarness?: {
      readonly ready: true;
      runGenerationRace(): Promise<GenerationRaceResult>;
      runCancelProbe(wantAcks: number): Promise<CancelProbeResult>;
    };
  }
}

window.__ttHarness = Object.freeze({
  ready: true as const,
  runGenerationRace,
  runCancelProbe,
});
