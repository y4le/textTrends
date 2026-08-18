import { describe, expect, it } from 'vitest';
import { defaultSeriesStyle } from '@texttrends/core';
import {
  compileFindQuery,
  findBarModel,
  findStatusText,
  findWrapped,
  NO_INTERACTION,
  type FindState,
} from '../src/lib/interaction.ts';

function ids(): () => string {
  let next = 0;
  return () => String(++next);
}

describe('temporary corpus Find model', () => {
  it('compiles comma-authored aliases through the Terms dialect as one group', () => {
    const composed = compileFindQuery('  Cafe\u0301 noir, café, New Yo*, café  ', ids());
    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error('expected a compiled query');
    expect(composed.query.raw).toBe('Café noir, café, New Yo*');
    expect(composed.query.label).toBe('Café noir');
    expect(composed.query.seriesId).toBe('find-series:2');
    expect(composed.query.group).toMatchObject({
      id: 'find-group:1',
      countOverlaps: false,
      members: [{ kind: 'phrase' }, { kind: 'token' }, { kind: 'phrase' }],
    });
  });

  it.each([
    ['', 'type at least one letter or number'],
    ['   ', 'type at least one letter or number'],
    ['---', 'type at least one letter or number'],
    ['*', 'use one * at the start or end, like New Yo*'],
    ['*abc*', 'use one * at the start or end, like New Yo*'],
  ])('refuses invalid term input %j', (raw, message) => {
    expect(compileFindQuery(raw, ids())).toEqual({ ok: false, message });
  });

  it('accepts the existing wildcard alias language', () => {
    const compiled = compileFindQuery('New Yo*', ids());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('expected a compiled query');
    expect(compiled.query.group.members[0]).toMatchObject({
      kind: 'phrase',
      elements: [{ kind: 'token' }, { kind: 'prefix' }],
    });
  });

  it('derives forward, backward, and self wraps from declared corpus order', () => {
    const docs = ['a', 'b'];
    expect(findWrapped({ doc: 'b', token: 8 }, { doc: 'a', token: 1 }, 1, docs)).toBe(true);
    expect(findWrapped({ doc: 'a', token: 1 }, { doc: 'b', token: 8 }, -1, docs)).toBe(true);
    expect(findWrapped({ doc: 'a', token: 1 }, { doc: 'b', token: 8 }, 1, docs)).toBe(false);
    expect(findWrapped({ doc: 'a', token: 1 }, { doc: 'a', token: 2 }, 1, docs)).toBe(false);
    expect(findWrapped({ doc: 'a', token: 1 }, { doc: 'a', token: 1 }, 1, docs)).toBe(true);
  });

  it('provides one textual status model and control state', () => {
    const base = {
      snapshot: 's1',
      query: {
        raw: 'holmes',
        label: 'holmes',
        seriesId: 'find-series:1',
        group: { id: 'find-group:1', members: [], countOverlaps: false },
        identity: 'identity',
        style: defaultSeriesStyle(0),
      },
      anchor: { doc: 'a', token: 4 },
      trend: { status: 'pending' },
      dispersion: { status: 'pending' },
    } satisfies Omit<FindState, 'state'>;
    expect(findStatusText(null, (doc) => doc))
      .toBe('Type a term or comma-separated aliases to find in the corpus.');
    expect(findStatusText({ ...base, state: { status: 'pending', direction: 1 } }, () => 'Book A'))
      .toBe('Searching for “holmes”.');
    expect(findStatusText({ ...base, state: { status: 'edge' } }, () => 'Book A'))
      .toBe('No matches for “holmes” in this corpus.');
    expect(findStatusText({
      ...base,
      state: {
        status: 'ready', direction: 1, wrapped: false,
        hit: { doc: 'a', token: 4, spanTokens: 1, members: [0] },
      },
    }, () => 'Book A')).toBe('“holmes” in Book A · token 5.');
    expect(findStatusText({
      ...base,
      state: {
        status: 'ready', direction: -1, wrapped: true,
        hit: { doc: 'a', token: 4, spanTokens: 1, members: [0] },
      },
    }, () => 'Book A')).toBe('Wrapped to the last match of “holmes” · Book A · token 5.');
    expect(findStatusText({ ...base, state: { status: 'error', message: 'offline' } }, () => 'Book A'))
      .toBe('Find failed: offline');

    expect(findBarModel(NO_INTERACTION)).toEqual({ hasSubmittedQuery: false, busy: false });
    expect(findBarModel({ kind: 'find', find: null }))
      .toEqual({ hasSubmittedQuery: false, busy: false });
    expect(findBarModel({
      kind: 'find',
      find: { ...base, state: { status: 'pending', direction: 1 } },
    })).toEqual({ hasSubmittedQuery: true, busy: true });
  });
});
