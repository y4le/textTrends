import { describe, expect, it } from 'vitest';
import type { DispersionResultV1 } from '@texttrends/core';
import { barcodeTracks } from '../src/lib/barcode-view.ts';
import {
  ATLAS_MAX_DEVICE_ROWS,
  atlasCanvasWindow,
  atlasColumns,
  atlasDensityResolution,
  atlasDensitySummary,
  atlasDeviceRows,
  atlasLayout,
  atlasRowOpacity,
  atlasTokenAtY,
  atlasYForToken,
} from '../src/lib/reader-atlas.ts';

const exactResult = (): DispersionResultV1 => ({
  method: 'dispersion/1',
  geometry: null,
  tracks: [{
    seriesId: 'term',
    groupId: 'group',
    total: 3,
    data: {
      kind: 'exact',
      docOffsets: Uint32Array.from([0, 2, 3]),
      starts: Uint32Array.from([10, 40, 5]),
      spanTokens: Uint32Array.from([1, 2, 1]),
    },
  }],
});

const densityResult = (): DispersionResultV1 => ({
  method: 'dispersion/1',
  geometry: {
    order: ['a', 'b'],
    docTokenCount: Uint32Array.from([100, 50]),
    bucketOffsets: Uint32Array.from([0, 4, 6]),
    bucketStartToken: Uint32Array.from([0, 25, 50, 75, 0, 25]),
  },
  tracks: [{
    seriesId: 'term',
    groupId: 'group',
    total: 12,
    data: { kind: 'density', counts: Uint32Array.from([1, 0, 3, 2, 4, 2]) },
  }],
});

describe('Atlas identity projection', () => {
  it('projects exact CSR with ready order, then maps declared columns by identity', () => {
    const result = exactResult();
    const tracks = barcodeTracks(result, ['a', 'b']);
    const columns = atlasColumns(
      tracks,
      result.geometry,
      ['b', 'a'],
      new Map([['a', 100], ['b', 50]]),
    );
    expect(columns.map((column) => column.doc)).toEqual(['b', 'a']);
    expect(columns[0]!.tracks[0]).toMatchObject({
      representation: 'exact', documentTotal: 1,
    });
    expect(columns[0]!.tracks[0]!.segments).toBe(tracks[0]!.segmentsByDocOrdinal[1]);
    expect(columns[1]!.tracks[0]!.segments).toBe(tracks[0]!.segmentsByDocOrdinal[0]);
  });

  it('carries per-document density totals, actual bands, and disclosure level', () => {
    const result = densityResult();
    const [a, b] = atlasColumns(
      barcodeTracks(result, ['a', 'b']),
      result.geometry,
      ['a', 'b'],
      new Map([['a', 100], ['b', 50]]),
    );
    expect(a!.tracks[0]).toMatchObject({
      representation: 'density', documentTotal: 6, densityBands: 4,
      densityResolution: 'very-coarse-density',
    });
    expect(b!.tracks[0]).toMatchObject({ documentTotal: 6, densityBands: 2 });
    expect(atlasDensityResolution(7)).toBe('very-coarse-density');
    expect(atlasDensityResolution(8)).toBe('coarse-density');
    expect(atlasDensityResolution(12)).toBe('coarse-density');
    expect(atlasDensityResolution(13)).toBe('density');
  });

  it('marks missing or mismatched extents unavailable instead of inventing length', () => {
    const result = densityResult();
    const tracks = barcodeTracks(result, ['a', 'b']);
    expect(atlasColumns(tracks, result.geometry, ['a'], new Map())[0]!.status)
      .toBe('missing-extent');
    expect(atlasColumns(tracks, result.geometry, ['a'], new Map([['a', 99]]))[0]!.status)
      .toBe('extent-mismatch');
    expect(atlasColumns(tracks, result.geometry, ['gone'], new Map([['gone', 10]]))[0]!.status)
      .toBe('axis-mismatch');
  });
});

describe('Atlas normalization and virtualization', () => {
  const columns = atlasColumns(
    barcodeTracks(exactResult(), ['a', 'b']),
    null,
    ['a', 'b'],
    new Map([['a', 100], ['b', 50]]),
  );

  it('gives every Equal column full height and To-scale one shared token domain', () => {
    const equal = atlasLayout(columns, 'equal', { plotHeight: 400, columnWidth: 80, columnGap: 8 });
    expect(equal.columns.map((column) => column.railHeight)).toEqual([400, 400]);
    expect(equal.columns.map((column) => column.domainTokenCount)).toEqual([100, 50]);
    const scaled = atlasLayout(columns, 'to-scale', { plotHeight: 400, columnWidth: 80, columnGap: 8 });
    expect(scaled.columns.map((column) => column.railHeight)).toEqual([400, 200]);
    expect(scaled.columns.map((column) => column.domainTokenCount)).toEqual([100, 100]);
    expect(atlasYForToken(scaled.columns[1]!, 25)).toBe(100);
  });

  it('rejects the empty To-scale tail and maps valid y to a real token', () => {
    const scaled = atlasLayout(columns, 'to-scale', { plotHeight: 400, columnWidth: 80, columnGap: 8 });
    expect(atlasTokenAtY(scaled.columns[1]!, 100)).toBe(25);
    expect(atlasTokenAtY(scaled.columns[1]!, 199.9)).toBe(49);
    expect(atlasTokenAtY(scaled.columns[1]!, 200)).toBeNull();
    expect(atlasTokenAtY(scaled.columns[1]!, 350)).toBeNull();
  });

  it('keeps one bounded overscanned canvas window over all column shells', () => {
    const many = atlasLayout(
      Array.from({ length: 100 }, (_, index) => ({ ...columns[0]!, doc: `d${index}`, ordinal: index })),
      'equal',
      { plotHeight: 400, columnWidth: 80, columnGap: 8 },
    );
    expect(atlasCanvasWindow(many, 880, 264)).toEqual({ start: 8, end: 15 });
    expect(atlasCanvasWindow(many, 100_000, 264)).toEqual({ start: 97, end: 100 });
    expect(atlasCanvasWindow(many, Number.NaN, 264)).toEqual({ start: 0, end: 5 });
  });
});

describe('Atlas bounded paint rows', () => {
  it('accumulates exact spans and density intensity into bounded device rows', () => {
    const exact = atlasDeviceRows([
      { kind: 'tick', doc: 'a', t0: 0, t1: 1, ordinal: 0 },
      { kind: 'tick', doc: 'a', t0: 0, t1: 1, ordinal: 1 },
      { kind: 'tick', doc: 'a', t0: 50, t1: 80, ordinal: 2 },
    ], 100, 100, 1);
    expect(exact.rowCount).toBe(100);
    expect(exact.values[0]).toBe(2);
    expect(exact.values[50]).toBe(1);
    expect(exact.values[79]).toBe(1);
    expect(exact.values[80]).toBe(0);

    const density = atlasDeviceRows([
      { kind: 'cell', doc: 'a', t0: 0, t1: 50, count: 10, intensity: 0.5, midToken: 25 },
      { kind: 'cell', doc: 'a', t0: 50, t1: 100, count: 20, intensity: 1, midToken: 75 },
    ], 100, 10, 1);
    expect([...density.values]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1]);
  });

  it('caps pathological DPR/height and maps opacity monotonically', () => {
    expect(atlasDeviceRows([], 100, 100_000, 10).rowCount).toBe(ATLAS_MAX_DEVICE_ROWS);
    expect(atlasDeviceRows([], 100, Number.NaN, 2).rowCount).toBe(0);
    expect(atlasDeviceRows([], 100, 100, Number.POSITIVE_INFINITY).rowCount).toBe(0);
    expect(atlasRowOpacity(0, 2, 'exact')).toBe(0);
    expect(atlasRowOpacity(1, 2, 'exact')).toBeLessThan(atlasRowOpacity(2, 2, 'exact'));
    expect(atlasRowOpacity(10, 10, 'exact')).toBe(1);

    const sparseDensity = atlasRowOpacity(0.25, 0.25, 'density');
    const strongDensity = atlasRowOpacity(0.5, 0.5, 'density');
    expect(sparseDensity).toBeLessThan(strongDensity);
    expect(sparseDensity).toBe(atlasRowOpacity(0.25, 1, 'density'));
  });
});

describe('Atlas density disclosure summary', () => {
  it('reports actual coarse and very-coarse document counts', () => {
    expect(atlasDensitySummary([3, 7, 8, 12, 13, 50])).toEqual({
      documents: 6, min: 3, median: 12, max: 50, coarse: 2, veryCoarse: 2,
    });
    expect(atlasDensitySummary([])).toBeNull();
  });
});
