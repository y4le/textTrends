import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';

export const RSVP_DEFAULT_WPM = 300;
export const RSVP_MIN_WPM = 100;
export const RSVP_MAX_WPM = 900;
export const RSVP_WPM_STEP = 25;
export const RSVP_WPM_INPUT_ID = 'reader-rsvp-wpm';
export const RSVP_DEFAULT_WORDS_PER_FRAME = 1;
export const RSVP_MIN_WORDS_PER_FRAME = 1;
export const RSVP_MAX_WORDS_PER_FRAME = 3;
export const RSVP_COMPACT_MAX_WORDS_PER_FRAME = 2;
export const RSVP_DEFAULT_SENTENCE_PAUSE_MS = 350;
export const RSVP_MAX_SENTENCE_PAUSE_MS = 800;
export const RSVP_SENTENCE_PAUSE_STEP_MS = 50;
export const RSVP_DEFAULT_PARAGRAPH_PAUSE_MS = 700;
export const RSVP_MAX_PARAGRAPH_PAUSE_MS = 1_500;
export const RSVP_PARAGRAPH_PAUSE_STEP_MS = 100;
export const RSVP_DEFAULT_LENGTH_EMPHASIS = 100;
export const RSVP_MAX_LENGTH_EMPHASIS = 100;
export const RSVP_LENGTH_EMPHASIS_STEP = 25;
export const RSVP_REST_CUE_MIN_MS = 150;
export const RSVP_MIN_HOLD_MS = 60;
export const RSVP_FRAME_GRAPHEME_BUDGET_PER_WORD = 10;
export const RSVP_CONTEXT_TOKENS_PER_SIDE = 40;

export const RSVP_CLAUSE_MARKS = Object.freeze([
  ',', '、', '，',
  ';', ':', '；', '：',
  '–', '—', '…',
  ')', ']', '}', '）',
] as const);

/** Compatibility names for the active Natural defaults. */
export const RSVP_SENTENCE_PAUSE_MS = RSVP_DEFAULT_SENTENCE_PAUSE_MS;
export const RSVP_PARAGRAPH_PAUSE_MS = RSVP_DEFAULT_PARAGRAPH_PAUSE_MS;

const MEAN_WORD_GRAPHEMES = 4.7;
const MIN_LENGTH_WEIGHT = 0.75;
const MAX_LENGTH_WEIGHT = 1.75;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface RsvpPacing {
  readonly wpm: number;
  readonly wordsPerFrame: number;
  readonly sentencePauseMs: number;
  readonly paragraphPauseMs: number;
  readonly lengthEmphasis: number;
}

export type RsvpRhythm = Omit<RsvpPacing, 'wpm' | 'wordsPerFrame'>;
export type RsvpRhythmReset = RsvpRhythm & Pick<RsvpPacing, 'wpm'>;
export type RsvpRhythmPreset = 'even' | 'natural' | 'study';
export type RsvpRhythmPresetSelection = RsvpRhythmPreset | 'custom';

export const RSVP_PACING_DEFAULTS: RsvpPacing = Object.freeze({
  wpm: RSVP_DEFAULT_WPM,
  wordsPerFrame: RSVP_DEFAULT_WORDS_PER_FRAME,
  sentencePauseMs: RSVP_DEFAULT_SENTENCE_PAUSE_MS,
  paragraphPauseMs: RSVP_DEFAULT_PARAGRAPH_PAUSE_MS,
  lengthEmphasis: RSVP_DEFAULT_LENGTH_EMPHASIS,
});

export const RSVP_RHYTHM_PRESETS: Readonly<Record<RsvpRhythmPreset, RsvpRhythm>> = Object.freeze({
  even: Object.freeze({
    sentencePauseMs: 0,
    paragraphPauseMs: 0,
    lengthEmphasis: 0,
  }),
  natural: Object.freeze({
    sentencePauseMs: 350,
    paragraphPauseMs: 700,
    lengthEmphasis: 100,
  }),
  study: Object.freeze({
    sentencePauseMs: 500,
    paragraphPauseMs: 900,
    lengthEmphasis: 100,
  }),
});

/** A rhythm reset also restores set pace, but deliberately leaves the
 * independent words-at-once display preference untouched. */
export const RSVP_RHYTHM_RESET: Readonly<RsvpRhythmReset> = Object.freeze({
  wpm: RSVP_DEFAULT_WPM,
  ...RSVP_RHYTHM_PRESETS.natural,
});

export interface RsvpWordFrame {
  readonly token: number;
  readonly bare: string;
  readonly display: string;
  readonly before: string;
  readonly anchor: string;
  readonly after: string;
  readonly graphemeCount: number;
  readonly trailing: string;
  readonly sentenceEnd: boolean;
  readonly paragraphEnd: boolean;
  readonly displayStartUtf16: number;
  readonly displayEndUtf16: number;
}

export interface RsvpFrame {
  readonly startToken: number;
  readonly words: readonly RsvpWordFrame[];
  readonly text: string;
  readonly before: string;
  readonly anchor: string;
  readonly after: string;
  readonly sentenceEnd: boolean;
  readonly paragraphEnd: boolean;
}

export interface RsvpFrameTiming {
  readonly wordMs: number;
  readonly pauseMs: number;
}

export interface RsvpPausedContext {
  readonly text: string;
  readonly before: string;
  readonly current: string;
  readonly after: string;
  readonly leadingEllipsis: boolean;
  readonly trailingEllipsis: boolean;
}

export function rsvpGraphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

const rsvpClauseMarkSet: ReadonlySet<string> = new Set(RSVP_CLAUSE_MARKS);

export function rsvpHasClauseMark(value: string): boolean {
  for (const part of graphemeSegmenter.segment(value)) {
    if (rsvpClauseMarkSet.has(part.segment)) return true;
  }
  return false;
}

/** Stable, centre-left anchor convention. The optimal-viewing-position
 * literature motivates the side of centre, not a recognition-speed claim. */
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

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampRsvpPacing(value: Partial<RsvpPacing> = {}): RsvpPacing {
  const sentencePauseMs = boundedInteger(
    value.sentencePauseMs,
    RSVP_PACING_DEFAULTS.sentencePauseMs,
    0,
    RSVP_MAX_SENTENCE_PAUSE_MS,
  );
  const paragraphPauseMs = Math.max(
    sentencePauseMs,
    boundedInteger(
      value.paragraphPauseMs,
      RSVP_PACING_DEFAULTS.paragraphPauseMs,
      0,
      RSVP_MAX_PARAGRAPH_PAUSE_MS,
    ),
  );
  return {
    wpm: clampRsvpWpm(value.wpm ?? RSVP_PACING_DEFAULTS.wpm),
    wordsPerFrame: boundedInteger(
      value.wordsPerFrame,
      RSVP_PACING_DEFAULTS.wordsPerFrame,
      RSVP_MIN_WORDS_PER_FRAME,
      RSVP_MAX_WORDS_PER_FRAME,
    ),
    sentencePauseMs,
    paragraphPauseMs,
    lengthEmphasis: boundedInteger(
      value.lengthEmphasis,
      RSVP_PACING_DEFAULTS.lengthEmphasis,
      0,
      RSVP_MAX_LENGTH_EMPHASIS,
    ),
  };
}

export function effectiveRsvpWordsPerFrame(wordsPerFrame: number, compact: boolean): number {
  const authored = boundedInteger(
    wordsPerFrame,
    RSVP_DEFAULT_WORDS_PER_FRAME,
    RSVP_MIN_WORDS_PER_FRAME,
    RSVP_MAX_WORDS_PER_FRAME,
  );
  return compact ? Math.min(authored, RSVP_COMPACT_MAX_WORDS_PER_FRAME) : authored;
}

export function rsvpPresetSelection(pacing: RsvpPacing): RsvpRhythmPresetSelection {
  for (const name of ['even', 'natural', 'study'] as const) {
    const preset = RSVP_RHYTHM_PRESETS[name];
    if (
      pacing.sentencePauseMs === preset.sentencePauseMs
      && pacing.paragraphPauseMs === preset.paragraphPauseMs
      && pacing.lengthEmphasis === preset.lengthEmphasis
    ) return name;
  }
  return 'custom';
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

function attachedLeadingStart(text: string, previousEnd: number, tokenStart: number): number {
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

/** Build one visual word exclusively from authenticated Reader offsets.
 * Attached punctuation is visible but the anchor and timing length are
 * derived from the bare word-like token. */
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
  const previousEnd = relativeToken > 0 ? page.tokenEndsUtf16[relativeToken - 1] : undefined;
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
    trailing,
    sentenceEnd: includesBoundary(page.sentenceBounds, boundary),
    paragraphEnd: includesBoundary(page.paragraphBounds, boundary),
    displayStartUtf16: displayStart,
    displayEndUtf16: displayEnd,
  };
}

function collapseFrameWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ');
}

export type RsvpFramePage = Pick<
  ReaderPageResultV1,
  | 'text'
  | 'tokens'
  | 'tokenStartsUtf16'
  | 'tokenEndsUtf16'
  | 'sentenceBounds'
  | 'paragraphBounds'
>;

function rsvpIsFrameStop(
  page: RsvpFramePage,
  relativeToken: number,
  word: RsvpWordFrame,
): boolean {
  return word.sentenceEnd
    || word.paragraphEnd
    || rsvpHasClauseMark(word.trailing)
    || relativeToken + 1 >= page.tokens.end - page.tokens.start;
}

function renderedFrameText(
  page: RsvpFramePage,
  first: RsvpWordFrame,
  last: RsvpWordFrame,
): string {
  return collapseFrameWhitespace(
    page.text.slice(first.displayStartUtf16, last.displayEndUtf16),
  );
}

/** Build a consecutive frame without crossing an authored integration
 * boundary or the resident source window. The first word always owns the ORP. */
export function rsvpFrameAt(
  page: RsvpFramePage,
  relativeToken: number,
  wordsPerFrame: number,
): RsvpFrame {
  const maximum = effectiveRsvpWordsPerFrame(wordsPerFrame, false);
  const budget = RSVP_FRAME_GRAPHEME_BUDGET_PER_WORD * maximum;
  const words: RsvpWordFrame[] = [];
  for (let index = relativeToken; words.length < maximum; index++) {
    const word = rsvpWordFrame(page, index);
    const first = words[0];
    if (
      first !== undefined
      && rsvpGraphemes(renderedFrameText(page, first, word)).length > budget
    ) break;
    words.push(word);
    if (rsvpIsFrameStop(page, index, word)) break;
  }

  if (words.length === RSVP_MAX_WORDS_PER_FRAME) {
    const lastRelativeToken = relativeToken + words.length - 1;
    const last = words.at(-1)!;
    const nextRelativeToken = lastRelativeToken + 1;
    const tokenCount = page.tokens.end - page.tokens.start;
    if (
      !rsvpIsFrameStop(page, lastRelativeToken, last)
      && nextRelativeToken < tokenCount
    ) {
      const next = rsvpWordFrame(page, nextRelativeToken);
      if (rsvpIsFrameStop(page, nextRelativeToken, next)) words.pop();
    }
  }
  const first = words[0]!;
  const last = words.at(-1)!;
  const after = collapseFrameWhitespace(
    first.after + page.text.slice(first.displayEndUtf16, last.displayEndUtf16),
  );
  const before = collapseFrameWhitespace(first.before);
  return {
    startToken: first.token,
    words,
    text: before + first.anchor + after,
    before,
    anchor: first.anchor,
    after,
    sentenceEnd: last.sentenceEnd,
    paragraphEnd: last.paragraphEnd,
  };
}

/** Return a page-relative resident frame start strictly before the live
 * page-relative token. The canonical forward partition begins after the
 * nearest hard stop, so reverse navigation cannot disagree with framing. */
export function rsvpPreviousFrameStart(
  page: RsvpFramePage,
  relativeToken: number,
  wordsPerFrame: number,
): number {
  const tokenCount = page.tokens.end - page.tokens.start;
  if (!Number.isSafeInteger(relativeToken) || relativeToken < 0 || relativeToken >= tokenCount) {
    throw new RangeError('RSVP token is outside the served reader page');
  }

  let partitionStart = 0;
  for (let index = relativeToken - 1; index >= 0; index--) {
    const word = rsvpWordFrame(page, index);
    if (rsvpIsFrameStop(page, index, word)) {
      if (index + 1 === relativeToken) continue;
      partitionStart = index + 1;
      break;
    }
  }

  let previous = relativeToken;
  for (let index = partitionStart; index < relativeToken;) {
    previous = index;
    const frame = rsvpFrameAt(page, index, wordsPerFrame);
    index += frame.words.length;
  }
  return previous;
}

/** Return an exact, resident-only sentence slice around the current frame.
 * Missing sentence bounds mean the served window truncated that side. */
export function rsvpPausedContext(
  page: RsvpFramePage,
  frame: RsvpFrame,
  contextTokensPerSide = RSVP_CONTEXT_TOKENS_PER_SIDE,
): RsvpPausedContext {
  if (!Number.isSafeInteger(contextTokensPerSide) || contextTokensPerSide < 0) {
    throw new RangeError('RSVP context limit must be a non-negative integer');
  }
  const tokenCount = page.tokens.end - page.tokens.start;
  const frameStart = frame.startToken - page.tokens.start;
  const frameEnd = frameStart + frame.words.length;
  if (
    frame.words.length < 1
    || frameStart < 0
    || frameEnd > tokenCount
    || frame.words.some((word, index) => word.token !== frame.startToken + index)
  ) throw new RangeError('RSVP frame is outside the served reader page');

  let sentenceStart = 0;
  let hasSentenceStart = false;
  let sentenceEnd = tokenCount;
  let hasSentenceEnd = false;
  for (const boundary of page.sentenceBounds) {
    if (boundary <= frameStart) {
      sentenceStart = boundary;
      hasSentenceStart = true;
      continue;
    }
    if (boundary >= frameEnd) {
      sentenceEnd = boundary;
      hasSentenceEnd = true;
      break;
    }
  }

  const contextStart = Math.max(sentenceStart, frameStart - contextTokensPerSide);
  const contextEnd = Math.min(sentenceEnd, frameEnd + contextTokensPerSide);
  const first = rsvpWordFrame(page, contextStart);
  const last = rsvpWordFrame(page, contextEnd - 1);
  const currentFirst = rsvpWordFrame(page, frameStart);
  const currentLast = rsvpWordFrame(page, frameEnd - 1);
  const sourceStart = first.displayStartUtf16;
  const sourceEnd = last.displayEndUtf16;
  const currentStart = currentFirst.displayStartUtf16;
  const currentEnd = currentLast.displayEndUtf16;
  return {
    text: page.text.slice(sourceStart, sourceEnd),
    before: page.text.slice(sourceStart, currentStart),
    current: page.text.slice(currentStart, currentEnd),
    after: page.text.slice(currentEnd, sourceEnd),
    leadingEllipsis: !hasSentenceStart || contextStart > sentenceStart,
    trailingEllipsis: !hasSentenceEnd || contextEnd < sentenceEnd,
  };
}

export function rsvpWordMs(
  pacing: RsvpPacing,
  word: Pick<RsvpWordFrame, 'graphemeCount'>,
): number {
  const bounded = clampRsvpPacing(pacing);
  const lengthWeight = Math.min(
    MAX_LENGTH_WEIGHT,
    Math.max(MIN_LENGTH_WEIGHT, word.graphemeCount / MEAN_WORD_GRAPHEMES),
  );
  const emphasis = bounded.lengthEmphasis / 100;
  const weight = 1 + emphasis * (lengthWeight - 1);
  return Math.max(RSVP_MIN_HOLD_MS, Math.round((60_000 / bounded.wpm) * weight));
}

export function rsvpFrameTiming(pacing: RsvpPacing, frame: RsvpFrame): RsvpFrameTiming {
  const bounded = clampRsvpPacing(pacing);
  const wordMs = frame.words.reduce((total, word) => total + rsvpWordMs(bounded, word), 0);
  const pauseMs = frame.paragraphEnd
    ? bounded.paragraphPauseMs
    : frame.sentenceEnd
      ? bounded.sentencePauseMs
      : 0;
  return { wordMs, pauseMs };
}

export function rsvpFrameHoldMs(pacing: RsvpPacing, frame: RsvpFrame): number {
  const timing = rsvpFrameTiming(pacing, frame);
  return timing.wordMs + timing.pauseMs;
}
