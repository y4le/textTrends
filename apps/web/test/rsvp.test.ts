import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import {
  RSVP_MIN_HOLD_MS,
  RSVP_PARAGRAPH_PAUSE_MS,
  RSVP_SENTENCE_PAUSE_MS,
  clampRsvpWpm,
  rsvpAnchorIndex,
  rsvpGraphemes,
  rsvpHoldMs,
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
});

describe('RSVP pacing', () => {
  it('clamps configured WPM to the supported integer range', () => {
    expect(clampRsvpWpm(99)).toBe(100);
    expect(clampRsvpWpm(450.6)).toBe(451);
    expect(clampRsvpWpm(901)).toBe(900);
    expect(clampRsvpWpm(Number.NaN)).toBe(300);
  });

  it('holds longer words longer and respects the minimum frame time', () => {
    const short = rsvpHoldMs(300, { graphemeCount: 2, sentenceEnd: false, paragraphEnd: false });
    const ordinary = rsvpHoldMs(300, { graphemeCount: 5, sentenceEnd: false, paragraphEnd: false });
    const long = rsvpHoldMs(300, { graphemeCount: 14, sentenceEnd: false, paragraphEnd: false });
    expect(short).toBe(150);
    expect(ordinary).toBe(213);
    expect(long).toBe(350);
    expect(rsvpHoldMs(900, {
      graphemeCount: 1, sentenceEnd: false, paragraphEnd: false,
    })).toBeGreaterThanOrEqual(RSVP_MIN_HOLD_MS);
  });

  it('adds absolute, rate-invariant sentence and paragraph integration time', () => {
    for (const wpm of [300, 600]) {
      const base = rsvpHoldMs(wpm, {
        graphemeCount: 5, sentenceEnd: false, paragraphEnd: false,
      });
      const sentence = rsvpHoldMs(wpm, {
        graphemeCount: 5, sentenceEnd: true, paragraphEnd: false,
      });
      const paragraph = rsvpHoldMs(wpm, {
        graphemeCount: 5, sentenceEnd: true, paragraphEnd: true,
      });
      expect(sentence - base).toBe(RSVP_SENTENCE_PAUSE_MS);
      expect(paragraph - base).toBe(RSVP_PARAGRAPH_PAUSE_MS);
    }
  });
});
