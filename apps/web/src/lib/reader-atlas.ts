/** Pure Atlas projection and paint geometry. The expensive occurrence-to-
 * segment projection remains shared in trend-stage; this module only remaps
 * those resident buckets by document identity and allocates bounded device
 * rows for visible canvases. */

import type { DispersionGeometryV1 } from '@texttrends/core';
import type {
  BarcodeSegmentVM,
  BarcodeTrackVM,
} from './barcode-view.ts';
import type { AtlasNormalization } from './reader-view.ts';

export const ATLAS_MAX_DEVICE_ROWS = 8_192;

export type AtlasDensityResolution = 'density' | 'coarse-density' | 'very-coarse-density';
export type AtlasColumnStatus = 'ready' | 'empty' | 'missing-extent' | 'extent-mismatch' | 'axis-mismatch';

export interface AtlasColumnTrackVM {
  readonly seriesId: string;
  readonly groupId: string;
  readonly representation: BarcodeTrackVM['representation'];
  readonly corpusTotal: number;
  readonly documentTotal: number;
  readonly densityBands: number | null;
  readonly densityResolution: AtlasDensityResolution | null;
  /** Resident segment bucket: never copied by the Atlas projection. */
  readonly segments: readonly BarcodeSegmentVM[];
}

export interface AtlasColumnVM {
  readonly doc: string;
  readonly ordinal: number;
  readonly tokenCount: number | null;
  readonly status: AtlasColumnStatus;
  readonly tracks: readonly AtlasColumnTrackVM[];
}

function densityAxis(
  geometry: DispersionGeometryV1 | null,
): ReadonlyMap<string, { readonly tokenCount: number; readonly bands: number }> {
  if (geometry === null) return new Map();
  const axis = new Map<string, { tokenCount: number; bands: number }>();
  for (let index = 0; index < geometry.order.length; index += 1) {
    const doc = geometry.order[index]!;
    if (axis.has(doc)) continue;
    const from = geometry.bucketOffsets[index];
    const to = geometry.bucketOffsets[index + 1];
    const tokenCount = geometry.docTokenCount[index];
    if (from === undefined || to === undefined || tokenCount === undefined || to < from) continue;
    axis.set(doc, { tokenCount, bands: to - from });
  }
  return axis;
}

export function atlasDensityResolution(bands: number): AtlasDensityResolution {
  if (bands < 8) return 'very-coarse-density';
  if (bands <= 12) return 'coarse-density';
  return 'density';
}

/** Map CSR-projected tracks into declared columns by document identity. The
 * caller must project exact tracks with snapshot.readyDocs, never with this
 * declared order; `track.docOrder` is the carried CSR authority. This work is
 * O(resident segments), so a component must memoize it by resident-result and
 * document-axis identity rather than recomputing it during scroll or paint. */
export function atlasColumns(
  tracks: readonly BarcodeTrackVM[],
  geometry: DispersionGeometryV1 | null,
  declaredOrder: readonly string[],
  tokenCounts: ReadonlyMap<string, number>,
): readonly AtlasColumnVM[] {
  const densityByDoc = densityAxis(geometry);
  return declaredOrder.map((doc, ordinal) => {
    const extent = tokenCounts.get(doc);
    let status: AtlasColumnStatus = extent === undefined
      ? 'missing-extent'
      : !Number.isSafeInteger(extent) || extent < 0
        ? 'extent-mismatch'
        : extent < 1
        ? 'empty'
        : 'ready';
    const columnTracks = tracks.map((track): AtlasColumnTrackVM => {
      const docOrdinal = track.docOrder.indexOf(doc);
      if (docOrdinal < 0 && status === 'ready') status = 'axis-mismatch';
      const resident = docOrdinal < 0 ? [] : track.segmentsByDocOrdinal[docOrdinal] ?? [];
      const density = track.representation === 'density' ? densityByDoc.get(doc) : undefined;
      if (
        track.representation === 'density'
        && (
          density === undefined
          || (extent !== undefined && density.tokenCount !== extent)
        )
        && status === 'ready'
      ) status = density === undefined ? 'axis-mismatch' : 'extent-mismatch';
      const documentTotal = resident.reduce(
        (sum, segment) => sum + (segment.kind === 'cell' ? segment.count : 1),
        0,
      );
      const bands = density?.bands ?? null;
      return {
        seriesId: track.seriesId,
        groupId: track.groupId,
        representation: track.representation,
        corpusTotal: track.total,
        documentTotal,
        densityBands: bands,
        densityResolution: bands === null ? null : atlasDensityResolution(bands),
        segments: resident,
      };
    });
    return {
      doc,
      ordinal,
      tokenCount: extent ?? null,
      status,
      tracks: columnTracks,
    };
  });
}

export interface AtlasDensitySummary {
  readonly documents: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly coarse: number;
  readonly veryCoarse: number;
}

export function atlasDensitySummary(bands: readonly number[]): AtlasDensitySummary | null {
  if (bands.length === 0 || bands.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }
  const sorted = [...bands].sort((left, right) => left - right);
  return {
    documents: sorted.length,
    min: sorted[0]!,
    median: sorted[Math.floor(sorted.length / 2)]!,
    max: sorted[sorted.length - 1]!,
    coarse: sorted.filter((value) => value >= 8 && value <= 12).length,
    veryCoarse: sorted.filter((value) => value < 8).length,
  };
}

export interface AtlasLayoutColumn {
  readonly doc: string;
  readonly ordinal: number;
  readonly x: number;
  readonly width: number;
  readonly plotHeight: number;
  readonly railHeight: number;
  readonly tokenCount: number;
  readonly domainTokenCount: number;
}

export interface AtlasLayout {
  readonly normalization: AtlasNormalization;
  readonly width: number;
  readonly height: number;
  readonly columnPitch: number;
  readonly maxTokenCount: number;
  readonly columns: readonly AtlasLayoutColumn[];
}

export function atlasLayout(
  columns: readonly AtlasColumnVM[],
  normalization: AtlasNormalization,
  input: {
    readonly plotHeight: number;
    readonly columnWidth: number;
    readonly columnGap: number;
  },
): AtlasLayout {
  const height = Number.isFinite(input.plotHeight) ? Math.max(0, input.plotHeight) : 0;
  const columnWidth = Number.isFinite(input.columnWidth) ? Math.max(1, input.columnWidth) : 1;
  const columnGap = Number.isFinite(input.columnGap) ? Math.max(0, input.columnGap) : 0;
  const pitch = columnWidth + columnGap;
  const maxTokenCount = Math.max(0, ...columns.map((column) =>
    column.status === 'ready' ? column.tokenCount ?? 0 : 0));
  const layoutColumns = columns.map((column, ordinal): AtlasLayoutColumn => {
    const tokenCount = column.status === 'ready' ? column.tokenCount ?? 0 : 0;
    const domainTokenCount = normalization === 'equal' ? tokenCount : maxTokenCount;
    return {
      doc: column.doc,
      ordinal,
      x: ordinal * pitch,
      width: columnWidth,
      plotHeight: height,
      railHeight: domainTokenCount < 1 ? 0 : height * (tokenCount / domainTokenCount),
      tokenCount,
      domainTokenCount,
    };
  });
  return {
    normalization,
    width: layoutColumns.length === 0 ? 0 : layoutColumns.length * pitch - columnGap,
    height,
    columnPitch: pitch,
    maxTokenCount,
    columns: layoutColumns,
  };
}

export function atlasYForToken(
  column: AtlasLayoutColumn,
  token: number,
): number | null {
  if (
    column.tokenCount < 1
    || column.domainTokenCount < 1
    || !Number.isSafeInteger(token)
    || token < 0
    || token >= column.tokenCount
  ) return null;
  return (token / column.domainTokenCount) * column.plotHeight;
}

/** Resolve a body position and reject To-scale's visually empty tail. */
export function atlasTokenAtY(
  column: AtlasLayoutColumn,
  y: number,
): number | null {
  if (
    column.tokenCount < 1
    || column.domainTokenCount < 1
    || !Number.isFinite(y)
    || y < 0
    || y >= column.railHeight
    || column.plotHeight <= 0
  ) return null;
  return Math.min(
    column.tokenCount - 1,
    Math.floor((y / column.plotHeight) * column.domainTokenCount),
  );
}

/** Half-open visible canvas window. Every document shell can remain in the
 * DOM while only this bounded column range owns a bitmap. */
export function atlasCanvasWindow(
  layout: AtlasLayout,
  scrollLeft: number,
  viewportWidth: number,
  overscan = 2,
): { readonly start: number; readonly end: number } {
  if (
    layout.columns.length === 0
    || !Number.isFinite(viewportWidth)
    || viewportWidth <= 0
  ) return { start: 0, end: 0 };
  const left = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  const margin = Number.isSafeInteger(overscan) ? Math.max(0, overscan) : 0;
  const firstVisible = Math.min(
    layout.columns.length - 1,
    Math.floor(left / layout.columnPitch),
  );
  const start = Math.max(0, firstVisible - margin);
  const end = Math.min(
    layout.columns.length,
    Math.max(firstVisible + 1, Math.ceil((left + viewportWidth) / layout.columnPitch)) + margin,
  );
  return { start, end };
}

export interface AtlasDeviceRows {
  readonly rowCount: number;
  readonly values: Float64Array;
  readonly maxValue: number;
}

/** The one device-row allocation rule shared by paint and hit testing. */
export function atlasDeviceRowCount(
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const height = Number.isFinite(cssHeight) ? Math.max(0, cssHeight) : 0;
  const dpr = Number.isFinite(devicePixelRatio) ? Math.max(0, devicePixelRatio) : 0;
  return Math.min(ATLAS_MAX_DEVICE_ROWS, Math.ceil(height * dpr));
}

export interface AtlasTrackRail {
  readonly x: number;
  readonly width: number;
}

/** Shared horizontal rail geometry for paint and hit testing. */
export function atlasTrackRail(
  columnWidth: number,
  trackCount: number,
  trackOrdinal: number,
  padding = 10,
  gap = 3,
): AtlasTrackRail | null {
  if (
    !Number.isFinite(columnWidth)
    || columnWidth <= 0
    || !Number.isSafeInteger(trackCount)
    || trackCount < 1
    || !Number.isSafeInteger(trackOrdinal)
    || trackOrdinal < 0
    || trackOrdinal >= trackCount
  ) return null;
  const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const available = Math.max(1, columnWidth - safePadding * 2 - safeGap * (trackCount - 1));
  const width = available / trackCount;
  return {
    x: safePadding + trackOrdinal * (width + safeGap),
    width,
  };
}

/** Accumulate intervals with a difference array: O(segments + device rows),
 * never O(segments × span). Density uses its corpus-wide intensity; exact
 * occurrences contribute one and naturally darken when they share a row. */
export function atlasDeviceRows(
  segments: readonly BarcodeSegmentVM[],
  domainTokenCount: number,
  cssHeight: number,
  devicePixelRatio: number,
): AtlasDeviceRows {
  const rowCount = atlasDeviceRowCount(cssHeight, devicePixelRatio);
  if (rowCount === 0 || !Number.isSafeInteger(domainTokenCount) || domainTokenCount < 1) {
    return { rowCount: 0, values: new Float64Array(), maxValue: 0 };
  }
  const delta = new Float64Array(rowCount + 1);
  for (const segment of segments) {
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1)) continue;
    const start = Math.max(0, Math.min(domainTokenCount, segment.t0));
    const end = Math.max(start, Math.min(domainTokenCount, segment.t1));
    if (end <= start) continue;
    const from = Math.min(rowCount - 1, Math.floor((start / domainTokenCount) * rowCount));
    const to = Math.min(rowCount, Math.max(from + 1, Math.ceil((end / domainTokenCount) * rowCount)));
    const value = segment.kind === 'cell'
      ? Number.isFinite(segment.intensity) && segment.intensity > 0
        ? segment.intensity
        : 0
      : 1;
    if (value === 0) continue;
    delta[from] = delta[from]! + value;
    delta[to] = delta[to]! - value;
  }
  const values = new Float64Array(rowCount);
  let value = 0;
  let maxValue = 0;
  for (let row = 0; row < rowCount; row += 1) {
    value += delta[row]!;
    values[row] = value;
    if (value > maxValue) maxValue = value;
  }
  return { rowCount, values, maxValue };
}

export type AtlasTrackActivation =
  | { readonly kind: 'occurrence'; readonly token: number }
  | { readonly kind: 'bucket'; readonly token: number; readonly count: number }
  | { readonly kind: 'position'; readonly token: number };

/** Hit-test the same device-row projection the painter uses. Exact evidence is
 * claimed only when exactly one tick owns the row; compressed/overlapping rows
 * fall back to a position. Density cells keep their approximate bucket claim. */
export function atlasTrackActivationAt(
  track: AtlasColumnTrackVM,
  column: AtlasLayoutColumn,
  y: number,
  rowCount: number,
): AtlasTrackActivation | null {
  const token = atlasTokenAtY(column, y);
  if (token === null) return null;
  if (track.representation === 'density') {
    const cell = track.segments.find((segment) =>
      segment.kind === 'cell' && token >= segment.t0 && token < segment.t1);
    return cell?.kind === 'cell'
      ? { kind: 'bucket', token: cell.midToken, count: cell.count }
      : { kind: 'position', token };
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || column.plotHeight <= 0) {
    return { kind: 'position', token };
  }
  const row = Math.min(rowCount - 1, Math.floor((y / column.plotHeight) * rowCount));
  const candidates = track.segments.filter((segment) => {
    if (segment.kind !== 'tick') return false;
    const start = Math.max(0, Math.min(column.domainTokenCount, segment.t0));
    const end = Math.max(start, Math.min(column.domainTokenCount, segment.t1));
    if (end <= start) return false;
    const from = Math.min(
      rowCount - 1,
      Math.floor((start / column.domainTokenCount) * rowCount),
    );
    const to = Math.min(
      rowCount,
      Math.max(from + 1, Math.ceil((end / column.domainTokenCount) * rowCount)),
    );
    return row >= from && row < to;
  });
  return candidates.length === 1 && candidates[0]?.kind === 'tick'
    ? { kind: 'occurrence', token: candidates[0].t0 }
    : { kind: 'position', token };
}

/** Exact overlap counts normalize within their visible column so compressed
 * rows retain contrast. Density intensity is already normalized against the
 * track's corpus-wide maximum in barcodeTracks, so it must remain on that
 * shared absolute scale for honest cross-document comparison. */
export function atlasRowOpacity(
  value: number,
  maxValue: number,
  representation: BarcodeTrackVM['representation'],
): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ceiling = representation === 'density'
    ? Math.max(value, 1)
    : Number.isFinite(maxValue) && maxValue > 0
      ? Math.max(value, maxValue)
      : value;
  return Math.min(1, 0.18 + 0.82 * Math.sqrt(value / ceiling));
}
