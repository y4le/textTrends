import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import {
  corpusProgress,
  footerBlockSize,
  footerGeometryFor,
  footerPassageServes,
  footerStatusText,
  sequenceLayoutFor,
} from '../src/lib/footer-view.ts';

function page(start = 10, end = 20): ReaderPageResultV1 {
  return {
    method: 'reader-page/1',
    doc: 'a',
    tokens: { start, end },
    docCharsUtf16: { start, end },
    text: 'x'.repeat(end - start),
    tokenStartsUtf16: Array.from({ length: end - start }, (_, i) => i),
    tokenEndsUtf16: Array.from({ length: end - start }, (_, i) => i + 1),
    anchor: null,
    previous: null,
    next: null,
    atStart: start === 0,
    atEnd: false,
    docTokenCount: 100,
    cappedBy: 'tokens',
    marks: [],
    marksTruncated: false,
  };
}

describe('reading footer view', () => {
  it('uses compact geometry without shrinking the strip below 24px', () => {
    const compact = footerGeometryFor('compact');
    const regular = footerGeometryFor('regular');
    const compactCoarse = footerGeometryFor('compact', true);
    expect(compact.seriesHeight + compact.barcodeBandGap + compact.barcodeTrackHeight)
      .toBeGreaterThanOrEqual(24);
    expect(footerBlockSize(compact, 1)).toBe(78);
    expect(footerBlockSize(compact, 5)).toBe(102);
    expect(footerBlockSize(regular, 5)).toBeGreaterThan(footerBlockSize(compact, 5));
    expect(compactCoarse.passageHeight).toBeGreaterThanOrEqual(44);
    expect(compactCoarse.stripMinHeight).toBeGreaterThanOrEqual(44);
    expect(footerBlockSize(compactCoarse, 1)).toBeGreaterThan(footerBlockSize(compact, 1));
  });

  it('builds declared-sequence progress from token extents', () => {
    const counts = new Map([['a', 3], ['empty', 0], ['b', 7]]);
    const layout = sequenceLayoutFor(['a', 'empty', 'b'], (doc) => counts.get(doc));
    expect(layout).toEqual({ bases: [0, 3, 3], tokenCounts: [3, 0, 7], totalTokens: 10 });
    expect(corpusProgress(layout, 0, 0)).toMatchObject({ globalToken: 0, percent: 10 });
    expect(corpusProgress(layout, 2, 6)).toMatchObject({ globalToken: 9, percent: 100 });
    expect(corpusProgress(layout, 1, 0)).toBeNull();
  });

  it('formats compact, partial, and failure status honestly', () => {
    expect(footerStatusText(null)).toBe('no reading position');
    expect(footerStatusText({
      compact: false,
      partial: true,
      docOrdinal: 1,
      docCount: 3,
      title: 'Second book',
      token: 9,
      docTokenCount: 100,
      percent: 40,
      pending: false,
      failed: 1,
    })).toBe('partial corpus · 2/3 · Second book · token 10 of 100 · 40% of corpus · 1 query failed');
  });

  it('serves only a current canonical page and matching track identities', () => {
    const state = {
      snapshot: 's1',
      doc: 'a',
      tracks: [{ seriesId: 'q', groupId: 'g', identity: 'i1', label: 'q', styleSlot: 0 }],
      state: { status: 'ready' as const, page: page() },
    };
    const identity = (id: string) => id === 'q' ? 'i1' : null;
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's1', identity)).toBe(true);
    expect(footerPassageServes(state, { doc: 'a', token: 20 }, 's1', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'b', token: 10 }, 's1', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's2', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's1', () => 'changed')).toBe(false);
  });
});
