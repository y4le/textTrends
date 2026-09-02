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

/** Tight barcode whitespace preserves distinct tracks without letting the
 * annotation dominate an already-small graph. */
export const TREND_BARCODE_BAND_GAP_MIN = 1;
export const TREND_BARCODE_TRACK_GAP_MIN = 1;

/** Below one device-independent mini track, dispersion ink aliases away. */
export const TREND_BARCODE_TRACK_MIN_FINE = 2;
export const TREND_BARCODE_TRACK_MIN_COARSE = 3;

/** A smaller stride is still useful context, but is too narrow to own an
 * occurrence-specific pointer zone. */
export const TREND_BARCODE_INTERACTIVE_STRIDE = 6;

export type TrendRowPhase =
  | 'grow'
  | 'lane'
  | 'band-space'
  | 'hide'
  | 'ink'
  | 'drop';

export interface TrendRowSizingInput {
  readonly width: WidthClass;
  readonly coarse: boolean;
  readonly trackCount: number;
  /** Requested pixels per text, including its plot, barcode, and title lane.
   * Null and non-finite values follow the authored width-class default. */
  readonly targetPitch: number | null;
  /** Find depends on its foreground occurrence band, so its transient sizing
   * floor retains the smallest painted barcode. */
  readonly barcodeRequired?: boolean;
}

export interface TrendRowSizing {
  readonly rowPitch: number;
  readonly basePitch: number;
  readonly titlePitch: number;
  readonly tightPitch: number;
  readonly plotPitch: number;
  readonly inkPitch: number;
  readonly minPitch: number;
  readonly maxPitch: number;
  readonly barcodeExtent: number;
  readonly geometry: TrendGeometry;
  readonly phase: TrendRowPhase;
  readonly titlesPainted: boolean;
  readonly barcodeVisible: boolean;
  readonly barcodeInteractive: boolean;
  readonly atMinimum: boolean;
}

/**
 * Resolve one row-pitch request through the separate-row compression ladder.
 * Shrinking spends title and barcode whitespace before data ink, then reduces
 * graph and barcode ink together. Below the miniature barcode stop, the band
 * and its complete extent collapse as one discrete step. This intentionally
 * leaves no intermediate pitch where a shrinking row makes its plot grow.
 */
export function trendRowSizing(input: TrendRowSizingInput): TrendRowSizing {
  const base = trendGeometryFor(input.width);
  const tracks = finiteTracks(input.trackCount);
  const fullBarcodeHeight = barcodeBandHeight(
    tracks,
    base.barcodeTrackHeight,
    base.barcodeTrackGap,
  );
  const fullExtent = barcodeBandExtent(base.barcodeBandGap, fullBarcodeHeight);
  const tightBarcodeHeight = barcodeBandHeight(
    tracks,
    base.barcodeTrackHeight,
    TREND_BARCODE_TRACK_GAP_MIN,
  );
  const tightExtent = barcodeBandExtent(
    TREND_BARCODE_BAND_GAP_MIN,
    tightBarcodeHeight,
  );
  const miniTrackHeight = input.coarse
    ? TREND_BARCODE_TRACK_MIN_COARSE
    : TREND_BARCODE_TRACK_MIN_FINE;
  const miniBarcodeHeight = barcodeBandHeight(
    tracks,
    miniTrackHeight,
    TREND_BARCODE_TRACK_GAP_MIN,
  );
  const miniExtent = barcodeBandExtent(
    TREND_BARCODE_BAND_GAP_MIN,
    miniBarcodeHeight,
  );
  const plotFloor = footerTrendMinimumHeight(input.coarse);
  const pitchFor = (
    rowHeight: number,
    rowGap: number,
    bandGap: number,
    barcodeHeight: number,
  ) => byBookRowPitch(rowHeight, rowGap, bandGap, barcodeHeight);
  const basePitch = pitchFor(base.rowHeight, base.rowGap, base.barcodeBandGap, fullBarcodeHeight);
  const titlePitch = pitchFor(
    base.rowHeight,
    TREND_TITLE_LANE_MIN,
    base.barcodeBandGap,
    fullBarcodeHeight,
  );
  const tightPitch = pitchFor(
    base.rowHeight,
    TREND_TITLE_LANE_MIN,
    TREND_BARCODE_BAND_GAP_MIN,
    tightBarcodeHeight,
  );
  const plotPitch = pitchFor(
    base.rowHeight,
    TREND_ROW_SEPARATOR,
    TREND_BARCODE_BAND_GAP_MIN,
    tightBarcodeHeight,
  );
  const inkPitch = pitchFor(
    plotFloor,
    TREND_ROW_SEPARATOR,
    TREND_BARCODE_BAND_GAP_MIN,
    miniBarcodeHeight,
  );
  const absoluteMinimum = pitchFor(plotFloor, TREND_ROW_SEPARATOR, 0, 0);
  const minPitch = input.barcodeRequired && tracks > 0
    ? inkPitch
    : absoluteMinimum;
  const maxPitch = Math.max(
    base.seriesHeight + fullExtent + base.rowGap,
    minPitch,
  );
  const requested = input.targetPitch === null || !Number.isFinite(input.targetPitch)
    ? basePitch
    : Math.round(input.targetPitch);
  const clampedPitch = Math.max(minPitch, Math.min(maxPitch, requested));
  const rowPitch = tracks > 0
      && !input.barcodeRequired
      && clampedPitch < inkPitch
    ? absoluteMinimum
    : clampedPitch;

  let phase: TrendRowPhase;
  let rowHeight = base.rowHeight;
  let rowGap = base.rowGap;
  let barcodeTrackHeight = base.barcodeTrackHeight;
  let barcodeTrackGap = base.barcodeTrackGap;
  let barcodeBandGap = base.barcodeBandGap;
  if (rowPitch >= basePitch) {
    phase = 'grow';
    rowHeight = rowPitch - fullExtent - base.rowGap;
  } else if (rowPitch >= titlePitch) {
    phase = 'lane';
    rowGap = rowPitch - fullExtent - base.rowHeight;
  } else if (rowPitch >= tightPitch && tracks > 0) {
    phase = 'band-space';
    rowGap = TREND_TITLE_LANE_MIN;
    const extent = rowPitch - base.rowHeight - rowGap;
    const capacity = fullExtent - tightExtent;
    const progress = capacity > 0 ? (fullExtent - extent) / capacity : 1;
    barcodeTrackGap = base.barcodeTrackGap
      - progress * (base.barcodeTrackGap - TREND_BARCODE_TRACK_GAP_MIN);
    barcodeBandGap = extent
      - tracks * (base.barcodeTrackHeight + barcodeTrackGap);
  } else if (rowPitch >= plotPitch) {
    phase = 'hide';
    barcodeTrackGap = tracks > 0
      ? TREND_BARCODE_TRACK_GAP_MIN
      : base.barcodeTrackGap;
    barcodeBandGap = tracks > 0
      ? TREND_BARCODE_BAND_GAP_MIN
      : base.barcodeBandGap;
    rowGap = rowPitch - tightExtent - base.rowHeight;
  } else if (rowPitch >= inkPitch && tracks > 0) {
    phase = 'ink';
    rowGap = TREND_ROW_SEPARATOR;
    barcodeTrackGap = TREND_BARCODE_TRACK_GAP_MIN;
    barcodeBandGap = TREND_BARCODE_BAND_GAP_MIN;
    const capacity = plotPitch - inkPitch;
    const progress = capacity > 0 ? (plotPitch - rowPitch) / capacity : 1;
    const plotTake = Math.round(progress * (base.rowHeight - plotFloor));
    rowHeight = base.rowHeight - plotTake;
    let extent = rowPitch - rowHeight - rowGap;
    extent = Math.max(miniExtent, Math.min(tightExtent, extent));
    rowHeight = rowPitch - extent - rowGap;
    barcodeTrackHeight = (extent - barcodeBandGap) / tracks - barcodeTrackGap;
  } else {
    phase = tracks > 0 ? 'drop' : 'ink';
    rowHeight = tracks > 0 ? plotFloor : rowPitch - TREND_ROW_SEPARATOR;
    rowGap = TREND_ROW_SEPARATOR;
    barcodeTrackHeight = tracks > 0 ? 0 : base.barcodeTrackHeight;
    barcodeTrackGap = tracks > 0 ? 0 : base.barcodeTrackGap;
    barcodeBandGap = tracks > 0 ? 0 : base.barcodeBandGap;
  }

  const effectiveBarcodeHeight = barcodeBandHeight(
    tracks,
    barcodeTrackHeight,
    barcodeTrackGap,
  );
  const barcodeExtent = barcodeBandExtent(barcodeBandGap, effectiveBarcodeHeight);
  const geometry = rowHeight === base.rowHeight
      && rowGap === base.rowGap
      && barcodeTrackHeight === base.barcodeTrackHeight
      && barcodeTrackGap === base.barcodeTrackGap
      && barcodeBandGap === base.barcodeBandGap
    ? base
    : Object.freeze({
        ...base,
        rowHeight,
        rowGap,
        barcodeTrackHeight,
        barcodeTrackGap,
        barcodeBandGap,
      });
  const barcodeVisible = tracks > 0 && rowPitch >= inkPitch;
  return Object.freeze({
    rowPitch,
    basePitch,
    titlePitch,
    tightPitch,
    plotPitch,
    inkPitch,
    minPitch,
    maxPitch,
    barcodeExtent,
    geometry,
    phase,
    titlesPainted: rowPitch >= tightPitch,
    barcodeVisible,
    barcodeInteractive: barcodeVisible
      && barcodeTrackHeight + barcodeTrackGap >= TREND_BARCODE_INTERACTIVE_STRIDE,
    atMinimum: rowPitch === minPitch,
  });
}
