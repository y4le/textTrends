import { describe, expect, it } from 'vitest';
import { rsvpFrameAt, rsvpSpanPlan, RSVP_PACING_DEFAULTS } from '../src/index.ts';
import { createRsvpSource } from '@texttrends/rsvp/source';

function expectSourceInvariants(text: string): void {
  const source = createRsvpSource(text, { locale: 'en' });
  const count = source.tokens.end - source.tokens.start;
  expect(source.docTokenCount).toBe(count);
  expect(source.tokenStartsUtf16).toHaveLength(count);
  expect(source.tokenEndsUtf16).toHaveLength(count);
  for (let index = 0; index < count; index++) {
    const start = source.tokenStartsUtf16[index]!;
    const end = source.tokenEndsUtf16[index]!;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(text.length);
    if (index > 0) expect(start).toBeGreaterThanOrEqual(source.tokenEndsUtf16[index - 1]!);
  }
  for (const bounds of [source.sentenceBounds, source.paragraphBounds]) {
    expect(bounds[0]).toBe(0);
    expect(bounds.at(-1)).toBe(count);
    expect(bounds).toEqual([...new Set(bounds)].sort((left, right) => left - right));
    expect(bounds.every((bound) => bound >= 0 && bound <= count)).toBe(true);
  }
}

describe('plain-text RSVP source', () => {
  it('returns a complete empty source for text with no word-like segments', () => {
    for (const text of ['', ' \t\n', '…?! —']) {
      expect(createRsvpSource(text, { locale: 'en' })).toEqual({
        text,
        tokens: { start: 0, end: 0 },
        tokenStartsUtf16: [],
        tokenEndsUtf16: [],
        sentenceBounds: [0],
        paragraphBounds: [0],
        docTokenCount: 0,
      });
    }
  });

  it('emits exact UTF-16 slices for Unicode word-like segments', () => {
    const text = "café cafe\u0301 𝔴ord 中文 don’t 3.14";
    const source = createRsvpSource(text, { locale: 'en' });
    expect(source.tokenStartsUtf16.map((start, index) =>
      text.slice(start, source.tokenEndsUtf16[index]))).toEqual([
      'café', 'cafe\u0301', '𝔴ord', '中文', 'don’t', '3.14',
    ]);

    const graphemeBounds = new Set<number>([0, text.length]);
    for (const segment of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
      graphemeBounds.add(segment.index);
      graphemeBounds.add(segment.index + segment.segment.length);
    }
    for (const bound of [...source.tokenStartsUtf16, ...source.tokenEndsUtf16]) {
      expect(graphemeBounds.has(bound)).toBe(true);
    }
    expectSourceInvariants(text);
  });

  it('maps Intl sentence starts onto emitted token bounds', () => {
    const text = 'Hello world. … Goodbye now.';
    const source = createRsvpSource(text, { locale: 'en-US' });
    expect(source.tokenStartsUtf16.map((start, index) =>
      text.slice(start, source.tokenEndsUtf16[index]))).toEqual([
      'Hello', 'world', 'Goodbye', 'now',
    ]);
    expect(source.sentenceBounds).toEqual([0, 2, 4]);
  });

  it('suppresses false English prefix-title boundaries', () => {
    for (const title of [
      'Mr', 'Mrs', 'Ms', 'Mx', 'Messrs', 'Mmes', 'Mme', 'Mlle',
      'Dr', 'Prof', 'Rev', 'Fr', 'Hon',
      'Capt', 'Cmdr', 'Col', 'Cpl', 'Gen', 'Lt', 'Maj', 'Sgt', 'Adm',
      'Gov', 'Sen', 'Rep',
    ]) {
      const source = createRsvpSource(
        `I met ${title}. Smith yesterday. Then we left.`,
        { locale: 'en-US' },
      );
      expect(source.sentenceBounds).toEqual([0, 5, 8]);
    }
  });

  it('accepts horizontal Unicode separators after a prefix title', () => {
    for (const separator of [' ', '\u00a0', '\u202f', '\u2009', '\u3000', '\t']) {
      const source = createRsvpSource(
        `I met Mr.${separator}Smith yesterday. Then we left.`,
        { locale: 'en-US' },
      );
      expect(source.sentenceBounds).toEqual([0, 5, 8]);
    }
  });

  it('keeps real sentence ends after titles and ambiguous abbreviations', () => {
    const cases: readonly [string, readonly number[]][] = [
      ['I could not reach Mr. Then I gave up.', [0, 5, 9]],
      ['Ask Mr. Then leave.', [0, 2, 4]],
      ['We met Dr. Next sentence here.', [0, 3, 6]],
      ['He is a Jr. Next sentence here.', [0, 4, 7]],
      ['He is retiring as Sr. Next sentence here.', [0, 5, 8]],
      ['Turn left on Main St. Then walk north.', [0, 5, 8]],
      ['Item No. Then the next line.', [0, 2, 6]],
    ];
    for (const [text, bounds] of cases) {
      expect(createRsvpSource(text, { locale: 'en-US' }).sentenceBounds, text).toEqual(bounds);
    }
  });

  it('does not suppress title boundaries across line terminators', () => {
    for (const separator of ['\n', '\r\n', '\n\n', '\u0085', '\u2028', '\u2029']) {
      const source = createRsvpSource(`Mr.${separator}Jones went home.`, { locale: 'en-US' });
      expect(source.sentenceBounds, JSON.stringify(separator)).toEqual([0, 1, 4]);
      if (separator === '\n\n') expect(source.paragraphBounds).toEqual([0, 1, 4]);
    }
  });

  it('supports canonical and all-caps titles without matching word suffixes', () => {
    expect(createRsvpSource('MR. JONES went home. Next one.', { locale: 'en' }).sentenceBounds)
      .toEqual([0, 4, 6]);
    expect(createRsvpSource('Ask mr. Then leave.', { locale: 'en' }).sentenceBounds)
      .toEqual([0, 2, 4]);
    expect(createRsvpSource('I met Dmr. Jones yesterday. Then left.', { locale: 'en' }).sentenceBounds)
      .toEqual([0, 3, 5, 7]);
  });

  it('does not apply the English title policy to another resolved locale', () => {
    const text = 'Mr. Jones ging heim.';
    const rawStarts = Array.from(
      new Intl.Segmenter('de', { granularity: 'sentence' }).segment(text),
      (item) => item.index,
    );
    const source = createRsvpSource(text, { locale: 'de' });
    const sourceStarts = source.sentenceBounds.map((bound) =>
      bound === source.docTokenCount ? text.length : source.tokenStartsUtf16[bound]!,
    );
    expect(sourceStarts).toEqual([...rawStarts, text.length]);
  });

  it('uses blank lines and paragraph separators, not an ordinary line wrap', () => {
    expect(createRsvpSource('one\ntwo', { locale: 'en' }).paragraphBounds).toEqual([0, 2]);
    expect(createRsvpSource('one\r\ntwo', { locale: 'en' }).paragraphBounds).toEqual([0, 2]);
    for (const separator of [
      '\n\n',
      '\r\n\r\n',
      '\n \t\n',
      '\n\n\n',
      '\u0085\u0085',
      '\u2028 \u2028',
      '\u2029',
    ]) {
      expect(createRsvpSource(`one${separator}two`, { locale: 'en' }).paragraphBounds)
        .toEqual([0, 1, 2]);
    }
    expect(createRsvpSource('\n\none\n\n', { locale: 'en' }).paragraphBounds).toEqual([0, 1]);
  });

  it('keeps all bounds sorted, deduplicated, terminal, and in range', () => {
    for (const text of [
      'one',
      'One sentence without a terminator',
      'One.\n\nTwo!\n\n\nThree?',
      '\u2029日本語です。\u2029次です。',
    ]) expectSourceInvariants(text);
  });

  it('feeds framing and honest span planning without a TextTrends page', () => {
    const source = createRsvpSource('Read this phrase, then this sentence.', { locale: 'en' });
    const seen: string[] = [];
    let totalMs = 0;
    for (let relative = 0; relative < source.docTokenCount;) {
      const frame = rsvpFrameAt(source, relative, 3);
      seen.push(...frame.words.map((word) => word.bare));
      const plan = rsvpSpanPlan(source, relative, RSVP_PACING_DEFAULTS);
      const offset = frame.startToken - plan.startToken;
      totalMs += plan.wordMs
        .slice(offset, offset + frame.words.length)
        .reduce((total, wordMs) => total + wordMs, 0);
      if (frame.startToken + frame.words.length === plan.endToken) totalMs += plan.restMs;
      relative += frame.words.length;
    }
    expect(seen).toEqual(['Read', 'this', 'phrase', 'then', 'this', 'sentence']);
    expect(totalMs).toBe(Math.round(source.docTokenCount * 60_000 / RSVP_PACING_DEFAULTS.wpm));
  });
});
