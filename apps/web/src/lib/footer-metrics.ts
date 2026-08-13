import type { WidthClass } from './presentation.ts';
import type { TrendGeometry } from './trend-compact.ts';

/** Shared barcode-band arithmetic. Keeping this in the footer metrics leaf
 * lets the eager dock reserve the lazy reading region without importing the
 * full trend or footer view modules. */
export function barcodeBandHeight(
  trackCount: number,
  trackHeight: number,
  trackGap: number,
): number {
  return Math.max(0, trackCount) * (trackHeight + trackGap);
}

export function barcodeBandExtent(barcodeBandGap: number, barcodeHeight: number): number {
  return barcodeHeight > 0 ? barcodeBandGap + barcodeHeight : 0;
}

export interface FooterGeometry extends TrendGeometry {
  readonly passageHeight: number;
  readonly statusHeight: number;
  readonly laneGap: number;
  readonly padBlock: number;
  readonly stripMinHeight: number;
}

const COMPACT_FINE: FooterGeometry = Object.freeze({
  passageHeight: 20,
  statusHeight: 14,
  laneGap: 3,
  padBlock: 4,
  stripMinHeight: 0,
  seriesHeight: 20,
  topPad: 2,
  rowHeight: 20,
  rowGap: 0,
  barcodeTrackHeight: 5,
  barcodeTrackGap: 1,
  barcodeBandGap: 3,
  strokeFocused: 1.5,
  strokeOther: 1,
  bookMarks: 'boundaries',
});

const STANDARD_FINE: FooterGeometry = Object.freeze({
  passageHeight: 22,
  statusHeight: 16,
  laneGap: 4,
  padBlock: 6,
  stripMinHeight: 0,
  seriesHeight: 26,
  topPad: 3,
  rowHeight: 26,
  rowGap: 0,
  barcodeTrackHeight: 6,
  barcodeTrackGap: 2,
  barcodeBandGap: 3,
  strokeFocused: 1.5,
  strokeOther: 1,
  bookMarks: 'boundaries',
});

const coarseGeometry = (fine: FooterGeometry): FooterGeometry => Object.freeze({
  ...fine,
  passageHeight: 44,
  stripMinHeight: 44,
});

const COMPACT_COARSE: FooterGeometry = Object.freeze({
  ...coarseGeometry(COMPACT_FINE),
  // The compact bottom navigation is 53px tall. Its historical 72px reserve
  // left 19px of dead air above the tabs; keep the dock's upper edge stable
  // and spend that recovered space on legible mobile data marks instead.
  // The passage remains comfortably above the 24px pointer-target floor but
  // gives back some of its former 44px tap padding to the data-rich strip.
  passageHeight: 36,
  seriesHeight: 38,
  topPad: 3,
  barcodeTrackHeight: 8,
  barcodeBandGap: 4,
  stripMinHeight: 70,
});
const STANDARD_COARSE = coarseGeometry(STANDARD_FINE);

/** Footer geometry is presentation-only and never changes query intent. */
export function footerGeometryFor(width: WidthClass, coarse = false): FooterGeometry {
  if (width === 'compact') return coarse ? COMPACT_COARSE : COMPACT_FINE;
  return coarse ? STANDARD_COARSE : STANDARD_FINE;
}

export function footerBlockSize(
  geometry: FooterGeometry,
  trackCount: number,
): number {
  const barcodeHeight = barcodeBandHeight(
    trackCount,
    geometry.barcodeTrackHeight,
    geometry.barcodeTrackGap,
  );
  const visualStripHeight = geometry.seriesHeight
    + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  return 1 // border-block-start is inside the border-box block size
    + 2 * geometry.padBlock
    + geometry.passageHeight
    + geometry.laneGap
    + geometry.statusHeight
    + geometry.laneGap
    + Math.max(geometry.stripMinHeight, visualStripHeight);
}
