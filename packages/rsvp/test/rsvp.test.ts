import { describe, expect, it } from 'vitest';
import {
  RSVP_CONTEXT_TOKENS_PER_SIDE,
  RSVP_FRAME_GRAPHEME_BUDGET_PER_WORD,
  RSVP_MAX_REST_SHARE,
  RSVP_MAX_WPM,
  RSVP_MIN_EXPOSURE_MS,
  RSVP_PACING_DEFAULTS,
  RSVP_RHYTHM_PRESETS,
  RSVP_RHYTHM_RESET,
  clampRsvpPacing,
  clampRsvpWpm,
  effectiveRsvpWordsPerFrame,
  rsvpAnchorIndex,
  rsvpFrameAt,
  rsvpFrameHoldMs,
  rsvpFrameTiming,
  rsvpGraphemes,
  rsvpHasClauseMark,
  rsvpPausedContext,
  rsvpPreviousFrameStart,
  rsvpPresetSelection,
  rsvpSpanAt,
  rsvpSpanPlan,
  rsvpWordFrame,
  type RsvpSource,
} from '../src/index.ts';

function page(text = 'he said, “Yes.” Then—left'): RsvpSource {
  return {
    tokens: { start: 10, end: 15 },
    text,
    tokenStartsUtf16: [0, 3, 10, 16, 21],
    tokenEndsUtf16: [2, 7, 13, 20, 25],
    sentenceBounds: [0, 3, 5],
    paragraphBounds: [0, 5],
  };
}

function textPage(
  text: string,
  sentenceBounds?: readonly number[],
  paragraphBounds?: readonly number[],
): RsvpSource {
  const matches = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu));
  const tokenCount = matches.length;
  return {
    tokens: { start: 0, end: tokenCount },
    text,
    tokenStartsUtf16: matches.map((match) => match.index),
    tokenEndsUtf16: matches.map((match) => match.index + match[0].length),
    sentenceBounds: sentenceBounds ?? [0, tokenCount],
    paragraphBounds: paragraphBounds ?? [0, tokenCount],
  };
}

function frameSizes(source: RsvpSource, wordsPerFrame: number): number[] {
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

  it('keeps a collapsed source space at the split-span join', () => {
    for (const source of [textPage('I\n am ready'), textPage('to\tgo now')]) {
      const frame = rsvpFrameAt(source, 0, 3);
      expect(frame.after.startsWith(' ')).toBe(true);
      expect(frame.text).toBe(source.text.replace(/\s+/gu, ' '));
      expect(frame.text).not.toMatch(/[\n\r\t]/u);
      expect(frame.before + frame.anchor + frame.after).toBe(frame.text);
    }
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

  it('cuts paused context from the exact enclosing resident sentence', () => {
    expect(RSVP_CONTEXT_TOKENS_PER_SIDE).toBe(40);
    const source = textPage(
      'Lead. “One   two, three four five.” Tail.',
      [0, 1, 6, 7],
    );
    const context = rsvpPausedContext(source, rsvpFrameAt(source, 2, 3));
    expect(context).toEqual({
      text: '“One   two, three four five.”',
      before: '“One   ',
      current: 'two,',
      after: ' three four five.”',
      leadingEllipsis: false,
      trailingEllipsis: false,
    });
    expect(context.before + context.current + context.after).toBe(context.text);
  });

  it('caps paused context at forty tokens per side and marks resident truncation', () => {
    const source = textPage(Array.from({ length: 90 }, (_, index) => `w${index}`).join(' '));
    const context = rsvpPausedContext(source, rsvpFrameAt(source, 45, 1));
    expect(context.before.match(/\bw\d+\b/gu)).toHaveLength(40);
    expect(context.current).toBe('w45');
    expect(context.after.match(/\bw\d+\b/gu)).toHaveLength(40);
    expect(context.leadingEllipsis).toBe(true);
    expect(context.trailingEllipsis).toBe(true);

    const window = {
      ...textPage('middle sentence words', [], []),
      tokens: { start: 50, end: 53 },
      docTokenCount: 100,
      atStart: false,
      atEnd: false,
      previous: { kind: 'before' as const, token: 50 },
      next: { kind: 'from' as const, token: 53 },
      cappedBy: 'tokens' as const,
    };
    expect(rsvpPausedContext(window, rsvpFrameAt(window, 1, 1))).toMatchObject({
      text: 'middle sentence words',
      current: 'sentence',
      leadingEllipsis: true,
      trailingEllipsis: true,
    });
    const frame = rsvpFrameAt(window, 0, 3);
    const nonconsecutive = {
      ...frame,
      words: [frame.words[0]!, frame.words[2]!, frame.words[2]!],
    };
    expect(() => rsvpPausedContext(window, nonconsecutive)).toThrow(RangeError);
    expect(() => rsvpPausedContext(window, rsvpFrameAt(window, 1, 1), -1))
      .toThrow(RangeError);
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
    expect(clampRsvpWpm(901)).toBe(901);
    expect(clampRsvpWpm(1_201)).toBe(1_200);
    expect(clampRsvpWpm(Number.NaN)).toBe(300);
    expect(RSVP_MAX_WPM * RSVP_MIN_EXPOSURE_MS).toBe(60_000);
  });

  it('clamps rhythm fields and raises paragraph rest to the authored sentence rest', () => {
    expect(clampRsvpPacing({
      wpm: 1_250,
      wordsPerFrame: 7,
      sentencePauseMs: 750,
      paragraphPauseMs: 200,
      lengthEmphasis: -5,
    })).toEqual({
      wpm: 1_200,
      wordsPerFrame: 3,
      sentencePauseMs: 750,
      paragraphPauseMs: 750,
      lengthEmphasis: 0,
    });
    expect(effectiveRsvpWordsPerFrame(3, true)).toBe(2);
    expect(effectiveRsvpWordsPerFrame(3, false)).toBe(3);
  });

  it('recognizes rhythm presets independently of pace and words at once', () => {
    expect(rsvpPresetSelection({ ...RSVP_PACING_DEFAULTS, wpm: 725 })).toBe('natural');
    expect(rsvpPresetSelection({
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.study,
    })).toBe('study');
    expect(rsvpPresetSelection({ ...RSVP_PACING_DEFAULTS, wordsPerFrame: 2 })).toBe('natural');
    expect(rsvpPresetSelection({ ...RSVP_PACING_DEFAULTS, wordsPerFrame: 3 })).toBe('natural');
    expect(RSVP_RHYTHM_PRESETS.natural).not.toHaveProperty('wordsPerFrame');
    expect(RSVP_RHYTHM_RESET).toEqual({
      wpm: 300,
      sentencePauseMs: 350,
      paragraphPauseMs: 700,
      lengthEmphasis: 100,
    });
    expect(RSVP_RHYTHM_RESET).not.toHaveProperty('wordsPerFrame');
  });

  it('finds stable resident spans and treats a truncated window as no boundary', () => {
    expect(rsvpSpanAt(page(), 0)).toEqual({
      startToken: 10, endToken: 13, boundary: 'sentence',
    });
    expect(rsvpSpanAt(page(), 2)).toEqual(rsvpSpanAt(page(), 0));
    expect(rsvpSpanAt(page(), 3)).toEqual({
      startToken: 13, endToken: 15, boundary: 'paragraph',
    });

    const truncated = textPage('one two three', [0], [0]);
    const plan = rsvpSpanPlan(truncated, 1, RSVP_PACING_DEFAULTS);
    expect(plan).toMatchObject({
      startToken: 0,
      endToken: 3,
      boundary: 'window',
      configuredRestMs: 0,
      restMs: 0,
      targetMs: 600,
    });
    expect(plan.wordMs.reduce((total, value) => total + value, 0)).toBe(600);
  });

  it('plans every reachable pace exactly with a deterministic exposure floor', () => {
    for (const wpm of [100, 300, 600, 900, 901, 1_200]) {
      for (const lengthEmphasis of [0, 100]) {
        for (const relative of [0, 3]) {
          const pacing = { ...RSVP_PACING_DEFAULTS, wpm, lengthEmphasis };
          const plan = rsvpSpanPlan(page(), relative, pacing);
          const wordCount = plan.endToken - plan.startToken;
          const wordTotal = plan.wordMs.reduce((total, value) => total + value, 0);
          expect(wordTotal + plan.restMs).toBe(plan.targetMs);
          expect(plan.targetMs).toBe(Math.round(wordCount * 60_000 / wpm));
          expect(plan.wordMs.every((value) => value >= RSVP_MIN_EXPOSURE_MS)).toBe(true);
          expect(plan.restMs).toBeLessThanOrEqual(plan.configuredRestMs);
          expect(plan.restMs).toBeLessThanOrEqual(
            Math.floor(plan.targetMs * RSVP_MAX_REST_SHARE),
          );
          expect(plan.restMs).toBeLessThanOrEqual(
            plan.targetMs - wordCount * RSVP_MIN_EXPOSURE_MS,
          );
          expect(rsvpSpanPlan(page(), relative + 1, pacing)).toEqual(plan);
          if (wpm === RSVP_MAX_WPM) {
            expect(plan.wordMs.every((value) => value === RSVP_MIN_EXPOSURE_MS)).toBe(true);
            expect(plan.restMs).toBe(0);
          }
        }
      }
    }
  });

  it('preserves exact allocation across every selectable pace and emphasis', () => {
    const source = textPage(Array.from(
      { length: 32 },
      (_, index) => 'x'.repeat(1 + (index * 7) % 20),
    ).join(' '));
    for (let wpm = 100; wpm <= RSVP_MAX_WPM; wpm += 25) {
      for (let lengthEmphasis = 0; lengthEmphasis <= 100; lengthEmphasis += 25) {
        for (const paragraphPauseMs of [0, 700, 1_500]) {
          const plan = rsvpSpanPlan(source, 17, {
            ...RSVP_PACING_DEFAULTS,
            wpm,
            lengthEmphasis,
            sentencePauseMs: 0,
            paragraphPauseMs,
          });
          expect(plan.wordMs.reduce((total, value) => total + value, plan.restMs))
            .toBe(plan.targetMs);
          expect(Math.min(...plan.wordMs)).toBeGreaterThanOrEqual(RSVP_MIN_EXPOSURE_MS);
          expect(rsvpSpanPlan(source, 0, {
            ...RSVP_PACING_DEFAULTS,
            wpm,
            lengthEmphasis,
            sentencePauseMs: 0,
            paragraphPauseMs,
          })).toEqual(plan);
        }
      }
    }

    const tied = rsvpSpanPlan(textPage('one two six ten'), 0, {
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.even,
      wpm: 397,
    });
    expect(tied.wordMs).toEqual([152, 151, 151, 151]);
  });

  it('keeps configured rests when affordable and caps them by share or floor', () => {
    const tenWordSentence = textPage(
      'one two three four five six seven eight nine ten next',
      [0, 10, 11],
      [0, 11],
    );
    expect(rsvpSpanPlan(tenWordSentence, 0, RSVP_PACING_DEFAULTS).restMs).toBe(350);
    expect(rsvpSpanPlan(tenWordSentence, 0, {
      ...RSVP_PACING_DEFAULTS,
      wpm: 600,
    }).restMs).toBe(250);

    const oneWordSentence = textPage('One next', [0, 1, 2], [0, 2]);
    expect(rsvpSpanPlan(oneWordSentence, 0, RSVP_PACING_DEFAULTS).restMs).toBe(50);
    expect(rsvpSpanPlan(page(), 3, RSVP_PACING_DEFAULTS).restMs).toBe(100);
  });

  it('apportions even timing within one millisecond and preserves length emphasis', () => {
    const source = textPage('I ordinary extraordinarily word');
    const even = rsvpSpanPlan(source, 0, {
      ...RSVP_PACING_DEFAULTS,
      ...RSVP_RHYTHM_PRESETS.even,
    });
    expect(Math.max(...even.wordMs) - Math.min(...even.wordMs)).toBeLessThanOrEqual(1);

    const natural = rsvpSpanPlan(source, 0, {
      ...RSVP_PACING_DEFAULTS,
      sentencePauseMs: 0,
      paragraphPauseMs: 0,
    });
    expect(natural.wordMs[2]).toBeGreaterThan(natural.wordMs[0]!);
  });

  it('keeps aggregate span time identical across frame sizes, including rests', () => {
    const pacing = RSVP_PACING_DEFAULTS;
    const totalFor = (wordsPerFrame: number) => {
      let total = 0;
      let relative = 0;
      while (relative < 5) {
        const frame = rsvpFrameAt(page(), relative, wordsPerFrame);
        const plan = rsvpSpanPlan(page(), relative, { ...pacing, wordsPerFrame });
        total += rsvpFrameHoldMs(plan, frame);
        relative += frame.words.length;
      }
      return total;
    };
    expect(totalFor(1)).toBe(1_000);
    expect(totalFor(2)).toBe(totalFor(1));
    expect(totalFor(3)).toBe(totalFor(1));
  });

  it('rejects a frame outside its timing span', () => {
    const firstPlan = rsvpSpanPlan(page(), 0, RSVP_PACING_DEFAULTS);
    expect(() => rsvpFrameTiming(firstPlan, rsvpFrameAt(page(), 3, 1)))
      .toThrow(RangeError);
  });
});
