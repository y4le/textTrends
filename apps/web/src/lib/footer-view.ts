import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import type { CapturedTrack } from './track-legend.ts';
import type { SequenceLayout } from './trend-geometry.ts';

export {
  footerBlockSize,
  footerGeometryFor,
  type FooterGeometry,
} from './footer-metrics.ts';

export const FOOTER_SHUTTLE_MAX_OFFSET_PX = 48;
export const FOOTER_SHUTTLE_MAX_WINDOWS_PER_SECOND = 2.5;
export const FOOTER_SHUTTLE_DEFAULT_VISIBLE_TOKENS = 20;
export const FOOTER_SHUTTLE_MAX_FRAME_MS = 100;

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
  readonly previousPageToken: number;
  readonly nextPageToken: number;
}

export interface PassageLayoutV1 {
  readonly shiftPx: number;
  readonly visibleTokens: number;
  readonly window: PassageWindowV1;
}

/** Resolve a horizontal source-text offset to the nearest token center. The
 * offset is in the measured text's own coordinate space, not the scrollport.
 * Clamping keeps native momentum at a resident slice edge on authenticated
 * source instead of inventing a position in surrounding layout padding. */
export function passageTokenAtTextOffset(
  geometry: PassageTokenGeometry,
  offsetPx: number,
): number | null {
  if (geometry.starts.length === 0 || !Number.isFinite(offsetPx)) return null;
  let lo = 0;
  let hi = geometry.starts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const center = (geometry.starts[mid]! + geometry.ends[mid]!) / 2;
    if (center < offsetPx) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const prior = lo - 1;
  const priorCenter = (geometry.starts[prior]! + geometry.ends[prior]!) / 2;
  const nextCenter = (geometry.starts[lo]! + geometry.ends[lo]!) / 2;
  return offsetPx - priorCenter <= nextCenter - offsetPx ? prior : lo;
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

/** A conservative one-row token margin derived from the resident page's
 * measured average token width. Unlike the current visible count, this does
 * not collapse when the cursor approaches a source-slice edge, so it can be
 * used prospectively to request a new around-page before the row underfills. */
export function passageMarginTokens(
  geometry: PassageTokenGeometry,
  containerWidth: number,
): number {
  const tokens = geometry.starts.length;
  if (
    tokens === 0
    || !Number.isFinite(geometry.textWidth)
    || geometry.textWidth <= 0
    || !Number.isFinite(containerWidth)
    || containerWidth <= 0
  ) return 0;
  return Math.ceil(containerWidth * tokens / geometry.textWidth);
}

function centeredPageToken(
  geometry: PassageTokenGeometry,
  interval: { readonly first: number; readonly last: number },
  current: number,
  direction: 1 | -1,
  containerWidth: number,
  crosshairXAt: (relativeToken: number) => number,
  atStart: boolean,
  atEnd: boolean,
): number {
  const count = geometry.starts.length;
  const fallback = current + direction;
  let chosen: number | null = null;
  if (direction === 1) {
    const seam = interval.last + 1;
    for (let candidate = current + 1; candidate < count; candidate++) {
      const crosshair = Math.max(0, Math.min(containerWidth, crosshairXAt(candidate)));
      const shift = centeredPassageShift(
        geometry,
        candidate,
        containerWidth,
        crosshair,
        atStart,
        atEnd,
      );
      const candidateInterval = visiblePassageInterval(
        geometry,
        shift - crosshair,
        shift - crosshair + containerWidth,
        candidate,
      );
      if (candidateInterval.first <= seam) chosen = candidate;
    }
  } else {
    const seam = interval.first - 1;
    for (let candidate = current - 1; candidate >= 0; candidate--) {
      const crosshair = Math.max(0, Math.min(containerWidth, crosshairXAt(candidate)));
      const shift = centeredPassageShift(
        geometry,
        candidate,
        containerWidth,
        crosshair,
        atStart,
        atEnd,
      );
      const candidateInterval = visiblePassageInterval(
        geometry,
        shift - crosshair,
        shift - crosshair + containerWidth,
        candidate,
      );
      if (candidateInterval.last >= seam) chosen = candidate;
    }
  }
  return chosen ?? fallback;
}

/** Center the token over its corpus position except where that would clip the
 * token itself at a real document edge. At the edge, move only far enough to
 * keep the complete token inside the passage viewport. */
function centeredPassageShift(
  geometry: PassageTokenGeometry,
  token: number,
  containerWidth: number,
  crosshairX: number,
  atStart: boolean,
  atEnd: boolean,
): number {
  const start = geometry.starts[token]!;
  const end = geometry.ends[token]!;
  let shift = (start + end) / 2;
  if (atStart) shift = Math.min(shift, crosshairX + start);
  if (atEnd) shift = Math.max(shift, crosshairX + end - containerWidth);
  return shift;
}

/** Resolve the source interval actually visible in the clipped footer lane.
 * Interior anchors are centered over their corpus position; at a true document
 * edge the selected token shifts only enough to remain fully visible. Page
 * targets are solved from the same measured geometry so a page step remains
 * full-sized without leaving a gap in the source tokens covered by consecutive
 * rows. */
export function passageLayout(
  page: ReaderPageResultV1,
  snapshot: string,
  forToken: number,
  containerWidth: number,
  geometry: PassageTokenGeometry,
  crosshairXAtToken: (token: number) => number,
): PassageLayoutV1 | null {
  const relative = forToken - page.tokens.start;
  const crosshairX = crosshairXAtToken(forToken);
  if (
    relative < 0
    || relative >= geometry.starts.length
    || !Number.isFinite(containerWidth)
    || containerWidth <= 0
    || !Number.isFinite(crosshairX)
  ) return null;
  const boundedCrosshair = Math.max(0, Math.min(containerWidth, crosshairX));
  const shiftPx = centeredPassageShift(
    geometry,
    relative,
    containerWidth,
    boundedCrosshair,
    page.atStart,
    page.atEnd,
  );
  const lo = shiftPx - boundedCrosshair;
  const interval = visiblePassageInterval(geometry, lo, lo + containerWidth, relative);
  const relativeCrosshair = (candidate: number) => (
    crosshairXAtToken(page.tokens.start + candidate)
  );
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
      previousPageToken: page.tokens.start + centeredPageToken(
        geometry,
        interval,
        relative,
        -1,
        containerWidth,
        relativeCrosshair,
        page.atStart,
        page.atEnd,
      ),
      nextPageToken: page.tokens.start + centeredPageToken(
        geometry,
        interval,
        relative,
        1,
        containerWidth,
        relativeCrosshair,
        page.atStart,
        page.atEnd,
      ),
    },
  };
}

/** One centered rendered-page step. The target was measured with the current
 * row and is always at least one token away, including at a resident-page edge. */
export function nextPassageToken(
  window: PassageWindowV1,
  direction: 1 | -1,
): number {
  return direction === 1 ? window.nextPageToken : window.previousPageToken;
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
  /** True when the resident page cannot fill the row around the scrub target. */
  readonly stale: boolean;
}

/** Resolve the honest resident source presentation independently of request
 * status. A stale page holds at its validated around-page anchor so an
 * in-flight replacement cannot expose a short source-slice edge. It never
 * aligns to text the resident page does not contain. */
export function footerPassageDisplay(
  passage: FooterPassageLike | null,
  target: { readonly doc: string; readonly token: number } | null,
  snapshot: string,
  marginTokens = 0,
): FooterPassageDisplay | null {
  const page = passage?.snapshot === snapshot ? passage.page : null;
  if (page === null || target === null) return null;
  const anchor = page.anchor?.token;
  const serves = page.doc === target.doc
    && pageServesToken(page, target.token, marginTokens);
  const token = serves
    ? target.token
    : Number.isSafeInteger(anchor)
      && anchor! >= page.tokens.start
      && anchor! < page.tokens.end
      ? anchor!
      : page.doc === target.doc && target.token >= page.tokens.end
        ? page.tokens.end - 1
        : page.tokens.start;
  return { page, token, stale: !serves };
}

function pageServesToken(
  page: ReaderPageResultV1,
  token: number,
  marginTokens: number,
): boolean {
  if (token < page.tokens.start || token >= page.tokens.end) return false;
  if (page.anchor?.token === token) return true;
  const margin = Number.isSafeInteger(marginTokens) && marginTokens > 0
    ? marginTokens
    : 0;
  const first = page.atStart ? page.tokens.start : page.tokens.start + margin;
  const end = page.atEnd ? page.tokens.end : page.tokens.end - margin;
  return token >= first && token < end;
}

/** A resident source slice serves every cursor token inside its half-open span. */
export function footerPassageServes(
  passage: FooterPassageLike | null,
  target: { readonly doc: string; readonly token: number },
  snapshot: string,
  liveIdentityOf: (seriesId: string) => string | null,
  marginTokens = 0,
): boolean {
  if (
    passage === null
    || passage.snapshot !== snapshot
    || passage.doc !== target.doc
    || passage.page === null
    || passage.page.doc !== target.doc
    || !pageServesToken(passage.page, target.token, marginTokens)
  ) return false;
  return passage.tracks.every(
    (track) => liveIdentityOf(track.seriesId) === track.identity,
  );
}
