import { describe, expect, it } from 'vitest';
import { notebookCountLabel } from '../src/lib/notebook-view.ts';

describe('Terms rail count labels', () => {
  it('formats ready totals consistently and names inactive terms as hidden', () => {
    const integer = new Intl.NumberFormat();
    expect(notebookCountLabel({ kind: 'ready', total: 2_902, partial: false }))
      .toBe(integer.format(2_902));
    expect(notebookCountLabel({
      kind: 'selected',
      total: 12_345,
      partial: false,
      selected: { kind: 'ready', total: 2_902 },
    })).toBe(`${integer.format(2_902)} selected / ${integer.format(12_345)}`);
    expect(notebookCountLabel({ kind: 'not-run' }, false)).toBe('hidden');
    expect(notebookCountLabel({ kind: 'not-run' }, true)).toBe('not run');
  });
});
