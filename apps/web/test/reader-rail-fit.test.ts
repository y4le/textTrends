import { describe, expect, it } from 'vitest';
import { readerRailsFit } from '../src/lib/reader-rail-fit.ts';

describe('Reader rail fit', () => {
  it('uses measured available and required inline sizes', () => {
    expect(readerRailsFit(1_100, 1_020)).toBe(true);
    expect(readerRailsFit(1_019, 1_020)).toBe(false);
  });

  it('absorbs only subpixel layout noise at the fit boundary', () => {
    expect(readerRailsFit(1_019.6, 1_020)).toBe(true);
    expect(readerRailsFit(1_019.4, 1_020)).toBe(false);
  });

  it.each([
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [100, Number.POSITIVE_INFINITY],
  ])('rejects invalid geometry (%s, %s)', (available, required) => {
    expect(readerRailsFit(available, required)).toBe(false);
  });
});
