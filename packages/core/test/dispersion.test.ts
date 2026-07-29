/**
 * dispersion/1 kernel invariants (slice-2 ruling §C): totals equal the
 * source occurrences; exact arrays preserve order/multiplicity/span; density
 * bucket sums equal totals; bucket geometry covers each selected document
 * without overlap or gap; output is bounded; packing checkpoints fire.
 * The kernel consumes NumericOccurrences verbatim, so synthetic inputs are
 * exact — no corpus needed.
 */
import { describe, expect, it } from 'vitest';
import type { CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import type { ResolvedSelection } from '../src/snapshot/selection.ts';
import type { NumericOccurrences } from '../src/ops/occurrences.ts';
import {
  DISPERSION_BUCKET_BUDGET,
  DISPERSION_PACK_CHUNK,
  dispersionTransferBuffers,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  selectionSlotMap,
} from '../src/ops/dispersion.ts';

function world(docTokens: Record<string, number>, selected?: readonly string[]) {
  const order = Object.keys(docTokens);
  const snapshot = {
    id: 'snap',
    docs: order.map((doc) => ({ doc, tokenCount: docTokens[doc] })),
  } as unknown as CorpusSnapshotV1;
  const selection = { spec: { docs: selected ?? order }, hash: 'sel' } as unknown as ResolvedSelection;
  return { snapshot, selection, slotMap: selectionSlotMap(snapshot, selection) };
}

const identityMap = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

function occOf(rows: readonly [doc: number, pos: number, span?: number][]): NumericOccurrences {
  return {
    snapshot: 'snap',
    selection: 'sel',
    docOrdinal: Uint32Array.from(rows.map((r) => r[0])),
    pos: Uint32Array.from(rows.map((r) => r[1])),
    spanTokens: Uint32Array.from(rows.map((r) => r[2] ?? 1)),
    memberOffsets: new Uint32Array(rows.length + 1),
    memberOrdinals: new Uint32Array(rows.length),
  } as unknown as NumericOccurrences;
}

describe('planDispersionGeometry', () => {
  it('covers every selected document without overlap or gap, ≥1 bucket per nonempty doc, token-proportional remainder', () => {
    const { snapshot, selection } = world({ a: 1000, b: 100, c: 0, d: 10 });
    const g = planDispersionGeometry(snapshot, selection);
    expect(g.order).toEqual(['a', 'b', 'c', 'd']);
    expect([...g.docTokenCount]).toEqual([1000, 100, 0, 10]);
    // Total buckets bounded by the budget; empty doc c carries zero buckets.
    const total = g.bucketOffsets[g.bucketOffsets.length - 1]!;
    expect(total).toBeLessThanOrEqual(DISPERSION_BUCKET_BUDGET);
    expect(g.bucketOffsets[3]).toBe(g.bucketOffsets[2]); // c: no buckets
    // Coverage per doc: first bucket starts at 0, starts strictly increase,
    // and the implicit last edge is the doc extent — no overlap, no gap.
    for (let d = 0; d < g.order.length; d++) {
      const from = g.bucketOffsets[d]!, to = g.bucketOffsets[d + 1]!;
      if (to === from) continue;
      expect(g.bucketStartToken[from]).toBe(0);
      for (let b = from + 1; b < to; b++) {
        expect(g.bucketStartToken[b]!).toBeGreaterThan(g.bucketStartToken[b - 1]!);
        expect(g.bucketStartToken[b]!).toBeLessThan(g.docTokenCount[d]!);
      }
    }
    // Token-proportional: doc a (1000 tokens) gets ~10x doc b (100 tokens).
    const bucketsOf = (d: number) => g.bucketOffsets[d + 1]! - g.bucketOffsets[d]!;
    expect(bucketsOf(0)).toBeGreaterThan(bucketsOf(1) * 5);
    // A tiny doc never carries more buckets than tokens.
    expect(bucketsOf(3)).toBeLessThanOrEqual(10);
  });

  it('rejects a selection doc missing from the snapshot', () => {
    const { snapshot } = world({ a: 10 });
    const selection = { spec: { docs: ['zz'] }, hash: 'sel' } as unknown as ResolvedSelection;
    expect(() => planDispersionGeometry(snapshot, selection)).toThrow(/not a member/);
  });
});

describe('packExactTrack', () => {
  it('preserves order, multiplicity, and span verbatim in fresh CSR arrays', () => {
    const occ = occOf([[0, 5], [0, 5], [0, 9, 2], [2, 1]]); // duplicate start kept; doc 1 empty
    const t = packExactTrack(occ, identityMap(3), 3);
    expect(t.kind).toBe('exact');
    if (t.kind !== 'exact') return;
    expect([...t.docOffsets]).toEqual([0, 3, 3, 4]);
    expect([...t.starts]).toEqual([5, 5, 9, 1]);
    expect([...t.spanTokens]).toEqual([1, 1, 2, 1]);
    // FRESH buffers — transferring them cannot detach the source's.
    expect(t.starts.buffer).not.toBe(occ.pos.buffer);
    expect(t.spanTokens.buffer).not.toBe(occ.spanTokens.buffer);
  });
});

describe('packDensityTrack', () => {
  it('bucket sums equal the exact total; counts land in the covering bucket', async () => {
    const { snapshot, selection } = world({ a: 100, b: 50 });
    const g = planDispersionGeometry(snapshot, selection);
    const occ = occOf([[0, 0], [0, 99], [0, 50], [1, 0], [1, 49]]);
    const t = await packDensityTrack(occ, g, identityMap(2), async () => undefined);
    if (t.kind !== 'density') throw new Error('expected density');
    const sum = [...t.counts].reduce((s, c) => s + c, 0);
    expect(sum).toBe(occ.pos.length); // HONEST: nothing sampled or dropped
    // The first bucket of doc a holds pos 0; the last holds pos 99.
    const aFrom = g.bucketOffsets[0]!, aTo = g.bucketOffsets[1]!;
    expect(t.counts[aFrom]!).toBeGreaterThanOrEqual(1);
    expect(t.counts[aTo - 1]!).toBeGreaterThanOrEqual(1);
  });

  it('awaits the injected checkpoint every DISPERSION_PACK_CHUNK occurrences (cancellation discipline)', async () => {
    const { snapshot, selection } = world({ a: 10 });
    const g = planDispersionGeometry(snapshot, selection);
    const n = DISPERSION_PACK_CHUNK * 2 + 5;
    const rows: [number, number][] = Array.from({ length: n }, () => [0, 3]);
    const occ = occOf(rows);
    let checkpoints = 0;
    await packDensityTrack(occ, g, identityMap(1), async () => { checkpoints++; });
    expect(checkpoints).toBe(2);
    // And a checkpoint that throws (cancel) unwinds the pack.
    await expect(packDensityTrack(occ, g, identityMap(1), async () => { throw new Error('CANCELLED'); })).rejects.toThrow('CANCELLED');
  });
});

describe('dispersionTransferBuffers', () => {
  it('collects every fresh buffer exactly once (geometry + per-track)', async () => {
    const { snapshot, selection } = world({ a: 100 });
    const g = planDispersionGeometry(snapshot, selection);
    const exact = packExactTrack(occOf([[0, 1]]), identityMap(1), 1);
    const density = await packDensityTrack(occOf([[0, 2]]), g, identityMap(1), async () => undefined);
    const result = {
      method: 'dispersion/1' as const,
      geometry: g,
      tracks: [
        { seriesId: 's1', groupId: 'g1', total: 1, data: exact },
        { seriesId: 's2', groupId: 'g2', total: 1, data: density },
      ],
    };
    const buffers = dispersionTransferBuffers(result);
    expect(buffers.length).toBe(3 + 3 + 1);
    expect(new Set(buffers).size).toBe(buffers.length); // no duplicates
  });
});

describe('SUBSET selections — snapshot ordinals map to selection slots (review-C round 1, HIGH)', () => {
  it('exact: an occurrence in snapshot doc 1 lands in selection slot 0 when only that doc is selected', () => {
    const { snapshot, selection, slotMap } = world({ a: 100, b: 100 }, ['b']);
    expect([...slotMap]).toEqual([-1, 0]);
    const occ = occOf([[1, 7], [1, 9]]); // snapshot ordinal 1 = doc b
    const t = packExactTrack(occ, slotMap, selection.spec.docs.length);
    if (t.kind !== 'exact') throw new Error('expected exact');
    expect([...t.docOffsets]).toEqual([0, 2]); // BOTH occurrences in slot 0
    expect([...t.starts]).toEqual([7, 9]);
    void snapshot;
  });

  it('density: subset counts land inside the selected geometry and sum to the total', async () => {
    const { snapshot, selection, slotMap } = world({ a: 100, b: 50 }, ['b']);
    const g = planDispersionGeometry(snapshot, selection);
    expect(g.order).toEqual(['b']);
    const occ = occOf([[1, 0], [1, 49]]); // snapshot ordinal 1
    const t = await packDensityTrack(occ, g, slotMap, async () => undefined);
    if (t.kind !== 'density') throw new Error('expected density');
    expect([...t.counts].reduce((s, c) => s + c, 0)).toBe(2); // nothing lost out of bounds
  });

  it('an occurrence OUTSIDE the selection is an invariant fault, never a miscount', () => {
    const { selection, slotMap } = world({ a: 100, b: 100 }, ['b']);
    const foreign = occOf([[0, 3]]); // snapshot doc a — not selected
    expect(() => packExactTrack(foreign, slotMap, selection.spec.docs.length)).toThrow(/outside the selection/);
  });
});

describe('constrained apportionment redistributes capped budget (review-C round 1)', () => {
  it('63 one-token docs + one 4096-token doc allocate EXACTLY the budget', () => {
    const docTokens: Record<string, number> = {};
    for (let i = 0; i < 63; i++) docTokens[`t${i}`] = 1;
    docTokens.big = DISPERSION_BUCKET_BUDGET;
    const { snapshot, selection } = world(docTokens);
    const g = planDispersionGeometry(snapshot, selection);
    const total = g.bucketOffsets[g.bucketOffsets.length - 1]!;
    expect(total).toBe(DISPERSION_BUCKET_BUDGET); // freed quota redistributed
  });

  it('redistributes the CAPPED quota token-proportionally among unsaturated docs (constrained largest remainder)', () => {
    // Review-C round 2's pinned example: 62 one-token docs + 100-token +
    // 10000-token docs. After minima (64), the 4032 remaining apportion over
    // the two unsaturated docs by FULL extents: 100/10100 → 40, 10000/10100
    // → 3992; totals 41 and 3993 — NOT the order-biased 53/3981.
    const docTokens: Record<string, number> = {};
    for (let i = 0; i < 62; i++) docTokens[`t${i}`] = 1;
    docTokens.mid = 100;
    docTokens.big = 10_000;
    const { snapshot, selection } = world(docTokens);
    const g = planDispersionGeometry(snapshot, selection);
    const bucketsOf = (d: number) => g.bucketOffsets[d + 1]! - g.bucketOffsets[d]!;
    expect(bucketsOf(62)).toBe(41);  // mid
    expect(bucketsOf(63)).toBe(3993); // big
    expect(g.bucketOffsets[g.bucketOffsets.length - 1]!).toBe(DISPERSION_BUCKET_BUDGET);
  });

  it('when total selected tokens are under the budget, every token gets a bucket', () => {
    const { snapshot, selection } = world({ a: 10, b: 5 });
    const g = planDispersionGeometry(snapshot, selection);
    expect(g.bucketOffsets[g.bucketOffsets.length - 1]!).toBe(15);
  });
});
