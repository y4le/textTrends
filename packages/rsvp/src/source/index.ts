import type { RsvpPlaybackSource } from '../rsvp.ts';

export interface CreateRsvpSourceOptions {
  readonly locale?: string | readonly string[];
}

// Deliberately mirrored in @texttrends/core's Intl adapter. Core's copy is
// fingerprinted while this dependency-free convenience source is not;
// apps/web/test/segmentation-parity.test.ts pins their public behavior.
const ENGLISH_PREFIX_TITLES = [
  'Mr', 'Mrs', 'Ms', 'Mx', 'Messrs', 'Mmes', 'Mme', 'Mlle',
  'Dr', 'Prof', 'Rev', 'Fr', 'Hon',
  'Capt', 'Cmdr', 'Col', 'Cpl', 'Gen', 'Lt', 'Maj', 'Sgt', 'Adm',
  'Gov', 'Sen', 'Rep',
] as const;
const ENGLISH_TITLE_FORMS = ENGLISH_PREFIX_TITLES.flatMap((title) => [title, title.toUpperCase()]);
const ENGLISH_TITLE_BEFORE_RE = new RegExp(
  String.raw`(?:${ENGLISH_TITLE_FORMS.join('|')})\.[\p{Zs}\t]*$`,
  'u',
);
const WORD_FORMING_RE = /[\p{L}\p{N}_'’]/u;
const FOLLOWING_WORD_RE = /^[\p{L}\p{N}'’-]+/u;
const SENTENCE_STARTERS: ReadonlySet<string> = new Set(`
  the then this that there these those here
  he she it they we you i his her their our my your its
  but and however yet so nor or thus hence still
  after before when while if though although because since once
  now next later a an as at in on for from by with to of
  no not never nothing all both each every some such
  what who why how where which
  do did does is was were are be been have has had
  let perhaps indeed well yes oh ah
`.trim().split(/\s+/u));

function isFalseTitleBoundary(text: string, start: number, locale: string): boolean {
  if (locale.toLowerCase().split('-')[0] !== 'en') return false;

  const before = text.slice(Math.max(0, start - 24), start);
  const title = ENGLISH_TITLE_BEFORE_RE.exec(before);
  if (title === null) return false;
  if (title.index > 0 && WORD_FORMING_RE.test(before[title.index - 1]!)) return false;

  const following = FOLLOWING_WORD_RE.exec(text.slice(start, start + 32));
  return following !== null && !SENTENCE_STARTERS.has(following[0].toLowerCase());
}

function tokenBoundsAtCharStarts(
  charStarts: readonly number[],
  tokenStarts: readonly number[],
): readonly number[] {
  const bounds: number[] = [];
  let token = 0;
  for (const charStart of charStarts) {
    while (token < tokenStarts.length && tokenStarts[token]! < charStart) token++;
    if (bounds.at(-1) !== token) bounds.push(token);
  }
  if (bounds.at(-1) !== tokenStarts.length) bounds.push(tokenStarts.length);
  return bounds;
}

/**
 * Standalone paragraph policy: a new paragraph follows either a blank-line
 * gap (two line terminators separated only by spaces/tabs) or one Unicode
 * paragraph separator. CRLF is one line terminator.
 */
function paragraphCharStarts(text: string): readonly number[] {
  const starts = [0];
  const breakPattern = /(?:\u2029|(?:\r\n|\r(?!\n)|[\n\u0085\u2028])(?:[ \t]*(?:\r\n|\r(?!\n)|[\n\u0085\u2028]))+)/gu;
  for (let match = breakPattern.exec(text); match !== null; match = breakPattern.exec(text)) {
    const next = match.index + match[0].length;
    if (next < text.length) starts.push(next);
  }
  return starts;
}

/** Build a whole-document RSVP source directly from plain text.
 * Hosts with authenticated or custom tokenization can construct the same
 * structural `RsvpPlaybackSource` without using this convenience adapter.
 * An omitted locale uses the runtime's default Intl locale. */
export function createRsvpSource(
  text: string,
  options: CreateRsvpSourceOptions = {},
): RsvpPlaybackSource {
  const locale = Array.isArray(options.locale) ? [...options.locale] : options.locale;
  const wordSegmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  const tokenStartsUtf16: number[] = [];
  const tokenEndsUtf16: number[] = [];
  for (const segment of wordSegmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    tokenStartsUtf16.push(segment.index);
    tokenEndsUtf16.push(segment.index + segment.segment.length);
  }

  const sentenceSegmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const sentenceLocale = sentenceSegmenter.resolvedOptions().locale;
  const sentenceCharStarts = Array.from(sentenceSegmenter.segment(text))
    .filter((segment) => !isFalseTitleBoundary(text, segment.index, sentenceLocale))
    .map((segment) => segment.index);
  const tokenCount = tokenStartsUtf16.length;
  return {
    text,
    tokens: { start: 0, end: tokenCount },
    tokenStartsUtf16,
    tokenEndsUtf16,
    sentenceBounds: tokenBoundsAtCharStarts(sentenceCharStarts, tokenStartsUtf16),
    paragraphBounds: tokenBoundsAtCharStarts(paragraphCharStarts(text), tokenStartsUtf16),
    docTokenCount: tokenCount,
  };
}
