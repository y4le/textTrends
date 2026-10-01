/** vocabulary behavior through the live application runtime. */

import { describe, expect, it } from 'vitest';

import { STOPLIST_EN_ID, STOPLIST_EN_VERSION } from '@texttrends/core';

import { coreGroupOf, groupTitle } from '../src/lib/notebook.ts';

import { fakeInventoryResult, fakeFrequencyResult, fakeFrequencyPage, harness, editTerm, flush } from './support/runtime-harness.ts';

describe('corpus dashboard query intent', () => {
  const rangeFor = (
    f: ReturnType<typeof harness>,
    start: number,
    end: number,
  ) => ({
    snapshot: f.store.getState().snapshot!.snapshot,
    ranges: [{ doc: 'a', tokens: { start, end } }],
  });

  it('issues inventory and frequency on each snapshot identity', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    expect(f.inventories()).toHaveLength(1);
    expect(f.frequencies()).toHaveLength(1);
    expect((f.inventories()[0]!.query as { selection: { docs: string[] } }).selection.docs)
      .toEqual(['a', 'b']);
    f.port.publishSnapshot('g1', 's2', ['a', 'b']);
    expect(f.inventories()).toHaveLength(2);
    expect(f.frequencies()).toHaveLength(2);
  });

  it('a linked brush reissues inventory and frequency', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);
    f.store.getState().setLinkedSelection(rangeFor(f, 10, 20));
    expect(f.inventories()).toHaveLength(2);
    expect(f.frequencies()).toHaveLength(2);
    for (const request of [f.inventories().at(-1)!, f.frequencies().at(-1)!]) {
      expect((request.query as {
        selection: { docs: string[]; ranges: { doc: string; tokens: { start: number; end: number } }[] };
      }).selection).toEqual({
        docs: ['a'],
        ranges: [{ doc: 'a', tokens: { start: 10, end: 20 } }],
      });
    }
  });

  it('notebook rename and member edits never reissue vocabulary-wide work', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().mergeStarterTerms('holmes');
    const group = f.store.getState().notebook.groups[0]!;
    const inventoryCount = f.inventories().length;
    const frequencyCount = f.frequencies().length;
    const trendCount = f.trends().length;

    editTerm(f.store.getState(), group.id, { displayName: 'Detective' });
    const member = coreGroupOf(group).members[0]!;
    if (member.kind !== 'token') throw new Error('quick-add must create a token member');
    editTerm(f.store.getState(), group.id, { aliases: ['watson'], countOverlaps: false });

    expect(f.inventories()).toHaveLength(inventoryCount);
    expect(f.frequencies()).toHaveLength(frequencyCount);
    expect(f.trends().length).toBeGreaterThan(trendCount);
  });

  it('guards selection, sort, and page replacements against late results', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const initialFrequency = f.frequencies().at(-1)!;
    f.store.getState().setFrequencySort('key');
    const sortedFrequency = f.frequencies().at(-1)!;
    expect(initialFrequency.cancelled).toBe(true);
    initialFrequency.resolve(fakeFrequencyResult(41));
    await flush();
    expect(f.store.getState().frequency?.state.status).toBe('pending');

    f.store.getState().setFrequencyPage(100);
    expect(sortedFrequency.cancelled).toBe(true);
    sortedFrequency.resolve(fakeFrequencyResult(42));
    await flush();
    expect(f.store.getState().frequency?.state.status).toBe('pending');

    f.store.getState().setLinkedSelection(rangeFor(f, 0, 5));
    const inventoryA = f.inventories().at(-1)!;
    const frequencyA = f.frequencies().at(-1)!;
    f.store.getState().setLinkedSelection(rangeFor(f, 10, 15));
    expect(inventoryA.cancelled).toBe(true);
    expect(frequencyA.cancelled).toBe(true);
    inventoryA.resolve(fakeInventoryResult(43));
    frequencyA.resolve(fakeFrequencyResult(43));
    await flush();
    expect(f.store.getState().inventory?.state.status).toBe('pending');
    expect(f.store.getState().frequency?.state.status).toBe('pending');
  });

  it('retains resident vocabulary rows while appending the next chunk', async () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const first = f.frequencies().at(-1)!;
    first.resolve(fakeFrequencyPage('selection-a', 3, [
      { key: 'alpha', typeId: 1 },
      { key: 'beta', typeId: 2 },
    ]));
    await flush();

    expect(f.store.getState().frequency?.resident?.rows.map((row) => row.key))
      .toEqual(['alpha', 'beta']);
    const before = f.frequencies().length;
    f.store.getState().loadMoreFrequency();
    expect(f.frequencies()).toHaveLength(before + 1);
    expect(f.store.getState().frequency).toMatchObject({
      resident: { rows: [{ key: 'alpha' }, { key: 'beta' }] },
      state: { status: 'pending' },
    });
    expect((f.frequencies().at(-1)!.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 2, limit: 1 });

    f.store.getState().loadMoreFrequency();
    expect(f.frequencies()).toHaveLength(before + 1);
    f.frequencies().at(-1)!.resolve(fakeFrequencyPage('selection-a', 3, [
      { key: 'gamma', typeId: 3 },
    ]));
    await flush();
    expect(f.store.getState().frequency).toMatchObject({
      resident: { rows: [{ key: 'alpha' }, { key: 'beta' }, { key: 'gamma' }] },
      state: { status: 'ready' },
    });
  });

  it('add-exact admits sensitive matching', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a', 'b']);

    f.store.getState().addTerm({ aliases: ['Holmes'], exactMatch: true });
    const group = f.store.getState().notebook.groups.at(-1)!;
    expect(groupTitle(group)).toBe('Holmes');
    expect(coreGroupOf(group).members).toEqual([
      expect.objectContaining({
        kind: 'token',
        surface: 'Holmes',
        match: { case: 'sensitive', diacritics: 'sensitive' },
      }),
    ]);
    expect(f.store.getState().activeGroupIds.has(group.id)).toBe(true);
  });

  it('applies atomic frequency text filters live and resets the progressive offset', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    const before = f.frequencies().length;
    f.store.getState().setFrequencyFilter({
      mode: 'literal',
      query: 'e\u0301',
    });
    expect(f.frequencies()).toHaveLength(before + 1);
    expect((f.frequencies().at(-1)!.query as {
      request: {
        filter: {
          minCount: number;
          minDocFreq: number;
          text: { mode: string; query: string };
          classes: string[];
        };
        sort: { by: string; dir: number };
        page: { offset: number; limit: number };
      };
    }).request).toEqual(expect.objectContaining({
      filter: expect.objectContaining({
        minCount: 1,
        minDocFreq: 1,
        text: { mode: 'literal', query: 'é' },
        classes: ['lexical'],
      }),
      sort: { by: 'count', dir: -1 },
      page: { offset: 0, limit: 100 },
    }));

    expect(f.store.getState().frequencyView.page).toEqual({ offset: 0, limit: 100 });
    f.store.getState().setFrequencyFilter({ mode: 'regex', query: 'é' });
    expect(f.store.getState().frequencyView.filter).toEqual({ mode: 'regex', query: 'é' });
    const valid = f.frequencies().length;
    f.store.getState().setFrequencyFilter({ mode: 'regex', query: '[' });
    expect(f.frequencies()).toHaveLength(valid);
    expect(f.store.getState().frequencyView.filter).toEqual({ mode: 'regex', query: 'é' });

    const issued = f.frequencies().length;
    f.store.getState().setFrequencyPage(5_000);
    expect(f.frequencies()).toHaveLength(issued + 1);
    expect(f.store.getState().frequencyView.page).toEqual({ offset: 5_000, limit: 100 });
    expect((f.frequencies().at(-1)!.query as {
      request: { page: { offset: number; limit: number } };
    }).request.page).toEqual({ offset: 5_000, limit: 100 });

    f.store.getState().setFrequencyFilter(null);
    expect(f.store.getState().frequencyView.filter).toBeUndefined();
    expect((f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter).not.toHaveProperty('text');
  });

  it('applies common-word depth live, resets paging, and omits the disabled filter', () => {
    const f = harness();
    f.port.publishSnapshot('g1', 's1', ['a']);
    f.store.getState().setFrequencyPage(5_000);
    const before = f.frequencies().length;
    f.store.getState().setFrequencyStoplistTopN(500);
    expect(f.frequencies()).toHaveLength(before + 1);
    expect(f.store.getState().frequencyView).toMatchObject({
      stoplistTopN: 500,
      page: { offset: 0, limit: 100 },
    });
    const enabled = (f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter;
    expect(enabled.stoplist).toEqual({
      id: STOPLIST_EN_ID,
      version: STOPLIST_EN_VERSION,
      topN: 500,
    });

    f.store.getState().setFrequencyStoplistTopN(0);
    const disabled = (f.frequencies().at(-1)!.query as {
      request: { filter: Record<string, unknown> };
    }).request.filter;
    expect(disabled).not.toHaveProperty('stoplist');
  });

});
