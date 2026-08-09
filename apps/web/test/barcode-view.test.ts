/**
 * Pure barcode view-model (slice-2 commit D): dispersion results → token-
 * space draw segments. Canvas/pixel projection is the component's job (it
 * shares the trend chart's scales); honesty rules live HERE and are pinned.
 */
import { describe, expect, it } from 'vitest';
import type { DispersionResultV1 } from '@texttrends/core';
import {
  barcodeReaderActivation,
  barcodeReaderTarget,
  barcodeTracks,
  bucketActivationAt,
  buildBarcodeSnapIndexes,
  captureBarcodePointerTarget,
  kwicCaptionText,
  orderTracks,
  resolveCapturedBarcodeTarget,
  selectedBarcodeTotalText,
  snapBarcodeIndex,
  stepTarget,
  trackSummaryText,
} from '../src/lib/barcode-view.ts';

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

  it('buckets the same ticks by their carried document order', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(track!.docOrder).toEqual(['a', 'b']);
    expect(track!.segmentsByDocOrdinal.map((bucket) => bucket.length)).toEqual([2, 1]);
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
    expect(track!.segmentsByDocOrdinal).toHaveLength(1);
  });

  it('a density track without geometry is an invariant fault, never a silent empty strip', () => {
    const broken = { ...densityResult(), geometry: null };
    expect(() => barcodeTracks(broken, ['a'])).toThrow(/geometry/);
  });
});

describe('bucketActivationAt — density token-space authority', () => {
  it('density: a covering cell resolves to its bucket MIDPOINT with kind bucket (never an occurrence)', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(bucketActivationAt(track!, 'a', 60)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 });
    expect(bucketActivationAt(track!, 'a', 30)).toBeNull(); // the zero bucket paints (and resolves) nothing
    const [exact] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(bucketActivationAt(exact!, 'a', 4)).toBeNull();
  });
});

describe('exact barcode hover snapping', () => {
  it('snaps inclusively within eight pixels of the painted interval and stays raw beyond it', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    const [index] = buildBarcodeSnapIndexes(track!);
    const edgeX = (_d: number, token: number) => token * 10;
    expect(snapBarcodeIndex(index!, 32, edgeX)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
    expect(snapBarcodeIndex(index!, 31.9, edgeX)).toBeNull();
    expect(snapBarcodeIndex(index!, 58, edgeX)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
    expect(snapBarcodeIndex(index!, 58.1, edgeX)).toBeNull();
  });

  it('uses painted-on-top overlap ties and earlier starts for equal non-covering distances', () => {
    const [overlap] = barcodeTracks({
      method: 'dispersion/1', geometry: null,
      tracks: [{
        seriesId: 's1', groupId: 'g1', total: 3,
        data: {
          kind: 'exact',
          docOffsets: Uint32Array.from([0, 3]),
          starts: Uint32Array.from([4, 6, 10]),
          spanTokens: Uint32Array.from([4, 1, 1]),
        },
      }],
    }, ['a']);
    const [index] = buildBarcodeSnapIndexes(overlap!);
    const edgeX = (_d: number, token: number) => token * 10;
    expect(snapBarcodeIndex(index!, 65, edgeX)).toEqual({ kind: 'occurrence', doc: 'a', token: 6 });
    expect(snapBarcodeIndex(index!, 90, edgeX, 20)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
  });

  it('preserves the one-pixel painted minimum under a compressed scale', () => {
    const [track] = barcodeTracks({
      method: 'dispersion/1', geometry: null,
      tracks: [{
        seriesId: 's1', groupId: 'g1', total: 1,
        data: {
          kind: 'exact',
          docOffsets: Uint32Array.from([0, 1]),
          starts: Uint32Array.from([4]),
          spanTokens: Uint32Array.from([1]),
        },
      }],
    }, ['a']);
    const [index] = buildBarcodeSnapIndexes(track!);
    const compressedEdge = (_d: number, token: number) => token / 2;
    expect(snapBarcodeIndex(index!, 11, compressedEdge)).toEqual({
      kind: 'occurrence', doc: 'a', token: 4,
    });
    expect(snapBarcodeIndex(index!, 11.001, compressedEdge)).toBeNull();
  });

  it('projects logarithmic probes and nearby candidates rather than every entry', () => {
    const count = 4_096;
    const starts = Uint32Array.from({ length: count }, (_, i) => i * 10);
    const [track] = barcodeTracks({
      method: 'dispersion/1', geometry: null,
      tracks: [{
        seriesId: 's1', groupId: 'g1', total: count,
        data: {
          kind: 'exact',
          docOffsets: Uint32Array.from([0, count]),
          starts,
          spanTokens: new Uint32Array(count).fill(1),
        },
      }],
    }, ['a']);
    const [index] = buildBarcodeSnapIndexes(track!);
    let projections = 0;
    const edgeX = (_d: number, token: number) => {
      projections += 1;
      return token * 2;
    };
    expect(snapBarcodeIndex(index!, starts[count - 1]! * 2, edgeX)).toEqual({
      kind: 'occurrence', doc: 'a', token: starts[count - 1],
    });
    expect(projections).toBeLessThan(100);
  });

  it('never builds a snap index for density aggregates', () => {
    const [dense] = barcodeTracks(densityResult(), ['a']);
    expect(buildBarcodeSnapIndexes(dense!)).toEqual([null]);
  });

  it('builds every document lane in one pass without crossing document identity', () => {
    const [exact] = barcodeTracks(exactResult(), ['a', 'b']);
    const indexes = buildBarcodeSnapIndexes(exact!);
    const edgeX = (d: number, token: number) => d * 1000 + token * 10;
    expect(snapBarcodeIndex(indexes[0]!, 1010, edgeX, 50)).toBeNull();
    expect(snapBarcodeIndex(indexes[1]!, 1010, edgeX, 0)).toEqual({ kind: 'occurrence', doc: 'b', token: 1 });
  });
});

describe('stepTarget — keyboard evidence walking for BOTH representations', () => {
  it('exact: steps ticks relative to the center; edges saturate to first/last', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(stepTarget(track!, null, 1)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
    expect(stepTarget(track!, { doc: 'a', token: 4 }, 1)).toEqual({ kind: 'occurrence', doc: 'a', token: 9 });
    expect(stepTarget(track!, { doc: 'a', token: 9 }, 1)).toEqual({ kind: 'occurrence', doc: 'b', token: 1 }); // crosses docs in reading order
    expect(stepTarget(track!, { doc: 'a', token: 4 }, -1)).toEqual({ kind: 'occurrence', doc: 'a', token: 4 }); // saturates at first
  });

  it('treats a center outside the track document order as an unpositioned edge', () => {
    const [track] = barcodeTracks(exactResult(), ['a', 'b']);
    expect(stepTarget(track!, { doc: 'missing', token: 7 }, 1))
      .toEqual({ kind: 'occurrence', doc: 'a', token: 4 });
    expect(stepTarget(track!, { doc: 'missing', token: 7 }, -1))
      .toEqual({ kind: 'occurrence', doc: 'b', token: 1 });
  });

  it('density: steps NONZERO bucket midpoints with kind bucket', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(stepTarget(track!, null, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
    expect(stepTarget(track!, { doc: 'a', token: 12 }, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 }); // the zero bucket is skipped
    expect(stepTarget(track!, { doc: 'a', token: 62 }, -1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
  });
});

describe('bucket-count provenance and announced text (review-D round 2)', () => {
  it('density activation and stepping carry the bucket HIT COUNT', () => {
    const [track] = barcodeTracks(densityResult(), ['a']);
    expect(bucketActivationAt(track!, 'a', 60)).toEqual({ kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 });
    expect(stepTarget(track!, null, 1)).toEqual({ kind: 'bucket', doc: 'a', token: 12, bucketCount: 10 });
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

  it('never reports a fabricated selected zero while detail is pending or failed', () => {
    expect(selectedBarcodeTotalText('pending', undefined)).toBe('…');
    expect(selectedBarcodeTotalText('error', undefined)).toBe('error');
    expect(selectedBarcodeTotalText('ready', undefined)).toBe('0');
    expect(selectedBarcodeTotalText('ready', 12)).toBe('12');
  });
});

describe('orderTracks — the resident strip follows a query-free reorder', () => {
  it('sorts by the CURRENT series order; unknown ids trail in result order', () => {
    const a = { seriesId: 'sA', groupId: 'g', representation: 'exact' as const, total: 0, docOrder: [], segments: [], segmentsByDocOrdinal: [] };
    const b = { ...a, seriesId: 'sB' };
    const c = { ...a, seriesId: 'sC' };
    expect(orderTracks([a, b], ['sB', 'sA']).map((t) => t.seriesId)).toEqual(['sB', 'sA']);
    expect(orderTracks([a, b, c], ['sC', 'sA']).map((t) => t.seriesId)).toEqual(['sC', 'sA', 'sB']);
  });
});

describe('captured barcode identity', () => {
  it('captures the shared exact snap and density raw target before resolving either barcode', () => {
    const exactTracks = barcodeTracks(exactResult(), ['a', 'b']);
    const exactIndexes = exactTracks.map((track) => buildBarcodeSnapIndexes(track));
    const exact = captureBarcodePointerTarget(
      exactTracks,
      exactIndexes,
      { trackRow: 0, docOrdinal: 0, doc: 'a', rawToken: 3, px: 32 },
      (_d, token) => token * 10,
    );
    expect(exact).toEqual({
      trackId: 's1',
      doc: 'a',
      rawToken: 3,
      exactActivation: { kind: 'occurrence', doc: 'a', token: 4 },
    });
    expect(resolveCapturedBarcodeTarget(exactTracks, exact!)).toMatchObject({
      kind: 'activation',
      activation: { kind: 'occurrence', doc: 'a', token: 4 },
    });
    expect(barcodeReaderActivation(exact!.exactActivation)).toEqual({
      kind: 'occurrence',
      doc: 'a',
      token: 4,
    });
    const unsnappedExact = captureBarcodePointerTarget(
      exactTracks,
      exactIndexes,
      { trackRow: 0, docOrdinal: 0, doc: 'a', rawToken: 3, px: 32 },
      (_d, token) => token * 10,
      false,
    );
    expect(unsnappedExact?.exactActivation).toBeNull();
    expect(resolveCapturedBarcodeTarget(exactTracks, unsnappedExact!)).toEqual({
      kind: 'scrub',
      doc: 'a',
      token: 3,
    });

    const densityTracks = barcodeTracks(densityResult(), ['a']);
    const densityWithSnap = captureBarcodePointerTarget(
      densityTracks,
      [],
      { trackRow: 0, docOrdinal: 0, doc: 'a', rawToken: 60, px: 60 },
      (_d, token) => token,
    );
    expect(densityWithSnap?.exactActivation).toBeNull();
    const density = captureBarcodePointerTarget(
      densityTracks,
      [],
      { trackRow: 0, docOrdinal: 0, doc: 'a', rawToken: 60, px: 60 },
      (_d, token) => token,
      false,
    );
    const densityResolution = resolveCapturedBarcodeTarget(densityTracks, density!);
    expect(densityResolution).toMatchObject({
      kind: 'activation',
      activation: { kind: 'bucket', doc: 'a', token: 62, bucketCount: 30 },
    });
    expect(barcodeReaderActivation(
      densityResolution.kind === 'activation' ? densityResolution.activation : null,
    )).toBeNull();
    expect(barcodeReaderTarget(densityResolution, { doc: 'a', token: 60 })).toEqual({
      doc: 'a',
      token: 60,
    });
    expect(barcodeReaderTarget(
      resolveCapturedBarcodeTarget(exactTracks, exact!),
      { doc: 'a', token: 3 },
    )).toMatchObject({ doc: 'a', token: 4 });
    expect(barcodeReaderTarget(
      resolveCapturedBarcodeTarget(exactTracks, unsnappedExact!),
      { doc: 'a', token: 99 },
    )).toEqual({ doc: 'a', token: 3 });
    expect(barcodeReaderTarget(null, { doc: 'a', token: 7 })).toEqual({
      doc: 'a',
      token: 7,
    });
  });

  it('rejects a document ordinal that does not belong to the rendered track', () => {
    const tracks = barcodeTracks(exactResult(), ['a', 'b']);
    expect(captureBarcodePointerTarget(
      tracks,
      tracks.map((track) => buildBarcodeSnapIndexes(track)),
      { trackRow: 0, docOrdinal: 0, doc: 'b', rawToken: 1, px: 10 },
      (_d, token) => token * 10,
    )).toBeNull();
  });

  it('resolves by the pointer-down series id after rows reorder', () => {
    const [wolf] = barcodeTracks(exactResult(), ['a', 'b']);
    const fox = { ...wolf!, seriesId: 'fox', groupId: 'fox' };
    const resolution = resolveCapturedBarcodeTarget([fox, wolf!], {
      trackId: 's1',
      doc: 'a',
      rawToken: 4,
      exactActivation: { kind: 'occurrence', doc: 'a', token: 4 },
    });
    expect(resolution).toEqual({
      kind: 'activation',
      track: wolf,
      activation: { kind: 'occurrence', doc: 'a', token: 4 },
    });
  });

  it('falls back to the captured raw position when the series disappeared', () => {
    expect(resolveCapturedBarcodeTarget([], {
      trackId: 'gone',
      doc: 'a',
      rawToken: 7,
      exactActivation: { kind: 'occurrence', doc: 'a', token: 9 },
    })).toEqual({ kind: 'scrub', doc: 'a', token: 7 });
  });
});
