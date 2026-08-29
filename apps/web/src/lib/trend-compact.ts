import type { WidthClass } from './presentation.ts';

export interface TrendGeometry {
  readonly seriesHeight: number;
  readonly topPad: number;
  readonly rowHeight: number;
  readonly rowGap: number;
  readonly barcodeTrackHeight: number;
  readonly barcodeTrackGap: number;
  readonly barcodeBandGap: number;
  readonly strokeWidth: number;
}

const STANDARD: TrendGeometry = Object.freeze({
  seriesHeight: 180,
  topPad: 14,
  rowHeight: 44,
  rowGap: 22,
  barcodeTrackHeight: 7,
  barcodeTrackGap: 2,
  barcodeBandGap: 3,
  strokeWidth: 1.5,
});

const COMPACT: TrendGeometry = Object.freeze({
  seriesHeight: 132,
  topPad: 10,
  rowHeight: 28,
  rowGap: 8,
  barcodeTrackHeight: 5,
  barcodeTrackGap: 2,
  barcodeBandGap: 3,
  strokeWidth: 2,
});

/** Geometry changes only the rendering; it never changes analytical intent. */
export function trendGeometryFor(width: WidthClass): TrendGeometry {
  return width === 'compact' ? COMPACT : STANDARD;
}
