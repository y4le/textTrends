import { describe, expect, it } from 'vitest';
import type { ReaderPageResultV1 } from '../src/shared/analysis-contract.ts';
import {
  advanceFooterShuttle,
  corpusProgress,
  FOOTER_SHUTTLE_MAX_FRAME_MS,
  FOOTER_SHUTTLE_MAX_OFFSET_PX,
  footerShuttleRate,
  footerBlockSize,
  footerGeometryFor,
  footerPassageDisplay,
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

  it('maps drag offset to a bounded signed reading rate', () => {
    expect(footerShuttleRate(0, 20)).toBe(0);
    expect(footerShuttleRate(FOOTER_SHUTTLE_MAX_OFFSET_PX, 20)).toBe(50);
    expect(footerShuttleRate(-FOOTER_SHUTTLE_MAX_OFFSET_PX * 2, 20)).toBe(-50);
    expect(footerShuttleRate(4, 20)).toBeCloseTo(50 / 144);
    expect(footerShuttleRate(Number.NaN, 20)).toBe(0);
  });

  it('advances continuously across books and clamps corpus edges and long frames', () => {
    const layout = sequenceLayoutFor(['a', 'empty', 'b'], (doc) => (
      doc === 'a' ? 3 : doc === 'b' ? 4 : 0
    ));
    expect(advanceFooterShuttle(layout, 2.5, 10, 100)).toEqual({
      position: 3.5,
      docOrdinal: 2,
      token: 0,
    });
    expect(advanceFooterShuttle(layout, 3.5, -10, 100)).toEqual({
      position: 2.5,
      docOrdinal: 0,
      token: 2,
    });
    expect(advanceFooterShuttle(layout, 0.5, -100, 100)).toEqual({
      position: 0.5,
      docOrdinal: 0,
      token: 0,
    });
    expect(advanceFooterShuttle(layout, 6.5, 100, 100)).toEqual({
      position: 6.5,
      docOrdinal: 2,
      token: 3,
    });
    expect(advanceFooterShuttle(layout, 0.5, 10, FOOTER_SHUTTLE_MAX_FRAME_MS * 10))
      .toEqual({ position: 1.5, docOrdinal: 0, token: 1 });
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
      page: page(),
      state: { status: 'ready' as const },
    };
    const identity = (id: string) => id === 'q' ? 'i1' : null;
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's1', identity)).toBe(true);
    expect(footerPassageServes(state, { doc: 'a', token: 20 }, 's1', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'b', token: 10 }, 's1', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's2', identity)).toBe(false);
    expect(footerPassageServes(state, { doc: 'a', token: 10 }, 's1', () => 'changed')).toBe(false);
  });

  it('holds stale source at a page edge or its validated anchor', () => {
    const resident = page(10, 20);
    const state = {
      snapshot: 's1',
      doc: 'a',
      tracks: [],
      page: { ...resident, anchor: { token: 14, relToken: 4, charsUtf16: { start: 4, end: 5 } } },
      state: { status: 'pending' as const },
    };
    expect(footerPassageDisplay(state, { doc: 'a', token: 16 }, 's1')).toMatchObject({
      token: 16,
      stale: false,
    });
    expect(footerPassageDisplay(state, { doc: 'a', token: 80 }, 's1')).toMatchObject({
      token: 19,
      stale: true,
    });
    expect(footerPassageDisplay(state, { doc: 'a', token: 0 }, 's1')).toMatchObject({
      token: 10,
      stale: true,
    });
    expect(footerPassageDisplay(state, { doc: 'b', token: 80 }, 's1')).toMatchObject({
      token: 14,
      stale: true,
    });
    expect(footerPassageDisplay({
      ...state,
      page: { ...resident, anchor: { token: 80, relToken: 70, charsUtf16: { start: 70, end: 71 } } },
    }, { doc: 'b', token: 80 }, 's1')).toMatchObject({
      token: 10,
      stale: true,
    });
    expect(footerPassageDisplay(state, { doc: 'a', token: 16 }, 's2')).toBeNull();
  });
});
