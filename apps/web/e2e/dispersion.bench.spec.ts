/**
 * dispersion/1 kernel benchmarks (slice-2 ruling §C): rare / 50k-exact /
 * dense packing, NON-GATING — recorded to the same retained surface as the
 * browser timings (testInfo.attach JSON in the serialized benchmark
 * project; CI uploads artifacts). Warmed and repeated: median of 7 samples
 * after 2 warmups, high-resolution clock. Thresholds wait for a CI runner
 * baseline (docs/design/benchmarks.md) — nothing here gates.
 *
 * Node-side on purpose: these time the KERNEL (the browser worker path is
 * covered functionally in unit tests and by the browser timing spec).
 */

import { expect, test } from '@playwright/test';
import {
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_EXACT_MAX,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  selectionSlotMap,
  type CorpusSnapshotV1,
  type NumericOccurrences,
  type ResolvedSelection,
} from '@texttrends/core';

function syntheticWorld(tokens: number) {
  const snapshot = { id: 'snap', docs: [{ doc: 'a', tokenCount: tokens }] } as unknown as CorpusSnapshotV1;
  const selection = { spec: { docs: ['a'] }, hash: 'sel' } as unknown as ResolvedSelection;
  return { snapshot, selection, slotMap: selectionSlotMap(snapshot, selection) };
}

function syntheticOcc(n: number, extent: number): NumericOccurrences {
  const pos = new Uint32Array(n);
  for (let i = 0; i < n; i++) pos[i] = Math.floor((i * extent) / n);
  return {
    snapshot: 'snap',
    selection: 'sel',
    docOrdinal: new Uint32Array(n),
    pos,
    spanTokens: new Uint32Array(n).fill(1),
    memberOffsets: new Uint32Array(n + 1),
    memberOrdinals: new Uint32Array(n),
  } as unknown as NumericOccurrences;
}

/** Median of `runs` samples after `warmups` warmups, in ms (hrtime). */
async function measure(warmups: number, runs: number, fn: () => Promise<void> | void): Promise<number> {
  for (let i = 0; i < warmups; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

test('record dispersion packing medians: rare / 50k-exact boundary / 1M dense (non-gating)', async ({}, testInfo) => {
  const EXTENT = 1_000_000;
  const { snapshot, selection, slotMap } = syntheticWorld(EXTENT);
  const geometry = planDispersionGeometry(snapshot, selection);

  const rare = syntheticOcc(10, EXTENT);
  const boundary = syntheticOcc(DISPERSION_EXACT_MAX, EXTENT); // exactly 50k → EXACT representation
  const dense = syntheticOcc(1_000_000, EXTENT);

  const record = {
    method: 'dispersion/1',
    policy: { exactMax: DISPERSION_EXACT_MAX, bucketBudget: DISPERSION_BUCKET_BUDGET },
    samples: { warmups: 2, runs: 7, statistic: 'median' },
    rareExact10Ms: await measure(2, 7, () => void packExactTrack(rare, slotMap, 1)),
    boundaryExact50kMs: await measure(2, 7, () => void packExactTrack(boundary, slotMap, 1)),
    dense1MDensityMs: await measure(2, 7, async () => void await packDensityTrack(dense, geometry, slotMap, async () => undefined)),
    at: new Date().toISOString(),
  };
  await testInfo.attach('dispersion-bench.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });
  console.log(`[bench] dispersion rare ${record.rareExact10Ms.toFixed(2)}ms · 50k exact ${record.boundaryExact50kMs.toFixed(2)}ms · 1M density ${record.dense1MDensityMs.toFixed(2)}ms`);
  // Non-gating: assert only that the measurements exist and are finite.
  expect(Number.isFinite(record.rareExact10Ms)).toBe(true);
  expect(Number.isFinite(record.boundaryExact50kMs)).toBe(true);
  expect(Number.isFinite(record.dense1MDensityMs)).toBe(true);
});
