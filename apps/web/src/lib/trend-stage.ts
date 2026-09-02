/** Pure projection and viewport geometry for one rendered trend stage.
 * Interaction policy stays in TrendPanel. The width-independent projection is
 * intentionally separate so resizing does not rebuild barcode view-models. */
import type { DispersionResultV1, NumericTrend } from '@texttrends/core';
import {
  barcodeTracks,
  buildBarcodeSnapIndexes,
  orderTracks,
  type BarcodeSnapIndex,
  type BarcodeTrackVM,
} from './barcode-view.ts';
import type { TrendGeometry } from './trend-compact.ts';
import {
  barcodeBandHeight,
  bookXFromTokenEdge,
  byBookRowPitch,
  seriesXFromTokenEdge,
  trendLabelBands,
  type SequenceLayout,
  type TrendLabelBand,
  type TrendStageSpec,
} from './trend-geometry.ts';
import { trendRowDomain, type TrendView } from './trend-view.ts';

const trackProjectionCache = new WeakMap<
  DispersionResultV1,
  Map<string, readonly BarcodeTrackVM[]>
>();
const snapIndexCache = new WeakMap<
  readonly BarcodeTrackVM[],
  readonly (readonly (BarcodeSnapIndex | null)[])[]
>();

// These shared projections intentionally outlive either mounted consumer but
// not their immutable dispersion result: WeakMap keys release both caches when
// the store replaces that resident result.

/** Share the expensive occurrence projection between the Trends stage and
 * the global footer. Geometry remains outside this identity cache. */
export function projectedBarcodeTracks(
  dispersion: DispersionResultV1 | null,
  docs: readonly string[],
  seriesOrder: readonly string[],
): readonly BarcodeTrackVM[] {
  if (dispersion === null) return [];
  let byIntent = trackProjectionCache.get(dispersion);
  if (!byIntent) {
    byIntent = new Map();
    trackProjectionCache.set(dispersion, byIntent);
  }
  const key = JSON.stringify([docs, seriesOrder]);
  const resident = byIntent.get(key);
  if (resident) return resident;
  const projected = orderTracks(barcodeTracks(dispersion, docs), seriesOrder);
  byIntent.set(key, projected);
  return projected;
}

/** Exact-track snap indexes are also shared; a 250k-occurrence track must not
 * allocate a second index merely because two views consume it. */
export function projectedBarcodeSnapIndexes(
  tracks: readonly BarcodeTrackVM[],
): readonly (readonly (BarcodeSnapIndex | null)[])[] {
  const resident = snapIndexCache.get(tracks);
  if (resident) return resident;
  const projected = tracks.map((track) => buildBarcodeSnapIndexes(track));
  snapIndexCache.set(tracks, projected);
  return projected;
}

/** Inputs whose projection is unchanged by resize, view switching, or pointer
 * capability. Keeping width out of this contract is the memoization boundary. */
export interface TrendStageProjectionInput {
  readonly trend: NumericTrend;
  readonly seriesOrder: readonly string[];
  readonly dispersion: DispersionResultV1 | null;
  readonly selectedDispersion: DispersionResultV1 | null;
  readonly selectedDocs: readonly string[];
  readonly geometry: TrendGeometry;
  /** Find keeps the durable barcode's visual height while exposing one
   * full-height foreground lane to interaction. */
  readonly reservedTrackCount?: number;
  readonly foregroundBarcodeOverlay?: boolean;
}

export interface TrendStageProjection {
  readonly docs: readonly string[];
  readonly tokenCounts: readonly number[];
  readonly layout: SequenceLayout;
  readonly tracks: readonly BarcodeTrackVM[];
  readonly selectedTracks: readonly BarcodeTrackVM[];
  readonly barcodeHeight: number;
  readonly rowPitch: number;
  readonly geometry: TrendGeometry;
  readonly foregroundBarcodeOverlay: boolean;
}

export function trendStageProjection(input: TrendStageProjectionInput): TrendStageProjection {
  const { trend, seriesOrder, geometry } = input;
  if (!trend.sequenceBases) {
    throw new Error('trend result missing sequenceBases (declared-sequence is required)');
  }
  const docs = trend.order;
  const bases = trend.sequenceBases;
  const layout: SequenceLayout = {
    bases,
    tokenCounts: trend.docTokenCount,
    totalTokens: docs.length === 0
      ? 0
      : (bases[docs.length - 1] ?? 0) + (trend.docTokenCount[docs.length - 1] ?? 0),
  };
  const tracks = projectedBarcodeTracks(input.dispersion, docs, seriesOrder);
  const selectedTracks = input.selectedDocs.length > 0
    ? projectedBarcodeTracks(input.selectedDispersion, input.selectedDocs, seriesOrder)
    : [];
  const barcodeHeight = barcodeBandHeight(
    Math.max(tracks.length, input.reservedTrackCount ?? 0),
    geometry.barcodeTrackHeight,
    geometry.barcodeTrackGap,
  );
  const rowPitch = byBookRowPitch(
    geometry.rowHeight,
    geometry.rowGap,
    geometry.barcodeBandGap,
    barcodeHeight,
  );
  return {
    docs,
    tokenCounts: trend.docTokenCount,
    layout,
    tracks,
    selectedTracks,
    barcodeHeight,
    rowPitch,
    geometry,
    foregroundBarcodeOverlay: input.foregroundBarcodeOverlay ?? false,
  };
}

/** Build the exact-pointer interaction index independently from projection
 * and viewport geometry. TrendPanel calls this only for a fine pointer, so a
 * coarse-only device does not allocate an unused entry per occurrence. */
export function trendStageSnapIndexes(
  projection: TrendStageProjection,
): readonly (readonly (BarcodeSnapIndex | null)[])[] {
  return projectedBarcodeSnapIndexes(projection.tracks);
}

export interface TrendStageGeometryInput {
  readonly plotWidth: number;
  readonly view: TrendView;
  /** Separate-row titles may be visually withdrawn without losing focus geometry. */
  readonly titlesPainted?: boolean;
  /** A visually miniature barcode remains context but no longer owns a narrow
   * occurrence-specific pointer lane. Combined view ignores this switch. */
  readonly barcodeInteractive?: boolean;
}

export interface TrendStageGeometryModel {
  /** Exact projection identity supplied by the caller. */
  readonly projection: TrendStageProjection;
  readonly edgeX: (docOrdinal: number, token: number) => number;
  readonly hitSpec: TrendStageSpec;
  readonly labelBands: readonly TrendLabelBand[];
  readonly rowDomain: readonly number[];
}

/** Add only viewport-dependent geometry to an existing projection. */
export function trendStageGeometry(
  projection: TrendStageProjection,
  input: TrendStageGeometryInput,
): TrendStageGeometryModel {
  const { plotWidth, view } = input;
  const {
    barcodeHeight,
    geometry,
    layout,
    tokenCounts,
    tracks,
    foregroundBarcodeOverlay,
  } = projection;
  const rowDomain = trendRowDomain(view, tokenCounts);
  const edgeX = view === 'series'
    ? (d: number, token: number) => seriesXFromTokenEdge(d, token, plotWidth, layout)
    : (d: number, token: number) => bookXFromTokenEdge(token, plotWidth, rowDomain[d] ?? 0);
  const band = foregroundBarcodeOverlay
    ? {
        trackCount: tracks.length > 0 ? 1 : 0,
        trackHeight: barcodeHeight,
        trackGap: 0,
      }
    : {
        trackCount: tracks.length,
        trackHeight: geometry.barcodeTrackHeight,
        trackGap: geometry.barcodeTrackGap,
      };
  const hitSpec: TrendStageSpec = view === 'series'
    ? {
        view: 'series',
        plotWidth,
        plotHeight: geometry.seriesHeight,
        barcodeBandGap: geometry.barcodeBandGap,
        barcodeHeight,
        band,
        layout,
      }
    : {
        view,
        plotWidth,
        rowHeight: geometry.rowHeight,
        rowGap: geometry.rowGap,
        barcodeBandGap: geometry.barcodeBandGap,
        barcodeHeight,
        band,
        barcodeZone: input.barcodeInteractive === false ? 'plot' : 'tracks',
        tokenCounts,
        rowDomain,
      };
  return {
    projection,
    edgeX,
    hitSpec,
    labelBands: trendLabelBands(hitSpec, input.titlesPainted),
    rowDomain,
  };
}
