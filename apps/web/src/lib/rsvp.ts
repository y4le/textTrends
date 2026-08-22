import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';

export const RSVP_DEFAULT_WPM = 300;
export const RSVP_MIN_WPM = 100;
export const RSVP_MAX_WPM = 900;
export const RSVP_WPM_STEP = 25;
export const RSVP_SENTENCE_PAUSE_MS = 500;
export const RSVP_PARAGRAPH_PAUSE_MS = 900;
export const RSVP_MIN_HOLD_MS = 60;

const MEAN_WORD_GRAPHEMES = 4.7;
const MIN_LENGTH_WEIGHT = 0.75;
const MAX_LENGTH_WEIGHT = 1.75;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface RsvpWordFrame {
  readonly token: number;
  readonly bare: string;
  readonly display: string;
  readonly before: string;
  readonly anchor: string;
  readonly after: string;
  readonly graphemeCount: number;
  readonly sentenceEnd: boolean;
  readonly paragraphEnd: boolean;
}

export function rsvpGraphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

/** Stable, centre-left anchor convention. The optimal-viewing-position
 *  literature motivates the side of centre, not a recognition-speed claim. */
export function rsvpAnchorIndex(graphemeCount: number): number {
  if (!Number.isSafeInteger(graphemeCount) || graphemeCount < 1) return 0;
  if (graphemeCount <= 1) return 0;
  if (graphemeCount <= 5) return 1;
  if (graphemeCount <= 9) return 2;
  if (graphemeCount <= 13) return 3;
  return 4;
}

export function clampRsvpWpm(value: number): number {
  if (!Number.isFinite(value)) return RSVP_DEFAULT_WPM;
  return Math.min(RSVP_MAX_WPM, Math.max(RSVP_MIN_WPM, Math.round(value)));
}

function includesBoundary(bounds: readonly number[], boundary: number): boolean {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = bounds[mid] as number;
    if (candidate < boundary) lo = mid + 1;
    else hi = mid;
  }
  return bounds[lo] === boundary;
}

function trailingPunctuationEnd(text: string, start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit) {
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (/\s/u.test(character)) break;
    cursor += character.length;
  }
  return cursor;
}

function attachedLeadingStart(
  text: string,
  previousEnd: number,
  tokenStart: number,
): number {
  const gap = text.slice(previousEnd, tokenStart);
  let lastWhitespaceEnd = -1;
  for (let cursor = 0; cursor < gap.length;) {
    const codePoint = gap.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    cursor += character.length;
    if (/\s/u.test(character)) lastWhitespaceEnd = cursor;
  }
  return lastWhitespaceEnd >= 0 && lastWhitespaceEnd < gap.length
    ? previousEnd + lastWhitespaceEnd
    : tokenStart;
}

/** Build one visual frame exclusively from authenticated Reader offsets.
 *  Attached punctuation is visible but the anchor and timing length are
 *  derived from the bare word-like token. */
export function rsvpWordFrame(
  page: Pick<
    ReaderPageResultV1,
    | 'text'
    | 'tokens'
    | 'tokenStartsUtf16'
    | 'tokenEndsUtf16'
    | 'sentenceBounds'
    | 'paragraphBounds'
  >,
  relativeToken: number,
): RsvpWordFrame {
  const tokenCount = page.tokens.end - page.tokens.start;
  if (!Number.isSafeInteger(relativeToken) || relativeToken < 0 || relativeToken >= tokenCount) {
    throw new RangeError('RSVP token is outside the served reader page');
  }
  const tokenStart = page.tokenStartsUtf16[relativeToken];
  const tokenEnd = page.tokenEndsUtf16[relativeToken];
  if (tokenStart === undefined || tokenEnd === undefined || tokenStart >= tokenEnd) {
    throw new RangeError('RSVP token has invalid source offsets');
  }
  const previousEnd = relativeToken > 0
    ? page.tokenEndsUtf16[relativeToken - 1]
    : undefined;
  const displayStart = previousEnd === undefined
    ? tokenStart
    : attachedLeadingStart(page.text, previousEnd, tokenStart);
  const nextStart = page.tokenStartsUtf16[relativeToken + 1] ?? page.text.length;
  const displayEnd = trailingPunctuationEnd(page.text, tokenEnd, nextStart);
  const bare = page.text.slice(tokenStart, tokenEnd);
  const graphemes = rsvpGraphemes(bare);
  const anchorIndex = rsvpAnchorIndex(graphemes.length);
  const leading = page.text.slice(displayStart, tokenStart);
  const trailing = page.text.slice(tokenEnd, displayEnd);
  const before = leading + graphemes.slice(0, anchorIndex).join('');
  const anchor = graphemes[anchorIndex] ?? '';
  const after = graphemes.slice(anchorIndex + 1).join('') + trailing;
  const boundary = relativeToken + 1;
  return {
    token: page.tokens.start + relativeToken,
    bare,
    display: before + anchor + after,
    before,
    anchor,
    after,
    graphemeCount: graphemes.length,
    sentenceEnd: includesBoundary(page.sentenceBounds, boundary),
    paragraphEnd: includesBoundary(page.paragraphBounds, boundary),
  };
}

/** Configured WPM determines baseline exposure. Linguistic integration time
 *  is additive and deliberately rate-invariant. */
export function rsvpHoldMs(
  wpm: number,
  frame: Pick<RsvpWordFrame, 'graphemeCount' | 'sentenceEnd' | 'paragraphEnd'>,
): number {
  const pace = clampRsvpWpm(wpm);
  const weight = Math.min(
    MAX_LENGTH_WEIGHT,
    Math.max(MIN_LENGTH_WEIGHT, frame.graphemeCount / MEAN_WORD_GRAPHEMES),
  );
  const wordHold = Math.max(RSVP_MIN_HOLD_MS, Math.round((60_000 / pace) * weight));
  const boundaryHold = frame.paragraphEnd
    ? RSVP_PARAGRAPH_PAUSE_MS
    : frame.sentenceEnd
      ? RSVP_SENTENCE_PAUSE_MS
      : 0;
  return wordHold + boundaryHold;
}
