import { describe, expect, it } from 'vitest';
import {
  clampConcordanceColumnWidth,
  concordanceColumnWidthFromDrag,
  concordanceColumnWidthFromKey,
  CONCORDANCE_COLUMN_DEFAULTS,
  nodeVisibleScrollLeft,
} from '../src/lib/concordance-columns.ts';

describe('Concordance column geometry', () => {
  it('rounds and clamps each column to its declared character range', () => {
    expect(clampConcordanceColumnWidth('left', 39.6)).toBe(40);
    expect(clampConcordanceColumnWidth('left', -20)).toBe(1);
    expect(clampConcordanceColumnWidth('right', 500)).toBe(100);
    expect(clampConcordanceColumnWidth('node', 500)).toBe(48);
    expect(clampConcordanceColumnWidth('book', -20)).toBe(3);
    expect(clampConcordanceColumnWidth('book', 500)).toBe(48);
    expect(clampConcordanceColumnWidth('node', Number.NaN))
      .toBe(CONCORDANCE_COLUMN_DEFAULTS.node);
  });

  it('converts pointer distance to whole character cells', () => {
    expect(concordanceColumnWidthFromDrag('left', 40, 17, 8)).toBe(42);
    expect(concordanceColumnWidthFromDrag('node', 18, -200, 8)).toBe(1);
    expect(concordanceColumnWidthFromDrag('right', 40, 20, 0)).toBe(40);
  });

  it('supports fine, coarse, endpoint, and reset separator keys', () => {
    expect(concordanceColumnWidthFromKey('left', 40, 'ArrowLeft')).toBe(39);
    expect(concordanceColumnWidthFromKey('left', 40, 'ArrowRight', true)).toBe(48);
    expect(concordanceColumnWidthFromKey('node', 18, 'Home')).toBe(1);
    expect(concordanceColumnWidthFromKey('node', 18, 'End')).toBe(48);
    expect(concordanceColumnWidthFromKey('node', 5, 'Enter')).toBe(18);
    expect(concordanceColumnWidthFromKey('book', 20, 'Enter')).toBe(4);
    expect(concordanceColumnWidthFromKey('right', 40, 'PageDown')).toBeNull();
  });

  it('makes only the correction needed to keep the node visible', () => {
    expect(nodeVisibleScrollLeft(320, 100, 600, 120, 80)).toBe(100);
    expect(nodeVisibleScrollLeft(320, 100, 600, 80, 80)).toBe(80);
    expect(nodeVisibleScrollLeft(320, 100, 600, 390, 80)).toBe(150);
    expect(nodeVisibleScrollLeft(320, 100, 120, 390, 80)).toBe(120);
    expect(nodeVisibleScrollLeft(320, 100, 600, 80, 400)).toBe(80);
  });
});
