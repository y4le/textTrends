import { describe, expect, it } from 'vitest';
import { boundedPageView } from '../src/lib/bounded-page-view.ts';

describe('bounded analysis page view', () => {
  it('labels empty and populated pages and stops at the 5,000-row window', () => {
    expect(boundedPageView(0, 0, 100, 0)).toEqual({
      label: '0 rows',
      canNext: false,
      atWindow: false,
    });
    expect(boundedPageView(10_000, 4_800, 200, 200)).toEqual({
      label: 'rows 4,801–5,000',
      canNext: false,
      atWindow: true,
    });
    expect(boundedPageView(450, 200, 200, 200)).toEqual({
      label: 'rows 201–400',
      canNext: true,
      atWindow: false,
    });
  });
});
