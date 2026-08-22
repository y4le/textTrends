import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import {
  RSVP_FRAME_GRAPHEME_BUDGET_PER_WORD,
  RSVP_MIN_HOLD_MS,
  RSVP_PACING_DEFAULTS,
  RSVP_PARAGRAPH_PAUSE_MS,
  RSVP_RHYTHM_PRESETS,
  RSVP_SENTENCE_PAUSE_MS,
  clampRsvpPacing,
  clampRsvpWpm,
  effectiveRsvpWordsPerFrame,
  rsvpAnchorIndex,
  rsvpFrameAt,
  rsvpFrameHoldMs,
  rsvpFrameTiming,
  rsvpGraphemes,
  rsvpHasClauseMark,
  rsvpPreviousFrameStart,
  rsvpPresetSelection,
  rsvpWordMs,
  rsvpWordFrame,
} from '../src/lib/rsvp.ts';

function page(text = 'he said, “Yes.” Then—left'): ReaderPageResultV1 {
  return {
    method: 'reader-page/1',
    doc: 'a',
    tokens: { start: 10, end: 15 },
    docCharsUtf16: { start: 100, end: 125 },
    text,
    tokenStartsUtf16: [0, 3, 10, 16, 21],
    tokenEndsUtf16: [2, 7, 13, 20, 25],
    sentenceBounds: [0, 3, 5],
    paragraphBounds: [0, 5],
    anchor: null,
    previous: { kind: 'before', token: 10 },
    next: { kind: 'from', token: 15 },
    atStart: false,
    atEnd: false,
    docTokenCount: 40,
    cappedBy: 'tokens',
    marks: [],
    marksTruncated: false,
  };
}

function textPage(
  text: string,
  sentenceBounds?: readonly number[],
  paragraphBounds?: readonly number[],
): ReaderPageResultV1 {
  const matches = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu));
  const tokenCount = matches.length;
  return {
    method: 'reader-page/1',
    doc: 'phrase',
    tokens: { start: 0, end: tokenCount },
    docCharsUtf16: { start: 0, end: text.length },
    text,
    tokenStartsUtf16: matches.map((match) => match.index),
    tokenEndsUtf16: matches.map((match) => match.index + match[0].length),
    sentenceBounds: sentenceBounds ?? [0, tokenCount],
    paragraphBounds: paragraphBounds ?? [0, tokenCount],
    anchor: null,
    previous: null,
    next: null,
    atStart: true,
    atEnd: true,
    docTokenCount: tokenCount,
    cappedBy: null,
    marks: [],
    marksTruncated: false,
  };
}

function frameSizes(source: ReaderPageResultV1, wordsPerFrame: number): number[] {
  const sizes: number[] = [];
  let relative = 0;
  while (relative < source.tokens.end - source.tokens.start) {
    const frame = rsvpFrameAt(source, relative, wordsPerFrame);
    sizes.push(frame.words.length);
    relative += frame.words.length;
  }
  return sizes;
}

describe('RSVP focal presentation', () => {
  it('keeps the anchor monotone and never beyond the right-middle grapheme', () => {
    expect([0, 1, 2, 5, 6, 9, 10, 13, 14, 40].map(rsvpAnchorIndex))
      .toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    let previous = 0;
    for (let length = 1; length <= 40; length++) {
      const anchor = rsvpAnchorIndex(length);
      expect(anchor).toBeGreaterThanOrEqual(previous);
      expect(anchor).toBeLessThanOrEqual(Math.floor(length / 2));
      previous = anchor;
    }
  });

  it('segments composed, decomposed, combining, and astral graphemes intact', () => {
    expect(rsvpGraphemes('café')).toHaveLength(4);
    expect(rsvpGraphemes('cafe\u0301')).toEqual(['c', 'a', 'f', 'e\u0301']);
    expect(rsvpGraphemes('naïve')).toHaveLength(5);
    expect(rsvpGraphemes('a𝔴b')).toEqual(['a', '𝔴', 'b']);
  });

  it('renders attached punctuation without letting it move the bare-word anchor', () => {
    expect(rsvpWordFrame(page(), 0)).toMatchObject({
      bare: 'he', display: 'he', before: 'h', anchor: 'e', after: '',
    });
    expect(rsvpWordFrame(page(), 1)).toMatchObject({
      bare: 'said', display: 'said,', before: 's', anchor: 'a', after: 'id,',
    });
    expect(rsvpWordFrame(page(), 2)).toMatchObject({
      bare: 'Yes', display: '“Yes.”', before: '“Y', anchor: 'e', after: 's.”',
      sentenceEnd: true,
    });
    expect(rsvpWordFrame(page(), 3)).toMatchObject({
      bare: 'Then', display: 'Then—', before: 'T', anchor: 'h', after: 'en—',
    });
    expect(rsvpWordFrame(page(), 4)).toMatchObject({
      bare: 'left', display: 'left',
      paragraphEnd: true,
    });
  });

  it('rejects a token outside the authenticated page', () => {
    expect(() => rsvpWordFrame(page(), -1)).toThrow(RangeError);
    expect(() => rsvpWordFrame(page(), 5)).toThrow(RangeError);
  });

  it('builds exact-source multi-word frames without crossing authored boundaries', () => {
    const first = rsvpFrameAt(page(), 0, 3);
    expect(first.words.map((word) => word.token)).toEqual([10, 11]);
    expect(first).toMatchObject({
      startToken: 10,
      text: 'he said,',
      before: 'h',
      anchor: 'e',
      after: ' said,',
      sentenceEnd: false,
      paragraphEnd: false,
    });
    expect(first.before + first.anchor + first.after).toBe(first.text);

    const sentenceTail = rsvpFrameAt(page(), 1, 3);
    expect(sentenceTail.words.map((word) => word.token)).toEqual([11]);
    expect(sentenceTail.text).toBe('said,');

    const paragraph = rsvpFrameAt(page(), 3, 3);
    expect(paragraph.words.map((word) => word.token)).toEqual([13]);
    expect(paragraph.text).toBe('Then—');
    expect(paragraph.paragraphEnd).toBe(false);
    expect(rsvpFrameAt(page(), 4, 3).paragraphEnd).toBe(true);
  });

  it('partitions every token exactly once for each supported frame size', () => {
    for (const wordsPerFrame of [1, 2, 3]) {
      const tokens: number[] = [];
      let relative = 0;
      while (relative < 5) {
        const frame = rsvpFrameAt(page(), relative, wordsPerFrame);
        tokens.push(...frame.words.map((word) => word.token));
        expect(frame.words.slice(0, -1).every(
          (word) => !word.sentenceEnd && !word.paragraphEnd,
        )).toBe(true);
        relative += frame.words.length;
      }
      expect(tokens).toEqual([10, 11, 12, 13, 14]);
    }
  });

  it('uses an explicit clause-mark set without second-guessing sentence punctuation', () => {
    for (const mark of [',', '、', '，', ';', ':', '；', '：', '–', '—', '…', ')', ']', '}', '）']) {
      expect(rsvpHasClauseMark(`x${mark}”`)).toBe(true);
      expect(rsvpFrameAt(textPage(`one${mark} two`), 0, 2).words).toHaveLength(1);
    }
    for (const mark of ['.', '...', '!', '?', '"', '”', "'", '’', '】']) {
      expect(rsvpHasClauseMark(mark)).toBe(false);
      expect(rsvpFrameAt(textPage(`one${mark} two`), 0, 2).words).toHaveLength(2);
    }

    const abbreviation = textPage('Mr. Jones went home.');
    expect(rsvpFrameAt(abbreviation, 0, 2).text).toBe('Mr. Jones');
  });

  it('keeps clause punctuation with its word and never crosses the stop', () => {
    const source = textPage('he said, and left');
    expect(rsvpFrameAt(source, 0, 3).text).toBe('he said,');
    expect(rsvpFrameAt(source, 2, 3).text).toBe('and left');
  });

  it('bounds rendered graphemes while always admitting the first source token', () => {
    expect(RSVP_FRAME_GRAPHEME_BUDGET_PER_WORD).toBe(10);
    const pathological = textPage('supercalifragilisticexpialidocious tiny word');
    expect(rsvpFrameAt(pathological, 0, 3).words).toHaveLength(1);
    expect(rsvpFrameAt(pathological, 0, 3).text)
      .toBe('supercalifragilisticexpialidocious');

    const ordinary = textPage('notwithstanding the circumstances');
    expect(rsvpFrameAt(ordinary, 0, 3).text).toBe('notwithstanding the');

    const combining = 'e\u0301'.repeat(8);
    expect(rsvpFrameAt(textPage(`${combining} ${combining}`), 0, 2).words).toHaveLength(2);
    const astral = '𝔴'.repeat(8);
    expect(rsvpFrameAt(textPage(`${astral} ${astral}`), 0, 2).words).toHaveLength(2);
  });

  it('balances only avoidable three-plus-one tails after budget admission', () => {
    expect(frameSizes(textPage('one two three four'), 3)).toEqual([2, 2]);
    expect(frameSizes(textPage('one two three four five'), 3)).toEqual([3, 2]);
    expect(frameSizes(textPage('one two three four five six'), 3)).toEqual([3, 3]);
    expect(frameSizes(textPage('one two three four five six seven'), 3)).toEqual([3, 2, 2]);
    expect(frameSizes(textPage('one two three'), 2)).toEqual([2, 1]);

    const budgetWins = textPage('one two three pneumonoultramicroscopicsilicovolcanoconiosis');
    expect(frameSizes(budgetWins, 3)).toEqual([2, 1, 1]);
  });

  it('derives regression from the same resident forward partition', () => {
    const source = textPage('one two three four five six seven');
    expect(rsvpPreviousFrameStart(source, 0, 3)).toBe(0);
    expect(rsvpPreviousFrameStart(source, 3, 3)).toBe(0);
    expect(rsvpPreviousFrameStart(source, 4, 3)).toBe(3);
    expect(rsvpPreviousFrameStart(source, 5, 3)).toBe(3);

    const clauses = textPage('one two, three four');
    expect(rsvpPreviousFrameStart(clauses, 2, 3)).toBe(0);
    expect(() => rsvpPreviousFrameStart(source, 7, 3)).toThrow(RangeError);
  });

  it('is deterministic when called cold at every token in a phrase-shaped page', () => {
    const source = textPage(
      'one two three four, five six seven eight. nine ten',
      [0, 8, 10],
      [0, 10],
    );
    for (const wordsPerFrame of [1, 2, 3]) {
      for (let token = 0; token < 10; token++) {
        const first = rsvpFrameAt(source, token, wordsPerFrame);
        expect(rsvpFrameAt(source, token, wordsPerFrame)).toEqual(first);
        expect(first.words[0]?.token).toBe(token);
        const last = first.words.at(-1)!;
        expect(first.text).toBe(source.text
          .slice(first.words[0]!.displayStartUtf16, last.displayEndUtf16)
          .replace(/\s+/gu, ' '));
      }
    }
  });
});

describe('RSVP pacing', () => {
  it('clamps configured WPM to the supported integer range', () => {
    expect(clampRsvpWpm(99)).toBe(100);
    expect(clampRsvpWpm(450.6)).toBe(451);
    expect(clampRsvpWpm(901)).toBe(900);
    expect(clampRsvpWpm(Number.NaN)).toBe(300);
  });

  it('clamps rhythm fields and raises paragraph rest to the authored sentence rest', () => {
    expect(clampRsvpPacing({
      wpm: 950,
      wordsPerFrame: 7,
      sentencePauseMs: 750,
      paragraphPauseMs: 200,
      lengthEmphasis: -5,
    })).toEqual({
      wpm: 900,
      wordsPerFrame: 3,
      sentencePauseMs: 750,
      paragraphPauseMs: 750,
      lengthEmphasis: 0,
    });
    expect(effectiveRsvpWordsPerFrame(3, true)).toBe(2);
    expect(effectiveRsvpWordsPerFrame(3, false)).toBe(3);
  });

  it('recognizes rhythm presets without allowing them to alter set pace', () => {
    expect(rsvpPresetSelection({ ...RSVP_PACING_DEFAULTS, wpm: 725 })).toBe('natural');
    expect(rsvpPresetSelection({
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.study,
    })).toBe('study');
    expect(rsvpPresetSelection({ ...RSVP_PACING_DEFAULTS, wordsPerFrame: 2 })).toBe('custom');
  });

  it('holds longer words longer and respects the minimum frame time', () => {
    const pacing = RSVP_PACING_DEFAULTS;
    const short = rsvpWordMs(pacing, { graphemeCount: 2 });
    const ordinary = rsvpWordMs(pacing, { graphemeCount: 5 });
    const long = rsvpWordMs(pacing, { graphemeCount: 14 });
    expect(short).toBe(150);
    expect(ordinary).toBe(213);
    expect(long).toBe(350);
    expect(rsvpWordMs({ ...pacing, wpm: 900 }, { graphemeCount: 1 }))
      .toBeGreaterThanOrEqual(RSVP_MIN_HOLD_MS);
  });

  it('makes zero length emphasis exactly even while Study pins shipped timing', () => {
    const even = {
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.even,
      wpm: 300,
    };
    for (const graphemeCount of [1, 5, 40]) {
      expect(rsvpWordMs(even, { graphemeCount })).toBe(200);
    }

    const study = {
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.study,
      wpm: 300,
    };
    const frame = rsvpFrameAt(page(), 2, 1);
    const timing = rsvpFrameTiming(study, frame);
    expect(timing).toEqual({ wordMs: 150, pauseMs: 500 });
    expect(rsvpFrameHoldMs(study, frame)).toBe(650);
  });

  it('adds absolute, rate-invariant sentence and paragraph integration time', () => {
    const source = rsvpFrameAt(page(), 2, 1);
    for (const wpm of [300, 600]) {
      const pacing = { ...RSVP_PACING_DEFAULTS, wpm };
      const base = rsvpFrameHoldMs(pacing, {
        ...source, sentenceEnd: false, paragraphEnd: false,
      });
      const sentence = rsvpFrameHoldMs(pacing, {
        ...source, sentenceEnd: true, paragraphEnd: false,
      });
      const paragraph = rsvpFrameHoldMs(pacing, {
        ...source, sentenceEnd: true, paragraphEnd: true,
      });
      expect(sentence - base).toBe(RSVP_SENTENCE_PAUSE_MS);
      expect(paragraph - base).toBe(RSVP_PARAGRAPH_PAUSE_MS);
    }
  });

  it('keeps aggregate word time identical across frame sizes', () => {
    const pacing = {
      ...RSVP_PACING_DEFAULTS,
      sentencePauseMs: 0,
      paragraphPauseMs: 0,
    };
    const totalFor = (wordsPerFrame: number) => {
      let total = 0;
      let relative = 0;
      while (relative < 5) {
        const frame = rsvpFrameAt(page(), relative, wordsPerFrame);
        total += rsvpFrameHoldMs({ ...pacing, wordsPerFrame }, frame);
        relative += frame.words.length;
      }
      return total;
    };
    expect(totalFor(2)).toBe(totalFor(1));
    expect(totalFor(3)).toBe(totalFor(1));
  });
});
