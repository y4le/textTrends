/**
 * Pure barcode view-model (slice-2 commit D): dispersion results → token-
 * space draw segments. Canvas/pixel projection is the component's job (it
 * shares the trend chart's scales); honesty rules live HERE and are pinned.
 */
import { describe, expect, it } from 'vitest';
import type { DispersionResultV1 } from '@texttrends/core';
import { barcodeTracks, kwicCaptionText, orderTracks, resolveBarcodeActivation, stepTarget, tickAtToken, trackSummaryText } from '../src/lib/barcode-view.ts';

const exactResult = (): DispersionResultV1 => ({
  method: 'dispersion/1',
  geometry: null,
  tracks: [{
    seriesId: 's1',
    groupId: 'g1',
    total: 3,
    data: {
      kind: 'exact',
      docOffsets: Uint32Array.from([0, 2, 3]),
      starts: Uint32Array.from([4, 9, 1]),
      spanTokens: Uint32Array.from([1, 2, 1]),
    },
  }],
});

const densityResult = (): DispersionResultV1 => ({
  method: 'dispersion/1',
  geometry: {
    order: ['a'],
    docTokenCount: Uint32Array.from([100]),
    bucketOffsets: Uint32Array.from([0, 4]),
    bucketStartToken: Uint32Array.from([0, 25, 50, 75]),
  },
  tracks: [{
    seriesId: 's1',
    groupId: 'g1',
    total: 60_000,
    data: { kind: 'density', counts: Uint32Array.from([10, 0, 30, 20]) },
  }],
});

describe('barcodeTracks — exact', () => {
  it('maps CSR occurrences to per-doc ticks with spans and click ordinals', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(track!.representation).toBe('exact');
    expect(track!.total).toBe(3);
    expect(track!.segments).toEqual([
      { kind: 'tick', doc: 'a', t0: 4, t1: 5, ordinal: 0 },
      { kind: 'tick', doc: 'a', t0: 9, t1: 11, ordinal: 1 }, // phrase span kept
      { kind: 'tick', doc: 'b', t0: 1, t1: 2, ordinal: 2 },
    ]);
  });

  it('tickAtToken resolves the covering occurrence for click-through, null outside', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(tickAtToken(track!, 'a', 10)!.ordinal).toBe(1); // inside the phrase span
    expect(tickAtToken(track!, 'a', 4)!.ordinal).toBe(0);
    expect(tickAtToken(track!, 'a', 50)).toBeNull();
    expect(tickAtToken(track!, 'b', 4)).toBeNull(); // wrong doc
  });
});

describe('barcodeTracks — density', () => {
  it('emits labeled cells with honest counts, normalized intensity, and midpoints; zero buckets paint nothing', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(track!.representation).toBe('density');
    const cells = track!.segments;
    expect(cells).toHaveLength(3); // the zero bucket is omitted
    expect(cells[0]).toEqual({ kind: 'cell', doc: 'a', t0: 0, t1: 25, count: 10, intensity: 10 / 30, midToken: 12 });
    expect(cells[1]).toEqual({ kind: 'cell', doc: 'a', t0: 50, t1: 75, count: 30, intensity: 1, midToken: 62 });
    expect(cells[2]).toEqual({ kind: 'cell', doc: 'a', t0: 75, t1: 100, count: 20, intensity: 20 / 30, midToken: 87 });
    // A density track never yields tick click-throughs.
    expect(tickAtToken(track!, 'a', 60)).toBeNull();
  });

  it('a density track without geometry is an invariant fault, never a silent empty strip', () => {
    const broken = { ...densityResult(), geometry: null };
    expect(() => barcodeTracks(broken, ['a'])).toThrow(/geometry/);
  });
});

describe('resolveBarcodeActivation — the ONE authoritative click/keyboard resolver', () => {
  it('OVERLAP REGRESSION (review-D): a later tick inside an earlier phrase span wins its own token', () => {
    // countOverlaps=true: phrase [dire wolf] at 9..11 AND token wolf at 10.
    // Clicking token 10 must center the LATER-start covering occurrence
    // (wolf@10, painted on top), never the phrase start.
    const result: DispersionResultV1 = {
      method: 'dispersion/1',
      geometry: null,
      tracks: [{
        seriesId: 's1', groupId: 'g1', total: 2,
        data: {
          kind: 'exact',
          docOffsets: Uint32Array.from([0, 2]),
          starts: Uint32Array.from([9, 10]),
          spanTokens: Uint32Array.from([2, 1]),
        },
      }],
    };
    const [track] = barcodeTracks(result, ['a']);
    expect(resolveBarcodeActivation(track!, 'a', 10)).toEqual({ kind: 'occurrence', doc: 'a', token: 10 });
    // Token 9 is covered only by the phrase → the phrase start.
    expect(resolveBarcodeActivation(track!, 'a', 9)).toEqual({ kind: 'occurrence', doc: 'a', token: 9 });
  });

  it('dead-space clicks center the NEAREST tick (earlier wins an exact tie)', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(resolveBarcodeActivation(track!, 'a', 6)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 }); // 6 is 2 from 4, 3 from 9
    expect(resolveBarcodeActivation(track!, 'b', 40)).toEqual({ kind: 'occurrence', doc: 'b', token: 1 });
    expect(resolveBarcodeActivation(track!, 'zz', 1)).toBeNull();
  });

  it('density: a covering cell resolves to its bucket MIDPOINT with kind bucket (never an occurrence)', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(resolveBarcodeActivation(track!, 'a', 60)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 });
    expect(resolveBarcodeActivation(track!, 'a', 30)).toBeNull(); // the zero bucket paints (and resolves) nothing
  });
});

describe('stepTarget — keyboard evidence walking for BOTH representations', () => {
  it('exact: steps ticks relative to the center; edges saturate to first/last', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(stepTarget(track!, ['a', 'b'], null, 1)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
    expect(stepTarget(track!, ['a', 'b'], { doc: 'a', token: 4 }, 1)).toEqual({ kind: 'occurrence', doc: 'a', token: 9 });
    expect(stepTarget(track!, ['a', 'b'], { doc: 'a', token: 9 }, 1)).toEqual({ kind: 'occurrence', doc: 'b', token: 1 }); // crosses docs in reading order
    expect(stepTarget(track!, ['a', 'b'], { doc: 'a', token: 4 }, -1)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 }); // saturates at first
  });

  it('density: steps NONZERO bucket midpoints with kind bucket', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(stepTarget(track!, ['a'], null, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
    expect(stepTarget(track!, ['a'], { doc: 'a', token: 12 }, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 }); // the zero bucket is skipped
    expect(stepTarget(track!, ['a'], { doc: 'a', token: 62 }, -1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
  });
});

describe('bucket-count provenance and announced text (review-D round 2)', () => {
  it('density activation and stepping carry the bucket HIT COUNT', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(resolveBarcodeActivation(track!, 'a', 60)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 });
    expect(stepTarget(track!, ['a'], null, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
  });

  it('kwicCaptionText announces the bucket count and the first-hit distance', () => {
    const titleOf = (d: string) => `book-${d}`;
    expect(kwicCaptionText(null, null, titleOf)).toBe('reading order');
    expect(kwicCaptionText({ doc: 'a', token: 41 }, 41, titleOf)).toBe('nearest to book-a · token 42');
    expect(kwicCaptionText({ doc: 'a', token: 61, origin: 'bucket', bucketCount: 30 }, 61, titleOf))
      .toBe('nearest occurrence to this bucket (30 hits in this bucket) · book-a · token 62');
    expect(kwicCaptionText({ doc: 'a', token: 61, origin: 'bucket', bucketCount: 1 }, 75, titleOf))
      .toBe('nearest occurrence to this bucket (1 hit in this bucket) · book-a · token 62 · first hit 14 tokens away');
  });

  it('trackSummaryText names density buckets; exact stays plain', () => {
    const [dense] = barcodeTracks(densityResult(), ['a']);
    expect(trackSummaryText(dense!, 'wolf')).toBe('wolf: 60,000 occurrences in 3 density buckets');
    const [exact] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(trackSummaryText(exact!, 'wolf')).toBe('wolf: 3 occurrences');
  });
});

describe('orderTracks — the resident strip follows a query-free reorder', () => {
  it('sorts by the CURRENT series order; unknown ids trail in result order', () => {
    const a = { seriesId: 'sA', groupId: 'g', representation: 'exact' as const, total: 0, segments: [] };
    const b = { ...a, seriesId: 'sB' };
    const c = { ...a, seriesId: 'sC' };
    expect(orderTracks([a, b], ['sB', 'sA']).map((t) => t.seriesId)).toEqual(['sB', 'sA']);
    expect(orderTracks([a, b, c], ['sC', 'sA']).map((t) => t.seriesId)).toEqual(['sC', 'sA', 'sB']);
  });
});
