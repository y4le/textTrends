import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import type { WidthClass } from './presentation.ts';
import type { CapturedTrack } from './track-legend.ts';
import type { TrendGeometry } from './trend-compact.ts';
import { barcodeBandHeight, type SequenceLayout } from './trend-geometry.ts';

export const FOOTER_SHUTTLE_MAX_OFFSET_PX = 48;
export const FOOTER_SHUTTLE_MAX_WINDOWS_PER_SECOND = 2.5;
export const FOOTER_SHUTTLE_DEFAULT_VISIBLE_TOKENS = 20;
export const FOOTER_SHUTTLE_MAX_FRAME_MS = 100;

export type PassageAlignment = 'center' | 'leading' | 'trailing';

export interface PassageTokenGeometry {
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  readonly textWidth: number;
  /** True when segment widths were not additive and exact prefix measures won. */
  readonly usedPrefixFallback: boolean;
}

export interface PassageWindowV1 {
  readonly snapshot: string;
  readonly doc: string;
  readonly pageTokens: { readonly start: number; readonly end: number };
  readonly firstVisibleToken: number;
  readonly lastVisibleToken: number;
  readonly forToken: number;
  readonly alignment: PassageAlignment;
}

export interface PassageLayoutV1 {
  readonly shiftPx: number;
  readonly visibleTokens: number;
  readonly window: PassageWindowV1;
}

type MeasureText = (text: string) => number;

/** Measure every token boundary in the exact rendered source string. The fast
 * path sums disjoint text segments (including whitespace); if shaping across a
 * segment boundary makes those widths non-additive, full-prefix measurement is
 * used for every boundary instead. */
export function passageTokenGeometry(
  text: string,
  tokenStartsUtf16: readonly number[],
  tokenEndsUtf16: readonly number[],
  measure: MeasureText,
): PassageTokenGeometry | null {
  if (tokenStartsUtf16.length === 0 || tokenStartsUtf16.length !== tokenEndsUtf16.length) {
    return null;
  }
  const offsets = new Set<number>([0, text.length]);
  let previousStart = -1;
  let previousEnd = -1;
  for (let i = 0; i < tokenStartsUtf16.length; i++) {
    const start = tokenStartsUtf16[i];
    const end = tokenEndsUtf16[i];
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start! < 0
      || end! <= start!
      || end! > text.length
      || start! < previousStart
      || end! < previousEnd
    ) return null;
    offsets.add(start!);
    offsets.add(end!);
    previousStart = start!;
    previousEnd = end!;
  }
  const ordered = [...offsets].sort((left, right) => left - right);
  const widthAt = new Map<number, number>([[0, 0]]);
  let cumulative = 0;
  let previous = 0;
  for (const offset of ordered.slice(1)) {
    const width = measure(text.slice(previous, offset));
    if (!Number.isFinite(width) || width < 0) return null;
    cumulative += width;
    widthAt.set(offset, cumulative);
    previous = offset;
  }
  const textWidth = measure(text);
  if (!Number.isFinite(textWidth) || textWidth < 0) return null;
  const usedPrefixFallback = Math.abs(cumulative - textWidth) > 0.5;
  if (usedPrefixFallback) {
    for (const offset of ordered.slice(1)) {
      const width = measure(text.slice(0, offset));
      if (!Number.isFinite(width) || width < 0) return null;
      widthAt.set(offset, width);
    }
  }
  return {
    starts: Float64Array.from(tokenStartsUtf16, (offset) => widthAt.get(offset) ?? 0),
    ends: Float64Array.from(tokenEndsUtf16, (offset) => widthAt.get(offset) ?? 0),
    textWidth,
    usedPrefixFallback,
  };
}

function visiblePassageInterval(
  geometry: PassageTokenGeometry,
  lo: number,
  hi: number,
  anchor: number,
): { readonly first: number; readonly last: number } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < geometry.starts.length; i++) {
    if (geometry.starts[i]! >= lo - 0.5 && geometry.ends[i]! <= hi + 0.5) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < 0) return { first: anchor, last: anchor };
  return {
    first: Math.min(first, anchor),
    last: Math.max(last, anchor),
  };
}

/** Resolve the source interval actually visible in the clipped footer lane.
 * Leading/trailing alignments put the cursor token at the relevant viewport
 * edge, which makes adjacent keyboard pages share exactly that boundary token. */
export function passageLayout(
  page: ReaderPageResultV1,
  snapshot: string,
  forToken: number,
  alignment: PassageAlignment,
  containerWidth: number,
  crosshairX: number,
  geometry: PassageTokenGeometry,
): PassageLayoutV1 | null {
  const relative = forToken - page.tokens.start;
  if (
    relative < 0
    || relative >= geometry.starts.length
    || !Number.isFinite(containerWidth)
    || containerWidth <= 0
    || !Number.isFinite(crosshairX)
  ) return null;
  const start = geometry.starts[relative]!;
  const end = geometry.ends[relative]!;
  const boundedCrosshair = Math.max(0, Math.min(containerWidth, crosshairX));
  const shiftPx = alignment === 'leading'
    ? boundedCrosshair + start
    : alignment === 'trailing'
      ? boundedCrosshair + end - containerWidth
      : (start + end) / 2;
  const lo = shiftPx - boundedCrosshair;
  const interval = visiblePassageInterval(geometry, lo, lo + containerWidth, relative);
  return {
    shiftPx,
    visibleTokens: interval.last - interval.first + 1,
    window: {
      snapshot,
      doc: page.doc,
      pageTokens: page.tokens,
      firstVisibleToken: page.tokens.start + interval.first,
      lastVisibleToken: page.tokens.start + interval.last,
      forToken,
      alignment,
    },
  };
}

/** One rendered-page step with a one-token seam whenever the current window
 * reaches beyond its anchor. A one-token window cannot retain overlap without
 * livelocking, so the caller receives at least ±1 and the seam stays adjacent. */
export function nextPassageToken(
  window: PassageWindowV1,
  direction: 1 | -1,
): { readonly token: number; readonly alignment: PassageAlignment } {
  const edge = direction === 1
    ? window.lastVisibleToken
    : window.firstVisibleToken;
  return {
    token: direction === 1
      ? Math.max(window.forToken + 1, edge)
      : Math.min(window.forToken - 1, edge),
    alignment: direction === 1 ? 'leading' : 'trailing',
  };
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

/** Signed reading rate for the explicit footer drag-shuttle. The quadratic
 * curve gives precise control near the press point and a bounded skim rate at
 * larger offsets. A "window" is the number of source tokens visibly fitting
 * in the passage lane. */
export function footerShuttleRate(
  offsetPx: number,
  visibleTokens: number,
): number {
  if (!Number.isFinite(offsetPx) || !Number.isFinite(visibleTokens) || visibleTokens <= 0) {
    return 0;
  }
  const normalized = Math.min(1, Math.abs(offsetPx) / FOOTER_SHUTTLE_MAX_OFFSET_PX);
  return Math.sign(offsetPx)
    * visibleTokens
    * FOOTER_SHUTTLE_MAX_WINDOWS_PER_SECOND
    * normalized ** 2;
}

export interface FooterShuttleAdvance {
  /** Fractional declared-sequence position, expressed at token centres. */
  readonly position: number;
  readonly docOrdinal: number;
  readonly token: number;
}

/** Advance a fractional reading position through declared document order.
 * Long background-frame gaps are capped so switching tabs never skips source;
 * corpus edges clamp rather than wrapping. */
export function advanceFooterShuttle(
  layout: SequenceLayout,
  position: number,
  rateTokensPerSecond: number,
  elapsedMs: number,
): FooterShuttleAdvance | null {
  if (
    layout.totalTokens <= 0
    || !Number.isFinite(position)
    || !Number.isFinite(rateTokensPerSecond)
    || !Number.isFinite(elapsedMs)
  ) return null;
  const boundedElapsed = Math.max(0, Math.min(FOOTER_SHUTTLE_MAX_FRAME_MS, elapsedMs));
  const next = Math.max(
    0.5,
    Math.min(
      layout.totalTokens - 0.5,
      position + rateTokensPerSecond * boundedElapsed / 1_000,
    ),
  );
  const globalToken = Math.floor(next);
  for (let d = 0; d < layout.tokenCounts.length; d++) {
    const count = layout.tokenCounts[d] ?? 0;
    const base = layout.bases[d] ?? 0;
    if (count > 0 && globalToken >= base && globalToken < base + count) {
      return { position: next, docOrdinal: d, token: globalToken - base };
    }
  }
  return null;
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
  /** The last authenticated page remains resident while a newer target is
   * requested. Request status and source residency are independent concerns. */
  readonly page: ReaderPageResultV1 | null;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready' }
    | { readonly status: 'error'; readonly message: string };
}

export interface FooterPassageDisplay {
  readonly page: ReaderPageResultV1;
  /** The token whose source is aligned to the passage lane. */
  readonly token: number;
  /** True when the resident page does not contain the current scrub target. */
  readonly stale: boolean;
}

/** Resolve the honest resident source presentation independently of request
 * status. A stale page holds at the nearest authenticated page edge while the
 * cursor crosses it; unrelated-document seeks fall back to the validated
 * request anchor. It never aligns to text the resident page does not contain. */
export function footerPassageDisplay(
  passage: FooterPassageLike | null,
  target: { readonly doc: string; readonly token: number } | null,
  snapshot: string,
): FooterPassageDisplay | null {
  const page = passage?.snapshot === snapshot ? passage.page : null;
  if (page === null || target === null) return null;
  const serves = page.doc === target.doc
    && target.token >= page.tokens.start
    && target.token < page.tokens.end;
  const anchor = page.anchor?.token;
  const token = serves
    ? target.token
    : page.doc === target.doc && target.token >= page.tokens.end
      ? page.tokens.end - 1
      : page.doc === target.doc && target.token < page.tokens.start
        ? page.tokens.start
        : Number.isSafeInteger(anchor)
        && anchor! >= page.tokens.start
        && anchor! < page.tokens.end
          ? anchor!
          : page.tokens.start;
  return { page, token, stale: !serves };
}

/** A resident source slice serves every cursor token inside its half-open span. */
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
    || passage.page === null
    || passage.page.doc !== target.doc
    || target.token < passage.page.tokens.start
    || target.token >= passage.page.tokens.end
  ) return false;
  return passage.tracks.every(
    (track) => liveIdentityOf(track.seriesId) === track.identity,
  );
}
