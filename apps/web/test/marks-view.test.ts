import { describe, expect, it } from 'vitest';
import { displaySourceText, segmentMarks } from '../src/lib/marks-view.ts';

describe('mark presentation', () => {
  it('partitions overlapping marks and caller boundaries deterministically', () => {
    expect(segmentMarks(
      10,
      [
        { value: 'a', start: 1, end: 6 },
        { value: 'b', start: 4, end: 9 },
      ],
      [3, 7],
    )).toEqual([
      { start: 0, end: 1, values: [] },
      { start: 1, end: 3, values: ['a'] },
      { start: 3, end: 4, values: ['a'] },
      { start: 4, end: 6, values: ['a', 'b'] },
      { start: 6, end: 7, values: ['b'] },
      { start: 7, end: 9, values: ['b'] },
      { start: 9, end: 10, values: [] },
    ]);
  });

  it('clamps malformed mark bounds without emitting empty segments', () => {
    expect(segmentMarks(3, [
      { value: 'a', start: -4, end: 8 },
    ])).toEqual([{ start: 0, end: 3, values: ['a'] }]);
  });

  it('normalizes display whitespace without changing UTF-16 offsets', () => {
    const source = 'A\r\nB\tC\u0085D\u2028E\u2029F 😀';
    const display = displaySourceText(source);
    expect(display).toBe('A  B C D E F 😀');
    expect(display.length).toBe(source.length);
  });
});
