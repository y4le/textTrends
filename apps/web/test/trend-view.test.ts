import { describe, expect, it } from 'vitest';
import {
  nextTrendView,
  trendRowDomain,
  trendViewAccessibleName,
  trendViewLabel,
} from '../src/lib/trend-view.ts';

describe('trend view presentation', () => {
  it('cycles combined, equal, and to-scale views in display order', () => {
    expect(nextTrendView('series')).toBe('by-book');
    expect(nextTrendView('by-book')).toBe('by-book-scaled');
    expect(nextTrendView('by-book-scaled')).toBe('series');
    expect(trendViewLabel('by-book-scaled')).toBe('to scale');
    expect(trendViewAccessibleName('by-book')).toBe('Separate rows, equal width');
    expect(trendViewAccessibleName('by-book-scaled')).toBe('To scale — separate rows, same token scale');
  });

  it('preserves each row domain when equal and shares the maximum when to scale', () => {
    const tokenCounts = [120, 40, 0];
    expect(trendRowDomain('by-book', tokenCounts)).toBe(tokenCounts);
    expect(trendRowDomain('series', tokenCounts)).toBe(tokenCounts);
    expect(trendRowDomain('by-book-scaled', tokenCounts)).toEqual([120, 120, 120]);
    expect(trendRowDomain('by-book-scaled', [0, 0])).toEqual([0, 0]);
  });
});
