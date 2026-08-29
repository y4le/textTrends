import {
  barcodeBandExtent,
  barcodeBandHeight,
  finiteTracks,
  footerTrendMinimumHeight,
} from './footer-metrics.ts';
import type { WidthClass } from './presentation.ts';
import { trendGeometryFor, type TrendGeometry } from './trend-compact.ts';
import { byBookRowPitch } from './trend-geometry.ts';

/** Smallest title lane already proven by the authored compact presentation. */
export const TREND_TITLE_LANE_MIN = 8;

/** A hairline lane keeps adjacent rows distinct after their titles disappear. */
export const TREND_ROW_SEPARATOR = 2;

export interface TrendRowSizingInput {
  readonly width: WidthClass;
  readonly coarse: boolean;
  readonly trackCount: number;
  /** Requested pixels per text, including its plot, barcode, and title lane.
   * Null and non-finite values follow the authored width-class default. */
  readonly targetPitch: number | null;
}

export interface TrendRowSizing {
  readonly rowPitch: number;
  readonly basePitch: number;
  readonly titlePitch: number;
  readonly plotPitch: number;
  readonly minPitch: number;
  readonly maxPitch: number;
  readonly barcodeExtent: number;
  readonly geometry: TrendGeometry;
  readonly titlesPainted: boolean;
  readonly atMinimum: boolean;
}

/**
 * Resolve one row-pitch request without changing barcode or series geometry.
 * Shrinking spends the title lane first, withdraws its visible label, and
 * touches the plot only after the lane reaches its separator floor.
 */
export function trendRowSizing(input: TrendRowSizingInput): TrendRowSizing {
  const base = trendGeometryFor(input.width);
  const tracks = finiteTracks(input.trackCount);
  const barcodeHeight = barcodeBandHeight(
    tracks,
    base.barcodeTrackHeight,
    base.barcodeTrackGap,
  );
  const barcodeExtent = barcodeBandExtent(base.barcodeBandGap, barcodeHeight);
  const pitchFor = (rowHeight: number, rowGap: number) => byBookRowPitch(
    rowHeight,
    rowGap,
    base.barcodeBandGap,
    barcodeHeight,
  );
  const basePitch = pitchFor(base.rowHeight, base.rowGap);
  const titlePitch = pitchFor(base.rowHeight, TREND_TITLE_LANE_MIN);
  const plotPitch = pitchFor(base.rowHeight, TREND_ROW_SEPARATOR);
  const minPitch = pitchFor(
    footerTrendMinimumHeight(input.coarse),
    TREND_ROW_SEPARATOR,
  );
  const maxPitch = Math.max(
    pitchFor(base.seriesHeight, base.rowGap),
    minPitch,
  );
  const requested = input.targetPitch === null || !Number.isFinite(input.targetPitch)
    ? basePitch
    : Math.round(input.targetPitch);
  const rowPitch = Math.max(minPitch, Math.min(maxPitch, requested));

  let rowHeight: number;
  let rowGap: number;
  if (rowPitch >= basePitch) {
    rowHeight = rowPitch - barcodeExtent - base.rowGap;
    rowGap = base.rowGap;
  } else if (rowPitch >= plotPitch) {
    rowHeight = base.rowHeight;
    rowGap = rowPitch - barcodeExtent - base.rowHeight;
  } else {
    rowHeight = rowPitch - barcodeExtent - TREND_ROW_SEPARATOR;
    rowGap = TREND_ROW_SEPARATOR;
  }

  const geometry = rowHeight === base.rowHeight && rowGap === base.rowGap
    ? base
    : Object.freeze({ ...base, rowHeight, rowGap });
  return Object.freeze({
    rowPitch,
    basePitch,
    titlePitch,
    plotPitch,
    minPitch,
    maxPitch,
    barcodeExtent,
    geometry,
    titlesPainted: rowPitch >= titlePitch,
    atMinimum: rowPitch === minPitch,
  });
}
