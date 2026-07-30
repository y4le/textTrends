import { describe, expect, it } from 'vitest';
import {
  displayPassageText,
  segmentPassageMarks,
} from '../src/lib/passage-marks.ts';

describe('passage mark presentation', () => {
  it('partitions overlapping marks and caller boundaries deterministically', () => {
    expect(segmentPassageMarks(
      10,
      [
        { seriesId: 'a', start: 1, end: 6 },
        { seriesId: 'b', start: 4, end: 9 },
      ],
      [3, 7],
    )).toEqual([
      { start: 0, end: 1, seriesIds: [] },
      { start: 1, end: 3, seriesIds: ['a'] },
      { start: 3, end: 4, seriesIds: ['a'] },
      { start: 4, end: 6, seriesIds: ['a', 'b'] },
      { start: 6, end: 7, seriesIds: ['b'] },
      { start: 7, end: 9, seriesIds: ['b'] },
      { start: 9, end: 10, seriesIds: [] },
    ]);
  });

  it('clamps malformed mark bounds without emitting empty segments', () => {
    expect(segmentPassageMarks(3, [
      { seriesId: 'a', start: -4, end: 8 },
    ])).toEqual([{ start: 0, end: 3, seriesIds: ['a'] }]);
  });

  it('replaces display whitespace one code unit at a time', () => {
    const source = 'a\nb\r\tc\u0085d\u2028e\u2029f';
    const shown = displayPassageText(source);
    expect(shown).toBe('a b  c d e f');
    expect(shown).toHaveLength(source.length);
  });
});
