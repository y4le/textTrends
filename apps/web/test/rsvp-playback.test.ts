import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import { rsvpCursorStep, rsvpNeedsContinuation } from '../src/lib/rsvp-playback.ts';
import {
  RSVP_PACING_DEFAULTS,
  rsvpFrameAt,
  rsvpFrameHoldMs,
  rsvpSpanPlan,
} from '../src/lib/rsvp.ts';

function page(end = 5, docTokenCount = 8): ReaderPageResultV1 {
  const count = end;
  const words = Array.from({ length: count }, (_, index) => `word${index}`);
  const text = words.join(' ');
  let cursor = 0;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const word of words) {
    starts.push(cursor);
    cursor += word.length;
    ends.push(cursor);
    cursor += 1;
  }
  return {
    method: 'reader-page/1',
    doc: 'a',
    tokens: { start: 0, end },
    docCharsUtf16: { start: 0, end: text.length },
    text,
    tokenStartsUtf16: starts,
    tokenEndsUtf16: ends,
    sentenceBounds: [0],
    paragraphBounds: [0],
    anchor: null,
    previous: null,
    next: end < docTokenCount ? { kind: 'from', token: end } : null,
    atStart: true,
    atEnd: end === docTokenCount,
    docTokenCount,
    cappedBy: end < docTokenCount ? 'tokens' : null,
    marks: [],
    marksTruncated: false,
  };
}

describe('RSVP playback boundaries', () => {
  it('distinguishes an ordinary step, source exhaustion, and document completion', () => {
    expect(rsvpCursorStep(page(), 2)).toEqual({ kind: 'next', token: 3 });
    expect(rsvpCursorStep(page(), 1, 3)).toEqual({ kind: 'next', token: 4 });
    expect(rsvpCursorStep(page(), 4)).toEqual({ kind: 'source-end' });
    expect(rsvpCursorStep(page(5, 5), 2, 3)).toEqual({ kind: 'document-end' });
    expect(rsvpCursorStep(page(5, 5), 4)).toEqual({ kind: 'document-end' });
    expect(() => rsvpCursorStep(page(), 5)).toThrow(RangeError);
    expect(() => rsvpCursorStep(page(), 2, 0)).toThrow(RangeError);
  });

  it('requests continuation only when the authenticated runway is within the lead', () => {
    const source = page();
    expect(rsvpNeedsContinuation(source, 0, RSVP_PACING_DEFAULTS, 500)).toBe(false);
    expect(rsvpNeedsContinuation(source, 3, RSVP_PACING_DEFAULTS, 500)).toBe(true);
    expect(rsvpNeedsContinuation(page(5, 5), 4, RSVP_PACING_DEFAULTS, 3_000)).toBe(false);
    expect(() => rsvpNeedsContinuation(source, 5, RSVP_PACING_DEFAULTS)).toThrow(RangeError);
  });

  it('matches frame-by-frame planned runway at every resident cursor', () => {
    const source = page();
    for (const wordsPerFrame of [1, 2, 3]) {
      const pacing = { ...RSVP_PACING_DEFAULTS, wordsPerFrame };
      for (let token = source.tokens.start; token < source.tokens.end; token++) {
        let total = 0;
        for (let relative = token - source.tokens.start; relative < source.tokens.end;) {
          const frame = rsvpFrameAt(source, relative, wordsPerFrame);
          total += rsvpFrameHoldMs(rsvpSpanPlan(source, relative, pacing), frame);
          relative += frame.words.length;
        }
        expect(rsvpNeedsContinuation(source, token, pacing, total - 1)).toBe(false);
        expect(rsvpNeedsContinuation(source, token, pacing, total)).toBe(true);
      }
    }
  });
});
