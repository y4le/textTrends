import { describe, expect, it } from 'vitest';
import { trendGeometryFor } from '../src/lib/trend-compact.ts';

describe('trendGeometryFor', () => {
  it('uses bounded compact geometry with 28px rows and heavier strokes', () => {
    expect(trendGeometryFor('compact')).toEqual({
      seriesHeight: 132,
      topPad: 10,
      rowHeight: 28,
      rowGap: 8,
      barcodeTrackHeight: 5,
      barcodeTrackGap: 2,
      barcodeBandGap: 3,
      strokeFocused: 3.5,
      strokeOther: 2,
      bookMarks: 'boundaries',
    });
  });

  it.each(['regular', 'wide'] as const)('uses the standard %s geometry', (width) => {
    expect(trendGeometryFor(width)).toEqual({
      seriesHeight: 180,
      topPad: 14,
      rowHeight: 44,
      rowGap: 22,
      barcodeTrackHeight: 7,
      barcodeTrackGap: 2,
      barcodeBandGap: 3,
      strokeFocused: 2.5,
      strokeOther: 1.5,
      bookMarks: 'ticks',
    });
  });

  it('returns stable immutable records for render-time derivation', () => {
    expect(trendGeometryFor('compact')).toBe(trendGeometryFor('compact'));
    expect(Object.isFrozen(trendGeometryFor('compact'))).toBe(true);
    expect(Object.isFrozen(trendGeometryFor('wide'))).toBe(true);
  });
});
