import { describe, expect, it } from 'vitest';
import {
  matchesRows,
  oneLine,
} from '../src/lib/matches-view.ts';
import type { KwicRowView } from '../src/lib/store.ts';

const ROW: KwicRowView = {
  seriesId: 'series-a',
  groupId: 'group-a',
  members: [0],
  node: { start: 10, end: 11 },
  doc: 'book-a',
  pos: 10,
  left: '  all   the\ncontext before  ',
  leftMarks: [{
    trackOrdinals: [0, 1],
    charsUtf16: { start: 8, end: 19 },
    clippedStart: false,
    clippedEnd: false,
  }],
  leftMarksTruncated: false,
  nodeText: '\nHolmes ',
  right: '  context\tafter the node  ',
  rightMarks: [{
    trackOrdinals: [1],
    charsUtf16: { start: 10, end: 15 },
    clippedStart: false,
    clippedEnd: false,
  }],
  rightMarksTruncated: false,
};

describe('Matches presentation', () => {
  it('collapses display whitespace while retaining the complete delivered context', () => {
    expect(oneLine(' a\n\t b ')).toBe('a b');
    const [row] = matchesRows(
      [ROW],
      () => 'Holmes',
      () => ({ color: 'blue', line: 'dot' }),
      () => 'The Adventures',
    );
    expect(row).toMatchObject({
      label: 'Holmes',
      style: { color: 'blue', line: 'dot' },
      title: 'The Adventures',
      leftFull: 'all the context before',
      nodeText: 'Holmes',
      rightFull: 'context after the node',
    });
    expect(row!.leftParts).toEqual([
      { text: 'all ', marked: false, trackOrdinals: [] },
      { text: 'the context', marked: true, trackOrdinals: [0, 1] },
      { text: ' before', marked: false, trackOrdinals: [] },
    ]);
    expect(row!.rightParts).toEqual([
      { text: 'context ', marked: false, trackOrdinals: [] },
      { text: 'after', marked: true, trackOrdinals: [1] },
      { text: ' the node', marked: false, trackOrdinals: [] },
    ]);
    expect(row!.leftParts.map((part) => part.text).join('')).toBe(row!.leftFull);
    expect(row!.rightParts.map((part) => part.text).join('')).toBe(row!.rightFull);
  });
});
