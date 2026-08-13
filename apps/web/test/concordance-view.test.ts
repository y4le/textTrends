import { describe, expect, it } from 'vitest';
import {
  concordanceRows,
  nodeCenterOffset,
  oneLine,
} from '../src/lib/concordance-view.ts';
import type { KwicRowView } from '../src/lib/store.ts';

const ROW: KwicRowView = {
  seriesId: 'series-a',
  groupId: 'group-a',
  members: [0],
  node: { start: 10, end: 11 },
  doc: 'book-a',
  pos: 10,
  left: '  all   the\ncontext before  ',
  nodeText: '\nHolmes ',
  right: '  context\tafter the node  ',
};

describe('Concordance presentation', () => {
  it('collapses display whitespace while retaining the complete delivered context', () => {
    expect(oneLine(' a\n\t b ')).toBe('a b');
    const [row] = concordanceRows(
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
  });

  it('centers the shared node column without producing negative scroll', () => {
    expect(nodeCenterOffset(320, 500, 80)).toBe(380);
    expect(nodeCenterOffset(800, 120, 80)).toBe(0);
    expect(nodeCenterOffset(Number.NaN, 120, 80)).toBe(0);
  });
});
