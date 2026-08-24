import { describe, expect, it } from 'vitest';
import type { DispersionResultV1, NumericTrend } from '@texttrends/core';
import { trendGeometryFor } from '../src/lib/trend-compact.ts';
import { barcodeBandHeight, trendStageHit } from '../src/lib/trend-geometry.ts';
import {
  projectedBarcodeSnapIndexes,
  projectedBarcodeTracks,
  trendStageGeometry,
  trendStageProjection,
  trendStageSnapIndexes,
} from '../src/lib/trend-stage.ts';

const trend: NumericTrend = {
  coordinate: 'declared-sequence',
  bins: { mode: 'per-doc', count: 4 },
  order: ['a', 'b'],
  sequenceBases: [0, 10],
  docTokenCount: [10, 20],
  rowOffsets: Uint32Array.from([0, 1, 2]),
  docOrdinal: Uint32Array.from([0, 1]),
  binIndex: Uint32Array.from([0, 0]),
  binStartToken: Uint32Array.from([0, 0]),
  binTokens: Uint32Array.from([10, 20]),
  count: Uint32Array.from([1, 1]),
  ratePer10k: Float64Array.from([1, 1]),
};

const dispersion: DispersionResultV1 = {
  method: 'dispersion/1',
  geometry: null,
  tracks: [{
    seriesId: 's',
    groupId: 'g',
    total: 2,
    data: {
      kind: 'exact',
      docOffsets: Uint32Array.from([0, 1, 2]),
      starts: Uint32Array.from([2, 4]),
      spanTokens: Uint32Array.from([1, 1]),
    },
  }],
};

function projection() {
  // Deliberately no width, view, or pointer input: those belong to the second
  // stage and must not invalidate this projection on resize.
  return trendStageProjection({
    trend,
    seriesOrder: ['s'],
    dispersion,
    selectedDispersion: null,
    selectedDocs: [],
    geometry: trendGeometryFor('wide'),
  });
}

describe('trend stage projection and geometry', () => {
  it('reuses one projection identity across viewport widths', () => {
    const projected = projection();
    const narrow = trendStageGeometry(projected, {
      plotWidth: 300,
      view: 'series',
    });
    const wide = trendStageGeometry(projected, {
      plotWidth: 600,
      view: 'series',
    });
    const snapIndexes = trendStageSnapIndexes(projected);

    expect(narrow.projection).toBe(projected);
    expect(wide.projection).toBe(projected);
    expect(narrow.projection.tracks).toBe(wide.projection.tracks);
    expect(projected.docs).toEqual(['a', 'b']);
    expect(projected.layout.totalTokens).toBe(30);
    expect(projected.tracks[0]?.docOrder).toEqual(projected.docs);
    expect(projected.tracks[0]?.segmentsByDocOrdinal.map((bucket) => bucket.length)).toEqual([1, 1]);
    expect(narrow.edgeX(1, 0)).toBe(100);
    expect(wide.edgeX(1, 0)).toBe(200);
    expect(snapIndexes[0]?.[0]?.entries[0]).toMatchObject({ t0: 2, t1: 3 });
    expect(narrow.hitSpec).toMatchObject({ view: 'series', plotWidth: 300, layout: projected.layout });
  });

  it('keeps by-book viewport geometry separate from interaction indexes', () => {
    const projected = projection();
    const stage = trendStageGeometry(projected, {
      plotWidth: 240,
      view: 'by-book',
    });
    expect(stage.projection).toBe(projected);
    expect('snapIndexes' in projected).toBe(false);
    expect('snapIndexes' in stage).toBe(false);
    expect(stage.hitSpec).toMatchObject({
      view: 'by-book',
      plotWidth: 240,
      tokenCounts: projected.tokenCounts,
      rowDomain: projected.tokenCounts,
    });
  });

  it('gives to-scale rows one shared token domain without changing their extents', () => {
    const projected = projection();
    const stage = trendStageGeometry(projected, {
      plotWidth: 240,
      view: 'by-book-scaled',
    });
    expect(stage.rowDomain).toEqual([20, 20]);
    expect(stage.hitSpec).toMatchObject({
      view: 'by-book-scaled',
      tokenCounts: [10, 20],
      rowDomain: [20, 20],
    });
    expect(stage.edgeX(0, 10)).toBe(120);
    expect(stage.edgeX(1, 10)).toBe(120);
  });

  it('projects selected dispersion across every selected book', () => {
    const projected = trendStageProjection({
      trend,
      seriesOrder: ['s'],
      dispersion,
      selectedDispersion: dispersion,
      selectedDocs: ['a', 'b'],
      geometry: trendGeometryFor('wide'),
    });
    expect(projected.selectedTracks[0]?.docOrder).toEqual(['a', 'b']);
    expect(projected.selectedTracks[0]?.segmentsByDocOrdinal.map((bucket) => bucket.length))
      .toEqual([1, 1]);
  });

  it('reserves durable barcode rows while exposing one full-height overlay lane', () => {
    const geometry = trendGeometryFor('wide');
    const projected = trendStageProjection({
      trend,
      seriesOrder: ['s'],
      dispersion,
      selectedDispersion: null,
      selectedDocs: [],
      geometry,
      reservedTrackCount: 3,
      foregroundBarcodeOverlay: true,
    });
    const stage = trendStageGeometry(projected, { plotWidth: 300, view: 'series' });
    const expectedHeight = barcodeBandHeight(
      3,
      geometry.barcodeTrackHeight,
      geometry.barcodeTrackGap,
    );
    expect(projected.barcodeHeight).toBe(expectedHeight);
    expect(stage.hitSpec).toMatchObject({
      barcodeHeight: expectedHeight,
      band: { trackCount: 1, trackHeight: expectedHeight, trackGap: 0 },
    });
    expect(trendStageHit(
      100,
      geometry.seriesHeight + geometry.barcodeBandGap + expectedHeight - 0.1,
      stage.hitSpec,
      'locate',
    )).toMatchObject({ zone: 'barcode', trackRow: 0 });
  });

  it('shares barcode projections and snap indexes across consumers', () => {
    const first = projectedBarcodeTracks(dispersion, ['a', 'b'], ['s']);
    const second = projectedBarcodeTracks(dispersion, ['a', 'b'], ['s']);
    expect(second).toBe(first);
    expect(projectedBarcodeSnapIndexes(second)).toBe(projectedBarcodeSnapIndexes(first));
    expect(projectedBarcodeTracks(dispersion, ['b', 'a'], ['s'])).not.toBe(first);
  });

});
