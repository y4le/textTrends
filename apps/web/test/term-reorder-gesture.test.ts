import { describe, expect, it } from 'vitest';
import {
  TERM_REORDER_EDGE_PX,
  TERM_REORDER_MAX_SCROLL_PX,
  termReorderScrollStep,
} from '../src/lib/term-reorder-gesture.ts';

describe('term reorder edge autoscroll', () => {
  it('is idle away from either edge', () => {
    expect(termReorderScrollStep(200, 0, 400)).toBe(0);
    expect(termReorderScrollStep(TERM_REORDER_EDGE_PX, 0, 400)).toBe(0);
  });

  it('scrolls toward the nearest edge with bounded pressure', () => {
    expect(termReorderScrollStep(20, 0, 400)).toBeLessThan(0);
    expect(termReorderScrollStep(380, 0, 400)).toBeGreaterThan(0);
    expect(termReorderScrollStep(-100, 0, 400)).toBe(-TERM_REORDER_MAX_SCROLL_PX);
    expect(termReorderScrollStep(500, 0, 400)).toBe(TERM_REORDER_MAX_SCROLL_PX);
  });

  it('rejects invalid geometry', () => {
    expect(termReorderScrollStep(20, 40, 40)).toBe(0);
    expect(termReorderScrollStep(Number.NaN, 0, 400)).toBe(0);
  });
});
