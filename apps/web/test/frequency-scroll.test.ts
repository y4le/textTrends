import { describe, expect, it } from 'vitest';
import {
  firstFullyVisibleFrequencyRow,
  frequencyRowTop,
} from '../src/lib/frequency-scroll.ts';

describe('Vocabulary density scroll anchoring', () => {
  it('keeps the first fully visible primary row when pitch changes', () => {
    const anchor = firstFullyVisibleFrequencyRow({
      scrollTop: 251,
      rowCount: 100,
      rowHeight: 34,
      expandedIndex: -1,
      detailHeight: 0,
    });
    expect(anchor).toBe(8);
    expect(frequencyRowTop(anchor, 42, -1, 0)).toBe(336);
  });

  it('retains an exact row boundary and accounts for expanded detail', () => {
    expect(firstFullyVisibleFrequencyRow({
      scrollTop: 136,
      rowCount: 100,
      rowHeight: 34,
      expandedIndex: -1,
      detailHeight: 0,
    })).toBe(4);
    expect(firstFullyVisibleFrequencyRow({
      scrollTop: 200,
      rowCount: 100,
      rowHeight: 34,
      expandedIndex: 2,
      detailHeight: 220,
    })).toBe(3);
    expect(frequencyRowTop(3, 38, 2, 220)).toBe(334);
  });

  it('bounds empty, invalid, and terminal coordinates', () => {
    expect(firstFullyVisibleFrequencyRow({
      scrollTop: Number.NaN,
      rowCount: 0,
      rowHeight: 0,
      expandedIndex: -1,
      detailHeight: 0,
    })).toBe(0);
    expect(firstFullyVisibleFrequencyRow({
      scrollTop: 99_999,
      rowCount: 4,
      rowHeight: 34,
      expandedIndex: -1,
      detailHeight: 0,
    })).toBe(3);
  });
});
