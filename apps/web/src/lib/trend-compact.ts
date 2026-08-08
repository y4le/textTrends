import type { WidthClass } from './presentation.ts';
import { TREND_LABEL_SPACE } from './trend-geometry.ts';

export interface TrendGeometry {
  readonly seriesHeight: number;
  readonly topPad: number;
  readonly rowHeight: number;
  readonly rowGap: number;
  readonly barcodeTrackHeight: number;
  readonly barcodeTrackGap: number;
  readonly barcodeBandGap: number;
  readonly labelSpace: number;
  readonly strokeFocused: number;
  readonly strokeOther: number;
  readonly directLabels: boolean;
  readonly bookMarks: 'ticks' | 'boundaries';
}

const STANDARD: TrendGeometry = Object.freeze({
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

const COMPACT: TrendGeometry = Object.freeze({
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

/** Geometry changes only the rendering; it never changes analytical intent. */
export function trendGeometryFor(width: WidthClass): TrendGeometry {
  return width === 'compact' ? COMPACT : STANDARD;
}
