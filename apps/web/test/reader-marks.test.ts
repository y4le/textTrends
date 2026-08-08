import { describe, expect, it } from 'vitest';
import { segmentReaderMarks } from '../src/lib/reader-marks.ts';

describe('Reader mark presentation', () => {
  it('partitions overlapping marks and caller boundaries deterministically', () => {
    expect(segmentReaderMarks(
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
    expect(segmentReaderMarks(3, [
      { seriesId: 'a', start: -4, end: 8 },
    ])).toEqual([{ start: 0, end: 3, seriesIds: ['a'] }]);
  });
});
