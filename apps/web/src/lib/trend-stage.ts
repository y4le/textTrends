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
  type SequenceLayout,
  type TrendStageSpec,
} from './trend-geometry.ts';

/** Inputs whose projection is unchanged by resize, view switching, or pointer
 * capability. Keeping width out of this contract is the memoization boundary. */
export interface TrendStageProjectionInput {
  readonly trend: NumericTrend;
  readonly seriesOrder: readonly string[];
  readonly dispersion: DispersionResultV1 | null;
  readonly selectedDispersion: DispersionResultV1 | null;
  readonly selectedDocs: readonly string[];
  readonly geometry: TrendGeometry;
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
  const tracks = input.dispersion
    ? orderTracks(barcodeTracks(input.dispersion, docs), seriesOrder)
    : [];
  const selectedTracks = input.selectedDispersion && input.selectedDocs.length > 0
    ? orderTracks(barcodeTracks(input.selectedDispersion, input.selectedDocs), seriesOrder)
    : [];
  const barcodeHeight = barcodeBandHeight(
    tracks.length,
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
  };
}

/** Build the exact-pointer interaction index independently from projection
 * and viewport geometry. TrendPanel calls this only for a fine pointer, so a
 * coarse-only device does not allocate an unused entry per occurrence. */
export function trendStageSnapIndexes(
  projection: TrendStageProjection,
): readonly (readonly (BarcodeSnapIndex | null)[])[] {
  return projection.tracks.map((track) => buildBarcodeSnapIndexes(track));
}

export interface TrendStageGeometryInput {
  readonly plotWidth: number;
  readonly view: 'series' | 'by-book';
}

export interface TrendStageGeometryModel {
  /** Exact projection identity supplied by the caller. */
  readonly projection: TrendStageProjection;
  readonly edgeX: (docOrdinal: number, token: number) => number;
  readonly hitSpec: TrendStageSpec;
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
  } = projection;
  const edgeX = view === 'series'
    ? (d: number, token: number) => seriesXFromTokenEdge(d, token, plotWidth, layout)
    : (d: number, token: number) => bookXFromTokenEdge(token, plotWidth, tokenCounts[d] ?? 0);
  const band = {
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
        view: 'by-book',
        plotWidth,
        rowHeight: geometry.rowHeight,
        rowGap: geometry.rowGap,
        barcodeBandGap: geometry.barcodeBandGap,
        barcodeHeight,
        band,
        tokenCounts,
      };
  return {
    projection,
    edgeX,
    hitSpec,
  };
}
