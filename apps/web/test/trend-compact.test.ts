import { describe, expect, it } from 'vitest';
import { TREND_LABEL_SPACE } from '../src/lib/trend-geometry.ts';
import { trendGeometryFor } from '../src/lib/trend-compact.ts';

describe('trendGeometryFor', () => {
  it('uses bounded, label-rail-free compact geometry with 28px rows and heavier strokes', () => {
    expect(trendGeometryFor('compact')).toEqual({
      seriesHeight: 132,
      topPad: 10,
      rowHeight: 28,
      rowGap: 8,
      barcodeTrackHeight: 5,
      barcodeTrackGap: 2,
      barcodeBandGap: 3,
      labelSpace: 0,
      strokeFocused: 3.5,
      strokeOther: 2,
      directLabels: false,
      bookMarks: 'boundaries',
    });
  });

  it.each(['regular', 'wide'] as const)('preserves the delivered %s geometry', (width) => {
    expect(trendGeometryFor(width)).toEqual({
      seriesHeight: 180,
      topPad: 14,
      rowHeight: 44,
      rowGap: 22,
      barcodeTrackHeight: 7,
      barcodeTrackGap: 2,
      barcodeBandGap: 3,
      labelSpace: TREND_LABEL_SPACE,
      strokeFocused: 2.5,
      strokeOther: 1.5,
      directLabels: true,
      bookMarks: 'ticks',
    });
  });

  it('returns stable immutable records for render-time derivation', () => {
    expect(trendGeometryFor('compact')).toBe(trendGeometryFor('compact'));
    expect(Object.isFrozen(trendGeometryFor('compact'))).toBe(true);
    expect(Object.isFrozen(trendGeometryFor('wide'))).toBe(true);
  });
});
