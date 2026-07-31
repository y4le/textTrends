import { describe, expect, it } from 'vitest';
import {
  findingsDomToken,
  findingsRowControlId,
  findingsRowTarget,
  findingsRowTargetIsStale,
  savedRangeRows,
  shareReviewTarget,
  reviewShareDraft,
  SHARE_REPLACE_SURVIVORS,
} from '../src/lib/findings-view.ts';
import { shareUrlFor } from '../src/lib/share-state.ts';
import { researchState } from './support/research-fixtures.ts';

describe('Findings view contracts', () => {
  it('maps admitted ids to stable, injective DOM tokens', () => {
    expect(findingsDomToken('range_1-ok')).toBe('srange_1-ok');
    expect(findingsDomToken('é')).toBe('xe9');
    expect(findingsDomToken('😀')).toBe('x1f600');
    expect(findingsDomToken('x1f600')).toBe('sx1f600');
    expect(findingsDomToken('a/b')).toBe('x61-2f-62');
    expect(findingsRowControlId('pin', 'a/b')).toBe('findings-pin-x61-2f-62');
    expect(() => findingsDomToken('')).toThrow(/1–128/);
    expect(() => findingsDomToken('x'.repeat(129))).toThrow(/1–128/);
  });

  it('totally parses row and share targets and rejects hostile ids', () => {
    expect(findingsRowTarget({
      surface: 'findings-row',
      kind: 'range',
      id: 'a/b',
    })).toEqual({ surface: 'findings-row', kind: 'range', id: 'a/b' });
    for (const value of [
      null,
      [],
      { surface: 'findings-row', kind: 'foreign', id: 'a' },
      { surface: 'findings-row', kind: 'pin', id: '' },
      { surface: 'findings-row', kind: 'pin', id: 'x'.repeat(129) },
      { surface: 'findings-row', kind: 'pin', id: 4 },
    ]) {
      expect(findingsRowTarget(value)).toBeNull();
    }
    expect(shareReviewTarget({ surface: 'share-review' })).toEqual({
      surface: 'share-review',
    });
    expect(shareReviewTarget({ surface: 'other' })).toBeNull();
  });

  it('stales a row only when its identity leaves its own group', () => {
    const groups = {
      range: new Set(['r']),
      pin: new Set(['p']),
      anchor: new Set(['a']),
    };
    expect(findingsRowTargetIsStale(
      { surface: 'findings-row', kind: 'pin', id: 'p' },
      groups,
    )).toBe(false);
    expect(findingsRowTargetIsStale(
      { surface: 'findings-row', kind: 'pin', id: 'r' },
      groups,
    )).toBe(true);
  });

  it('projects saved ranges without excerpt text and attaches session checks', () => {
    const rows = savedRangeRows([{
      id: 'r',
      name: 'Opening',
      anchor: {
        doc: 'a',
        text: 'sha256:text' as never,
        chars: { start: 0, end: 12 },
      },
    }], new Map([['r', {
      status: 'ok' as const,
      doc: 'a',
      tokens: { start: 2, end: 4 },
    }]]), new Map([['a', 'A Study in Scarlet']]));
    expect(rows).toEqual([{
      id: 'r',
      controlId: 'findings-range-sr',
      name: 'Opening',
      document: 'A Study in Scarlet',
      charSpan: '1–12',
      check: {
        status: 'ok',
        doc: 'a',
        tokens: { start: 2, end: 4 },
      },
    }]);
  });

  it('reviews a share draft and document matches without mutating state', () => {
    const research = researchState('p', 1);
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const value = shareUrlFor({
      s: 1,
      n: research.notebook,
      a: [],
      k: [],
      x: [
        { d: 'sender-a', h: hashA, t: 'A' },
        { d: 'sender-b', h: hashB, t: 'B' },
      ],
      r: [{
        doc: 'sender-a',
        text: hashA as never,
        chars: { start: 0, end: 4 },
      }],
      v: {},
    }, 'https://example.test/textTrends/');
    expect(reviewShareDraft(value, [{ doc: 'local-a', text: hashA }]))
      .toEqual({
        status: 'ready',
        groups: 0,
        documents: 2,
        anchors: 1,
        matchedDocuments: 1,
        unmatchedDocuments: ['B'],
      });
    expect(reviewShareDraft('', [])).toEqual({ status: 'empty' });
    expect(reviewShareDraft('#s=not-valid', [])).toMatchObject({
      status: 'invalid',
    });
    expect(SHARE_REPLACE_SURVIVORS).toContain('keeps your pinned evidence');
  });
});
