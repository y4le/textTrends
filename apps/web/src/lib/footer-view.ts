import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import type { WidthClass } from './presentation.ts';
import type { CapturedTrack } from './track-legend.ts';
import type { TrendGeometry } from './trend-compact.ts';
import { barcodeBandHeight, type SequenceLayout } from './trend-geometry.ts';

export const FOOTER_PASSAGE_DEBOUNCE_MS = 120;

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
  labelSpace: 0,
  strokeFocused: 1.5,
  strokeOther: 1,
  directLabels: false,
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
  labelSpace: 0,
  strokeFocused: 1.5,
  strokeOther: 1,
  directLabels: false,
  bookMarks: 'boundaries',
});

const coarseGeometry = (fine: FooterGeometry): FooterGeometry => Object.freeze({
  ...fine,
  passageHeight: 44,
  stripMinHeight: 44,
});

const COMPACT_COARSE = coarseGeometry(COMPACT_FINE);
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
    + (barcodeHeight > 0 ? geometry.barcodeBandGap + barcodeHeight : 0);
  return 1 // border-block-start is inside the border-box block size
    + 2 * geometry.padBlock
    + geometry.passageHeight
    + geometry.laneGap
    + geometry.statusHeight
    + geometry.laneGap
    + Math.max(geometry.stripMinHeight, visualStripHeight);
}

export function sequenceLayoutFor(
  docs: readonly string[],
  tokenCountOf: (doc: string) => number | undefined,
): SequenceLayout {
  const bases: number[] = [];
  const tokenCounts: number[] = [];
  let totalTokens = 0;
  for (const doc of docs) {
    bases.push(totalTokens);
    const raw = tokenCountOf(doc);
    const count = Number.isSafeInteger(raw) && (raw ?? -1) >= 0 ? raw! : 0;
    tokenCounts.push(count);
    totalTokens += count;
  }
  return { bases, tokenCounts, totalTokens };
}

export interface FooterProgress {
  readonly globalToken: number;
  readonly ratio: number;
  readonly percent: number;
}

export function corpusProgress(
  layout: SequenceLayout,
  docOrdinal: number,
  token: number,
): FooterProgress | null {
  const count = layout.tokenCounts[docOrdinal] ?? 0;
  if (
    layout.totalTokens <= 0
    || count <= 0
    || !Number.isSafeInteger(token)
    || token < 0
    || token >= count
  ) return null;
  const globalToken = (layout.bases[docOrdinal] ?? 0) + token;
  const ratio = (globalToken + 1) / layout.totalTokens;
  return { globalToken, ratio, percent: Math.round(ratio * 100) };
}

export function footerStatusText(input: {
  readonly compact: boolean;
  readonly partial: boolean;
  readonly docOrdinal: number;
  readonly docCount: number;
  readonly title: string;
  readonly token: number;
  readonly docTokenCount: number;
  readonly percent: number;
  readonly pending: boolean;
  readonly failed: number;
} | null): string {
  if (input === null) return 'no reading position';
  const position = input.compact
    ? `${(input.token + 1).toLocaleString()}/${input.docTokenCount.toLocaleString()} · ${input.percent}%`
    : `token ${(input.token + 1).toLocaleString()} of ${input.docTokenCount.toLocaleString()} · ${input.percent}% of corpus`;
  const book = input.docCount > 1
    ? `${input.docOrdinal + 1}/${input.docCount} · ${input.title}`
    : input.title;
  const suffix = input.pending
    ? ' · computing…'
    : input.failed > 0
      ? ` · ${input.failed} ${input.failed === 1 ? 'query' : 'queries'} failed`
      : '';
  return `${input.partial ? 'partial corpus · ' : ''}${book} · ${position}${suffix}`;
}

export interface FooterPassageLike {
  readonly snapshot: string;
  readonly doc: string;
  readonly tracks: readonly CapturedTrack[];
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly page: ReaderPageResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

/** A canonical reader page serves every cursor token inside its half-open span. */
export function footerPassageServes(
  passage: FooterPassageLike | null,
  target: { readonly doc: string; readonly token: number },
  snapshot: string,
  liveIdentityOf: (seriesId: string) => string | null,
): passage is FooterPassageLike & {
  readonly state: { readonly status: 'ready'; readonly page: ReaderPageResultV1 };
} {
  if (
    passage === null
    || passage.snapshot !== snapshot
    || passage.doc !== target.doc
    || passage.state.status !== 'ready'
    || passage.state.page.doc !== target.doc
    || target.token < passage.state.page.tokens.start
    || target.token >= passage.state.page.tokens.end
  ) return false;
  return passage.tracks.every(
    (track) => liveIdentityOf(track.seriesId) === track.identity,
  );
}
