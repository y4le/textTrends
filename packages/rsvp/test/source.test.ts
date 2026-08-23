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
