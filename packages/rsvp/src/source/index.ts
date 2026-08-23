import type { RsvpPlaybackSource } from '../rsvp.ts';

export interface CreateRsvpSourceOptions {
  readonly locale?: string | readonly string[];
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
  const sentenceCharStarts = Array.from(
    sentenceSegmenter.segment(text),
    (segment) => segment.index,
  );
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
