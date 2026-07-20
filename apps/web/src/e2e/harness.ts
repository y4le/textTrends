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
import { DEFAULT_INDEX_RECIPE } from '@texttrends/core';

const encoder = new TextEncoder();

/** Small synthetic document with a dense common term — fast to build, and
 *  a trend query over it still spans several cancellation checkpoints. */
const DOC_TEXT = 'the wolf ran far over the hill. a wolf slept by the door. '.repeat(800);

function docBytes(): ArrayBuffer {
  return encoder.encode(DOC_TEXT).buffer as ArrayBuffer;
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
  const spec = { doc: 'race-doc', language: 'en', sourceByteLength: DOC_TEXT.length };

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

  const bSnapshot = await waitFor<SnapshotInfo>(
    (resolve) => {
      const existing = snapshots.find((s) => s.readyDocs.includes('race-doc'));
      if (existing) resolve(existing);
      else snapshotWaiter = resolve;
    },
    30_000,
    'race-B snapshot',
  );

  // Which events belong to A but arrived after B's replacement was posted?
  const all = trace.snapshot().events;
  const bBeginSeq = all.find((e) => e.direction === 'to-worker' && e.t === 'begin-generation' && e.generation === 'race-B')?.seq ?? -1;
  const staleAfterReplacement = all.filter(
    (e) =>
      e.direction === 'from-worker' &&
      e.generation === 'race-A' &&
      e.seq > bBeginSeq &&
      (e.t === 'snapshot-published' || e.t === 'source-ready' || e.t === 'result'),
  );

  // The replacement generation answers queries with real data.
  let bSnapshotQueryCount: number | null = null;
  const query = client.query(bSnapshot.snapshot, {
    op: 'trend',
    selection: { docs: ['race-doc'] },
    group: wolfGroup,
    request: { coordinate: 'document-relative', binsPerDoc: 4 },
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
  const spec = { doc: 'cancel-doc', language: 'en', sourceByteLength: DOC_TEXT.length };

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
      request: { coordinate: 'document-relative', binsPerDoc: 40 },
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
