import { describe, expect, it } from 'vitest';
import {
  clampMatchesColumnWidth,
  matchesBookColumnWidth,
  matchesColumnWidthFromDrag,
  matchesColumnWidthFromKey,
  matchesGridTemplate,
  matchesNodeColumnWidth,
  matchesTokenLabel,
  matchesTokenColumnWidth,
  MATCHES_COLUMN_DEFAULTS,
  isDefaultMatchesColumns,
  resolvedMatchesColumns,
} from '../src/lib/matches-columns.ts';

describe('Matches column geometry', () => {
  it('rounds and clamps manual widths to declared character ranges', () => {
    expect(clampMatchesColumnWidth('left', 39.6)).toBe(40);
    expect(clampMatchesColumnWidth('left', -20)).toBe(1);
    expect(clampMatchesColumnWidth('right', 500)).toBe(100);
    expect(clampMatchesColumnWidth('node', 500)).toBe(48);
    expect(clampMatchesColumnWidth('book', -20)).toBe(3);
  });

  it('converts pointer distance to whole character cells', () => {
    expect(matchesColumnWidthFromDrag('node', 18, 17, 8)).toBe(20);
    expect(matchesColumnWidthFromDrag('node', 18, -200, 8)).toBe(1);
    expect(matchesColumnWidthFromDrag('book', 20, 20, 0)).toBe(20);
  });

  it('supports fine, coarse, and endpoint separator keys', () => {
    expect(matchesColumnWidthFromKey('left', 40, 'ArrowLeft')).toBe(39);
    expect(matchesColumnWidthFromKey('left', 40, 'ArrowRight', true)).toBe(48);
    expect(matchesColumnWidthFromKey('node', 18, 'Home')).toBe(1);
    expect(matchesColumnWidthFromKey('node', 18, 'End')).toBe(48);
    expect(matchesColumnWidthFromKey('right', 40, 'PageDown')).toBeNull();
  });

  it('auto-fits node, token, and responsive book content', () => {
    expect(matchesNodeColumnWidth(['wolf', 'sea wolf'])).toBe(8);
    expect(matchesNodeColumnWidth(['  two\nwords  ', 'fox'])).toBe(9);
    expect(matchesTokenColumnWidth(['token', '1,234 / 56,789'], 'wide')).toBe(14);
    expect(matchesTokenColumnWidth(['token', '1,234 / 56,789'], 'compact')).toBe(5);
    expect(matchesTokenLabel('1,234 / 56,789', 'regular')).toBe('1,234');
    expect(matchesTokenLabel('1,234 / 56,789', 'wide')).toBe('1,234 / 56,789');
    expect(matchesBookColumnWidth(['(1) A title'], 'compact')).toBe(3);
    expect(matchesBookColumnWidth(['(1) A title'], 'regular')).toBe(3);
    expect(matchesBookColumnWidth(['(1) A title'], 'wide')).toBe(11);
  });

  it('resolves explicit auto intent without value-equality heuristics', () => {
    const content = {
      nodes: ['sea wolf'],
      books: ['(1) The Long Book'],
      tokens: ['12 / 1,234'],
    };
    expect(resolvedMatchesColumns(MATCHES_COLUMN_DEFAULTS, content, 'wide'))
      .toEqual({ left: 1, node: 8, right: 1, book: 17, token: 10 });
    expect(resolvedMatchesColumns({
      ...MATCHES_COLUMN_DEFAULTS,
      book: 3,
    }, content, 'wide').book).toBe(3);
  });

  it('emits one intrinsic-floor-free template for every visible column set', () => {
    const columns = { left: 1, node: 8, right: 2, book: 17, token: 10 };
    const template = matchesGridTemplate(columns, { book: true });
    expect(template.split(' minmax(')).toHaveLength(5);
    expect(template).toContain('minmax(0, 1fr)');
    expect(template).toContain('minmax(0, 2fr)');
    expect(template).toContain('calc(17ch + 1.5ch)');
    expect(template).not.toContain('max-content');
  });

  it('recognizes only the explicit reset state as default', () => {
    expect(isDefaultMatchesColumns(MATCHES_COLUMN_DEFAULTS)).toBe(true);
    expect(isDefaultMatchesColumns({ ...MATCHES_COLUMN_DEFAULTS, node: 8 }))
      .toBe(false);
  });
});
