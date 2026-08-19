import type { NumericTrend } from '@texttrends/core';
import { describe, expect, it } from 'vitest';
import type { SeriesIntent, SeriesTrendState } from '../src/lib/store.ts';
import {
  trendMatrix,
  trendMatrixDispersionLabel,
  trendMatrixRateLabel,
} from '../src/lib/trend-matrix.ts';

const first: SeriesIntent = {
  id: 'first',
  label: 'wolves',
  style: { color: 'blue', line: 'solid' },
};
const second: SeriesIntent = {
  id: 'second',
  label: 'moon',
  style: { color: 'orange', line: 'dash' },
};

function trend(
  documents: readonly {
    readonly doc: string;
    readonly tokens: readonly number[];
    readonly counts: readonly number[];
    readonly extent?: number;
  }[],
): NumericTrend {
  const offsets = [0];
  const docOrdinal: number[] = [];
  const binIndex: number[] = [];
  const starts: number[] = [];
  const tokens: number[] = [];
  const counts: number[] = [];
  const rates: number[] = [];
  const extents: number[] = [];
  const bases: number[] = [];
  let base = 0;
  documents.forEach((document, ordinal) => {
    let start = 0;
    bases.push(base);
    document.tokens.forEach((size, index) => {
      const count = document.counts[index] ?? 0;
      docOrdinal.push(ordinal);
      binIndex.push(index);
      starts.push(start);
      tokens.push(size);
      counts.push(count);
      rates.push(size === 0 ? 0 : count / size * 10_000);
      start += size;
    });
    const extent = document.extent ?? start;
    extents.push(extent);
    base += extent;
    offsets.push(counts.length);
  });
  return {
    coordinate: 'declared-sequence',
    bins: { mode: 'per-doc', count: 4 },
    rowOffsets: Uint32Array.from(offsets),
    order: documents.map((document) => document.doc),
    docOrdinal: Uint32Array.from(docOrdinal),
    binIndex: Uint32Array.from(binIndex),
    binStartToken: Uint32Array.from(starts),
    binTokens: Uint32Array.from(tokens),
    count: Uint32Array.from(counts),
    ratePer10k: Float64Array.from(rates),
    docTokenCount: extents,
    sequenceBases: bases,
  };
}

const ready = (value: NumericTrend): SeriesTrendState => ({ status: 'ready', trend: value });

describe('trendMatrix', () => {
  it('recomputes book rates from summed counts and true bin denominators', () => {
    const vm = trendMatrix({
      docs: ['short-final'],
      series: [first],
      trends: new Map([['first', ready(trend([
        { doc: 'short-final', tokens: [100, 20], counts: [1, 1] },
      ]))]]),
    });
    const cell = vm.rows[0]?.cells[0];
    expect(cell?.status).toBe('ready');
    if (cell?.status !== 'ready') return;
    expect(cell.rate).toBeCloseTo(2 / 120 * 10_000);
    expect(cell.rate).not.toBeCloseTo((100 + 500) / 2);
    expect(cell.profile.map((bin) => bin.rate)).toEqual([100, 500]);
    expect(cell.profile.every((bin) => bin.count === 0 || bin.rate > 0)).toBe(true);
  });

  it('uses an independent shared bin-rate scale for each term row', () => {
    const vm = trendMatrix({
      docs: ['a', 'b'],
      series: [first, second],
      trends: new Map([
        ['first', ready(trend([
          { doc: 'a', tokens: [100], counts: [1] },
          { doc: 'b', tokens: [100], counts: [2] },
        ]))],
        ['second', ready(trend([
          { doc: 'a', tokens: [100], counts: [20] },
          { doc: 'b', tokens: [100], counts: [10] },
        ]))],
      ]),
    });
    expect(vm.rows[0]).toMatchObject({ microScale: 200, peakDoc: 'b' });
    expect(vm.rows[1]).toMatchObject({ microScale: 2_000, peakDoc: 'a' });
    const firstCells = vm.rows[0]?.cells;
    expect(firstCells?.[0]).toMatchObject({ status: 'ready', relativeToPeak: 0.5 });
    expect(firstCells?.[1]).toMatchObject({ status: 'ready', relativeToPeak: 1 });
  });

  it('distinguishes even, clumped, absent, empty, pending, and failed cells', () => {
    const measured = trend([
      { doc: 'even', tokens: [50, 50], counts: [2, 2] },
      { doc: 'clumped', tokens: [50, 50], counts: [4, 0] },
      { doc: 'empty', tokens: [], counts: [], extent: 0 },
    ]);
    const readyVm = trendMatrix({
      docs: ['even', 'clumped', 'empty', 'absent'],
      series: [first],
      trends: new Map([['first', ready(measured)]]),
    });
    expect(readyVm.rows[0]?.cells[0]).toMatchObject({
      status: 'ready',
      dpNorm: 0,
      dispersion: 'even',
      position: 'middle',
    });
    expect(readyVm.rows[0]?.cells[1]).toMatchObject({
      status: 'ready',
      dpNorm: 1,
      dispersion: 'clumped',
      position: 'beginning',
    });
    expect(readyVm.rows[0]?.cells[2]?.status).toBe('empty');
    expect(readyVm.rows[0]?.cells[3]?.status).toBe('unavailable');

    const pending = trendMatrix({
      docs: ['even'],
      series: [first],
      trends: new Map([['first', { status: 'pending' }]]),
    });
    const failed = trendMatrix({
      docs: ['even'],
      series: [first],
      trends: new Map([['first', { status: 'error', message: 'nope' }]]),
    });
    expect(pending.rows[0]?.cells[0]?.status).toBe('pending');
    expect(failed.rows[0]?.cells[0]).toEqual({
      status: 'error', doc: 'even', message: 'nope',
    });
  });

  it('keeps qualitative rate language free of per-book values', () => {
    expect(trendMatrixRateLabel(1, 3)).toBe('highest rate in this term row');
    expect(trendMatrixRateLabel(0.8, 3)).toBe('high relative rate');
    expect(trendMatrixRateLabel(0.5, 3)).toBe('moderate relative rate');
    expect(trendMatrixRateLabel(0.2, 3)).toBe('low relative rate');
    expect(trendMatrixRateLabel(0, 0)).toBe('no occurrences');
    expect(trendMatrixDispersionLabel(0.2)).toBe('even');
    expect(trendMatrixDispersionLabel(0.21)).toBe('varied');
    expect(trendMatrixDispersionLabel(0.5)).toBe('varied');
    expect(trendMatrixDispersionLabel(0.51)).toBe('clumped');
  });

  it('describes occurrence mass in the final third of a book', () => {
    const vm = trendMatrix({
      docs: ['late'],
      series: [first],
      trends: new Map([['first', ready(trend([
        { doc: 'late', tokens: [50, 50], counts: [0, 4] },
      ]))]]),
    });
    expect(vm.rows[0]?.cells[0]).toMatchObject({ status: 'ready', position: 'end' });
  });
});
