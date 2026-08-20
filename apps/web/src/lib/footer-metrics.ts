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

export interface DockSizingInput {
  readonly width: WidthClass;
  readonly coarse: boolean;
  readonly trackCount: number;
  /** The authored project needs a reading lane, even if its lazy contents have
   * not mounted yet. */
  readonly footerPresent: boolean;
  /** `null` and non-finite values follow the presentation's viewport-aware
   * default as its inputs change. */
  readonly targetBlockSize: number | null;
  /** Layout viewport height. The automatic footer default is capped against
   * this value; explicit user resizing can still use all available space.
   * Non-positive or non-finite values disable the automatic cap. */
  readonly viewportBlockSize: number;
  readonly availableBlockSize: number;
}

export interface DockSizing {
  readonly blockSize: number;
  readonly baseBlockSize: number;
  readonly minBlockSize: number;
  readonly maxBlockSize: number;
  readonly railBlockSize: number;
  readonly railPadBlock: number;
  readonly termTargetBlockSize: number;
  readonly footerBlockSize: number;
  readonly footerGeometry: FooterGeometry;
  readonly showStatus: boolean;
  readonly showBarcode: boolean;
}

/** Expanded footer barcode rows stay readable without becoming the dominant
 * visualization. Once each row reaches this height, every further resize
 * pixel belongs to the trend graph. */
export const FOOTER_BARCODE_TRACK_MAX_HEIGHT = 16;

/** The reading footer is useful context, not the primary surface. Its
 * automatic size may occupy at most one third of the visible page; users can
 * still deliberately expand it with the resize handle. */
export const FOOTER_DEFAULT_MAX_VIEWPORT_RATIO = 1 / 3;

export const DOCK_TERM_TARGET_MIN_HEIGHT = 24;
const DOCK_RAIL_PAD_BASE = 3;
const DOCK_RAIL_PAD_MIN = 2;
const FOOTER_PAD_MIN = 1;
const FOOTER_LANE_GAP_MIN = 1;

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
  strokeWidth: 1,
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
  strokeWidth: 1,
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

/** Spend half of user-requested growth on barcode rows until they reach their
 * cap, with the graph receiving the other half and all growth thereafter.
 * `stripMinHeight` grows in lockstep so the returned geometry always occupies
 * exactly the requested additional block size, including coarse layouts whose
 * minimum strip is slightly taller than its initial marks. */
export function expandedFooterGeometry(
  geometry: FooterGeometry,
  trackCount: number,
  extraBlockSize: number,
): FooterGeometry {
  const tracks = Number.isFinite(trackCount)
    ? Math.max(0, Math.floor(trackCount))
    : 0;
  const extra = Number.isFinite(extraBlockSize)
    ? Math.max(0, extraBlockSize)
    : 0;
  if (extra === 0) return geometry;
  const barcodeGrowthCapacity = tracks
    * Math.max(0, FOOTER_BARCODE_TRACK_MAX_HEIGHT - geometry.barcodeTrackHeight);
  const barcodeGrowth = Math.min(extra / 2, barcodeGrowthCapacity);
  const graphGrowth = extra - barcodeGrowth;
  const barcodeHeight = barcodeBandHeight(
    tracks,
    geometry.barcodeTrackHeight,
    geometry.barcodeTrackGap,
  );
  const initialVisualHeight = geometry.seriesHeight
    + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  return Object.freeze({
    ...geometry,
    seriesHeight: geometry.seriesHeight + graphGrowth,
    barcodeTrackHeight: tracks > 0
      ? geometry.barcodeTrackHeight + barcodeGrowth / tracks
      : geometry.barcodeTrackHeight,
    stripMinHeight: Math.max(geometry.stripMinHeight, initialVisualHeight) + extra,
  });
}

export function footerBlockSize(
  geometry: FooterGeometry,
  trackCount: number,
  lanes: {
    readonly showStatus?: boolean;
    readonly showBarcode?: boolean;
  } = {},
): number {
  const showStatus = lanes.showStatus ?? true;
  const showBarcode = lanes.showBarcode ?? trackCount > 0;
  const barcodeHeight = barcodeBandHeight(
    showBarcode ? trackCount : 0,
    geometry.barcodeTrackHeight,
    geometry.barcodeTrackGap,
  );
  const visualStripHeight = geometry.seriesHeight
    + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  return 1 // border-block-start is inside the border-box block size
    + 2 * geometry.padBlock
    + geometry.passageHeight
    + geometry.laneGap
    + (showStatus ? geometry.statusHeight + geometry.laneGap : 0)
    + Math.max(geometry.stripMinHeight, visualStripHeight);
}

function finiteTracks(trackCount: number): number {
  return Number.isFinite(trackCount) ? Math.max(0, Math.floor(trackCount)) : 0;
}

function railBaseFor(width: WidthClass, coarse: boolean): number {
  return width === 'compact' || coarse ? 50 : 48;
}

function termTargetBaseFor(width: WidthClass, coarse: boolean): number {
  return width === 'compact' || coarse ? 36 : 34;
}

function passageFloorFor(width: WidthClass, coarse: boolean): number {
  if (coarse) return 24;
  return width === 'compact' ? 18 : 20;
}

function graphFloorFor(coarse: boolean): number {
  return coarse ? 24 : 12;
}

function withStrip(
  base: FooterGeometry,
  stripHeight: number,
  seriesHeight: number,
): FooterGeometry {
  const safeSeries = Math.max(0, seriesHeight);
  return Object.freeze({
    ...base,
    seriesHeight: safeSeries,
    topPad: Math.min(base.topPad, Math.max(0, safeSeries - 6)),
    stripMinHeight: Math.max(0, stripHeight),
  });
}

/** Resolve one absolute dock-size request into rail and reading geometry.
 * Today's authored layout is the default rather than the minimum. Explicit
 * resizing uses the established rail-first squeeze in uncapped viewports. When
 * the viewport footer cap is active, automatic and explicit targets preserve
 * that footer-first partition until the footer reaches its own design floor,
 * avoiding a boundary jump on the first resize. The visual strip is the
 * residual, so every accepted pixel belongs to exactly one lane. */
export function dockSizing(input: DockSizingInput): DockSizing {
  const tracks = finiteTracks(input.trackCount);
  const railBase = railBaseFor(input.width, input.coarse);
  const termTargetBase = termTargetBaseFor(input.width, input.coarse);
  const available = Number.isFinite(input.availableBlockSize)
    ? Math.max(0, Math.floor(input.availableBlockSize))
    : 0;

  if (!input.footerPresent) {
    const blockSize = Math.min(railBase, available || railBase);
    return Object.freeze({
      blockSize,
      baseBlockSize: railBase,
      minBlockSize: blockSize,
      maxBlockSize: blockSize,
      railBlockSize: blockSize,
      railPadBlock: DOCK_RAIL_PAD_BASE,
      termTargetBlockSize: termTargetBase,
      footerBlockSize: 0,
      footerGeometry: footerGeometryFor(input.width, input.coarse),
      showStatus: false,
      showBarcode: false,
    });
  }

  const base = footerGeometryFor(input.width, input.coarse);
  const baseFooterSize = footerBlockSize(base, tracks);
  const baseBlockSize = railBase + baseFooterSize;
  const passageFloor = passageFloorFor(input.width, input.coarse);
  const graphFloor = graphFloorFor(input.coarse);
  // A term bucket adds its own two border pixels around the button target.
  const railFloor = 1 + 2 * DOCK_RAIL_PAD_MIN + DOCK_TERM_TARGET_MIN_HEIGHT + 2;
  const footerFloor = 1
    + 2 * FOOTER_PAD_MIN
    + passageFloor
    + FOOTER_LANE_GAP_MIN
    + graphFloor;
  const designMin = railFloor + footerFloor;
  const maxBlockSize = Math.max(designMin, available);
  const minBlockSize = designMin;
  const viewport = Number.isFinite(input.viewportBlockSize)
    && input.viewportBlockSize > 0
    ? Math.max(0, Math.floor(input.viewportBlockSize))
    : Number.POSITIVE_INFINITY;
  const defaultFooterMax = Math.max(
    footerFloor,
    Math.floor(viewport * FOOTER_DEFAULT_MAX_VIEWPORT_RATIO),
  );
  const defaultBlockSize = railBase + Math.min(baseFooterSize, defaultFooterMax);
  const automaticDefault = input.targetBlockSize === null
    || !Number.isFinite(input.targetBlockSize);
  const footerCapActive = baseFooterSize > defaultFooterMax;
  const requested = automaticDefault
    ? defaultBlockSize
    : Math.round(input.targetBlockSize!);
  const blockSize = Math.max(minBlockSize, Math.min(maxBlockSize, requested));

  if (blockSize >= baseBlockSize) {
    const footerGeometry = expandedFooterGeometry(
      base,
      tracks,
      blockSize - baseBlockSize,
    );
    return Object.freeze({
      blockSize,
      baseBlockSize,
      minBlockSize,
      maxBlockSize,
      railBlockSize: railBase,
      railPadBlock: DOCK_RAIL_PAD_BASE,
      termTargetBlockSize: termTargetBase,
      footerBlockSize: footerBlockSize(footerGeometry, tracks),
      footerGeometry,
      showStatus: true,
      showBarcode: tracks > 0,
    });
  }

  let deficit = baseBlockSize - blockSize;
  let padBlock = base.padBlock;
  let laneGap = base.laneGap;
  let passageHeight = base.passageHeight;
  let railBlockSize = railBase;
  let railPadBlock = DOCK_RAIL_PAD_BASE;
  let termTargetBlockSize = termTargetBase;

  const railCapacity = railBase - railFloor;
  const footerCapacity = baseFooterSize - footerFloor;
  // A viewport-capped footer keeps its partition as the user begins resizing,
  // spending footer capacity first and borrowing from the rail only below the
  // footer floor. Uncapped explicit resizing retains the rail-first squeeze.
  const railTake = footerCapActive
    ? Math.min(Math.max(0, deficit - footerCapacity), railCapacity)
    : Math.min(deficit, railCapacity);
  const railProgress = railCapacity > 0 ? railTake / railCapacity : 1;
  railBlockSize -= railTake;
  railPadBlock -= railProgress * (DOCK_RAIL_PAD_BASE - DOCK_RAIL_PAD_MIN);
  termTargetBlockSize -= railProgress
    * (termTargetBase - DOCK_TERM_TARGET_MIN_HEIGHT);
  deficit -= railTake;

  if (deficit === 0) {
    return Object.freeze({
      blockSize,
      baseBlockSize,
      minBlockSize,
      maxBlockSize,
      railBlockSize,
      railPadBlock,
      termTargetBlockSize,
      footerBlockSize: baseFooterSize,
      footerGeometry: base,
      showStatus: true,
      showBarcode: tracks > 0,
    });
  }

  const padTake = Math.min(deficit, 2 * (base.padBlock - FOOTER_PAD_MIN));
  padBlock -= padTake / 2;
  deficit -= padTake;

  const gapTake = Math.min(deficit, 2 * (base.laneGap - FOOTER_LANE_GAP_MIN));
  laneGap -= gapTake / 2;
  deficit -= gapTake;

  const passageTake = Math.min(deficit, base.passageHeight - passageFloor);
  passageHeight -= passageTake;
  deficit -= passageTake;

  const chromeGeometry = Object.freeze({
    ...base,
    padBlock,
    laneGap,
    passageHeight,
  });
  if (deficit === 0) {
    const footerSize = footerBlockSize(chromeGeometry, tracks);
    return Object.freeze({
      blockSize,
      baseBlockSize,
      minBlockSize,
      maxBlockSize,
      railBlockSize,
      railPadBlock,
      termTargetBlockSize,
      footerBlockSize: footerSize,
      footerGeometry: chromeGeometry,
      showStatus: true,
      showBarcode: tracks > 0,
    });
  }

  const barcodeExtent = barcodeBandExtent(
    base.barcodeBandGap,
    barcodeBandHeight(tracks, base.barcodeTrackHeight, base.barcodeTrackGap),
  );
  const statusLast = railBlockSize
    + 1 + 2 * FOOTER_PAD_MIN + passageFloor
    + 2 * FOOTER_LANE_GAP_MIN + base.statusHeight
    + barcodeExtent + graphFloor;
  const barcodeLast = railBlockSize
    + footerFloor + barcodeExtent;

  const showStatus = blockSize >= statusLast;
  const showBarcode = tracks > 0 && (showStatus || blockSize >= barcodeLast);

  const chromeHeight = 1
    + 2 * FOOTER_PAD_MIN
    + passageFloor
    + FOOTER_LANE_GAP_MIN
    + (showStatus ? base.statusHeight + FOOTER_LANE_GAP_MIN : 0);
  const stripHeight = blockSize - railBlockSize - chromeHeight;
  const seriesHeight = stripHeight - (showBarcode ? barcodeExtent : 0);
  const footerGeometry = withStrip(Object.freeze({
    ...base,
    padBlock: FOOTER_PAD_MIN,
    laneGap: FOOTER_LANE_GAP_MIN,
    passageHeight: passageFloor,
  }), stripHeight, showStatus
    ? Math.min(base.seriesHeight, seriesHeight)
    : seriesHeight);
  const footerSize = footerBlockSize(footerGeometry, tracks, {
    showStatus,
    showBarcode,
  });

  return Object.freeze({
    blockSize,
    baseBlockSize,
    minBlockSize,
    maxBlockSize,
    railBlockSize,
    railPadBlock,
    termTargetBlockSize,
    footerBlockSize: footerSize,
    footerGeometry,
    showStatus,
    showBarcode,
  });
}
