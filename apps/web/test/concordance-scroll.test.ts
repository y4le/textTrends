import { describe, expect, it } from 'vitest';
import {
  CONCORDANCE_SAFE_SCROLL_EXTENT,
  concordanceLogicalAtScroll,
  concordancePhysicalExtent,
  concordancePrefetchRank,
  concordanceScrollTop,
  concordanceVisibleRanks,
  concordanceWindowSize,
  globalTokenForLogical,
  globalTokenForTarget,
  logicalForGlobalToken,
  targetForGlobalToken,
} from '../src/lib/concordance-scroll.ts';
import type { SequenceLayout } from '../src/lib/trend-geometry.ts';

const docs = ['empty', 'a', 'b'];
const layout: SequenceLayout = {
  bases: [0, 0, 40],
  tokenCounts: [0, 40, 60],
  totalTokens: 100,
};
const resident = {
  total: 4,
  firstRank: 0,
  rows: [
    { doc: 'a', pos: 10 },
    { doc: 'a', pos: 10 },
    { doc: 'a', pos: 20 },
    { doc: 'b', pos: 40 },
  ],
};

describe('Concordance scroll geometry', () => {
  it('caps the native plane while preserving invertible logical endpoints', () => {
    expect(concordancePhysicalExtent(100, 32)).toBe(3_200);
    expect(concordancePhysicalExtent(1_000_000, 32)).toBe(CONCORDANCE_SAFE_SCROLL_EXTENT);
    expect(concordanceScrollTop(500_000, 1_000_000, 32)).toBe(CONCORDANCE_SAFE_SCROLL_EXTENT / 2);
    expect(concordanceLogicalAtScroll(CONCORDANCE_SAFE_SCROLL_EXTENT / 2, 1_000_000, 32)).toBe(500_000);
    expect(concordanceScrollTop(-1, 20)).toBe(0);
    expect(concordanceLogicalAtScroll(Number.POSITIVE_INFINITY, 20)).toBe(0);
  });

  it('uses distinct sentinels and fixed-height occurrence centers', () => {
    expect(globalTokenForLogical({ docs, layout, totalRows: 4, logical: 0, axis: null, resident })).toBe(0);
    expect(globalTokenForLogical({ docs, layout, totalRows: 4, logical: 0.5, axis: null, resident })).toBe(10);
    expect(globalTokenForLogical({ docs, layout, totalRows: 4, logical: 1.5, axis: null, resident })).toBe(10);
    expect(globalTokenForLogical({ docs, layout, totalRows: 4, logical: 2, axis: null, resident })).toBe(15);
    expect(globalTokenForLogical({ docs, layout, totalRows: 4, logical: 4, axis: null, resident })).toBe(99);
  });

  it('chooses the leftmost duplicate row and interpolates compressed source gaps', () => {
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 10, axis: null, resident })).toBe(0.5);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 15, axis: null, resident })).toBe(2);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 5, axis: null, resident })).toBe(0.25);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 90, axis: null, resident }))
      .toBeCloseTo(3.5 + (10 / 19) * 0.5);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 0, axis: null, resident })).toBe(0);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 4, globalToken: 99, axis: null, resident })).toBe(4);
  });

  it('uses sparse samples for an immediate bounded approximation outside residency', () => {
    const axis = {
      ranks: Uint32Array.of(0, 128),
      globalTokens: Uint32Array.of(10, 50),
    };
    expect(logicalForGlobalToken({ docs, layout, totalRows: 256, globalToken: 10, axis, resident: null })).toBe(0.5);
    expect(logicalForGlobalToken({ docs, layout, totalRows: 256, globalToken: 30, axis, resident: null })).toBe(64.5);
    expect(globalTokenForLogical({ docs, layout, totalRows: 256, logical: 64.5, axis, resident: null })).toBe(30);
  });

  it('keeps a one-token corpus sentinel and occurrence logically distinct', () => {
    const one: SequenceLayout = { bases: [0], tokenCounts: [1], totalTokens: 1 };
    const oneResident = { total: 1, firstRank: 0, rows: [{ doc: 'only', pos: 0 }] };
    expect(logicalForGlobalToken({ docs: ['only'], layout: one, totalRows: 1, globalToken: 0, axis: null, resident: oneResident })).toBe(0);
    expect(globalTokenForLogical({ docs: ['only'], layout: one, totalRows: 1, logical: 0.5, axis: null, resident: oneResident })).toBe(0);
    expect(globalTokenForLogical({ docs: ['only'], layout: one, totalRows: 1, logical: 1, axis: null, resident: oneResident })).toBe(0);
  });

  it('maps global tokens through declared order while skipping empty documents', () => {
    expect(globalTokenForTarget(docs, layout, { doc: 'b', token: 4 })).toBe(44);
    expect(globalTokenForTarget(docs, layout, { doc: 'empty', token: 0 })).toBeNull();
    expect(targetForGlobalToken(docs, layout, 0)).toEqual({ doc: 'a', token: 0 });
    expect(targetForGlobalToken(docs, layout, 44)).toEqual({ doc: 'b', token: 4 });
    expect(targetForGlobalToken(docs, layout, 1_000)).toEqual({ doc: 'b', token: 59 });
  });

  it('bounds visible overscan and the requested worker window', () => {
    expect(concordanceVisibleRanks(50, 100, 320)).toEqual({ start: 35, end: 65 });
    expect(concordanceVisibleRanks(0, 100, 320)).toEqual({ start: 0, end: 15 });
    expect(concordanceVisibleRanks(100, 100, 320)).toEqual({ start: 85, end: 100 });
    expect(concordanceWindowSize(320)).toEqual({ before: 24, after: 24 });
    expect(concordanceWindowSize(10_000)).toEqual({ before: 249, after: 249 });
  });

  it('prefetches overlapping windows before visible rows reach resident edges', () => {
    const middle = {
      total: 100,
      firstRank: 20,
      rows: Array.from({ length: 49 }, () => ({ doc: 'a', pos: 0 })),
    };
    expect(concordancePrefetchRank(40.5, 100, 320, middle, 0)).toBeNull();
    expect(concordancePrefetchRank(35.5, 100, 320, middle, -1)).toBe(19);
    expect(concordancePrefetchRank(35.5, 100, 320, middle, 1)).toBeNull();
    expect(concordancePrefetchRank(53.5, 100, 320, middle, 1)).toBe(69);
    expect(concordancePrefetchRank(53.5, 100, 320, middle, -1)).toBeNull();
    expect(concordancePrefetchRank(90.5, 100, 320, middle, 1)).toBe(90);

    expect(concordancePrefetchRank(0.5, 100, 320, {
      ...middle,
      firstRank: 0,
      rows: middle.rows.slice(0, 25),
    }, -1)).toBeNull();
    expect(concordancePrefetchRank(99.5, 100, 320, {
      ...middle,
      firstRank: 75,
      rows: middle.rows.slice(0, 25),
    }, 1)).toBeNull();
  });
});
