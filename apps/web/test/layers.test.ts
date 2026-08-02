import { describe, expect, it } from 'vitest';
import {
  historyStateFor,
  parseLayerHistory,
  pushLayer,
  reconcileLayerRefs,
  replaceTopLayer,
  updateLayerUI,
  type Layer,
} from '../src/lib/layers.ts';

const ids = {
  place: '00000000-0000-4000-8000-000000000001',
  row: '00000000-0000-4000-8000-000000000002',
  sheet: '00000000-0000-4000-8000-000000000003',
  reader: '00000000-0000-4000-8000-000000000004',
  other: '00000000-0000-4000-8000-000000000005',
} as const;

function layer(kind: Layer['kind'], id: string, target: unknown = { secret: 'never serialize' }): Layer {
  return {
    kind,
    id,
    target,
    returnFocusTo: `return-${kind}`,
  };
}

describe('layer history boundary', () => {
  it('serializes only kind and minted id, never targets or focus identities', () => {
    const state = historyStateFor([
      layer('place', ids.place, { term: 'Holmes', token: 42 }),
      layer('sheet', ids.sheet, { note: 'private note' }),
    ]);
    expect(state).toEqual({
      tt: {
        v: 1,
        layers: [
          { kind: 'place', id: ids.place },
          { kind: 'sheet', id: ids.sheet },
        ],
      },
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/Holmes|token|private|return-/);
    expect(parseLayerHistory(state)).toEqual({
      valid: true,
      refs: state.tt.layers,
    });
    expect(() => historyStateFor([
      layer('sheet', 'private passage text'),
    ])).toThrow(/minted UUID/);
  });

  it('is total and salvages the longest valid bounded prefix for normalization', () => {
    const whollyInvalid: readonly unknown[] = [
      null,
      {},
      { tt: { v: 2, layers: [] } },
      { tt: { v: 1, layers: 'nope' } },
      { tt: { v: 1, layers: [{ kind: 'sheet', id: 'a passage or note' }] } },
    ];
    for (const state of whollyInvalid) {
      expect(() => parseLayerHistory(state)).not.toThrow();
      expect(parseLayerHistory(state)).toEqual({ valid: false, refs: [] });
    }

    const duplicate = { tt: { v: 1, layers: [
        { kind: 'sheet', id: ids.sheet },
        { kind: 'sheet', id: ids.sheet },
      ] } };
    expect(parseLayerHistory(duplicate)).toEqual({
      valid: false,
      refs: [{ kind: 'sheet', id: ids.sheet }],
    });

    const misplacedPlace = { tt: { v: 1, layers: [
        { kind: 'sheet', id: ids.sheet },
        { kind: 'place', id: ids.place },
      ] } };
    expect(parseLayerHistory(misplacedPlace)).toEqual({
      valid: false,
      refs: [{ kind: 'sheet', id: ids.sheet }],
    });

    const overDeep = { tt: { v: 1, layers: Array.from({ length: 17 }, (_, i) => ({
        kind: 'sheet',
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      })) } };
    const parsed = parseLayerHistory(overDeep);
    expect(parsed.valid).toBe(false);
    expect(parsed.refs).toHaveLength(16);
  });
});

describe('layer stack transitions', () => {
  it('starts a fresh stack for a place and preserves depth for transient layers', () => {
    const old = [layer('place', ids.place), layer('sheet', ids.sheet)];
    const nextPlace = layer('place', ids.other);
    expect(pushLayer(old, nextPlace)).toEqual([nextPlace]);
    expect(pushLayer([nextPlace], layer('row-detail', ids.row))).toHaveLength(2);
  });

  it('permits governed authoring over Reader and rejects other deeper surfaces', () => {
    const place = layer('place', ids.place);
    const reader = layer('reader', ids.reader);
    const authoring = layer('row-detail', ids.row);
    expect(pushLayer([place, reader], authoring)).toEqual([place, reader, authoring]);
    expect(() => pushLayer([place, reader], layer('sheet', ids.sheet)))
      .toThrow(/authoring row-detail/);
    const deep = Array.from({ length: 16 }, (_, i) => layer(
      'sheet',
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ));
    expect(() => pushLayer(deep, layer('sheet', ids.other))).toThrow(/limited to 16/);
    expect(() => historyStateFor([place, reader, layer('sheet', ids.sheet)]))
      .toThrow(/authoring row-detail/);
  });

  it('replaces active depth and changes UI without changing identity', () => {
    const place = layer('place', ids.place);
    const row = layer('row-detail', ids.row);
    const replacement = layer('row-detail', ids.other);
    expect(replaceTopLayer([place, row], replacement)).toEqual([place, replacement]);

    const stack = [place, layer('sheet', ids.sheet)];
    const changed = updateLayerUI(stack, ids.sheet, { detent: 'half', scrollKey: 'evidence' });
    expect(changed[1]).toMatchObject({
      id: ids.sheet,
      ui: { detent: 'half', scrollKey: 'evidence' },
    });
    expect(historyStateFor(changed)).toEqual(historyStateFor(stack));
    expect(updateLayerUI(changed, ids.other, { detent: 'tall' })).toBe(changed);

    const readerStack = [place, layer('reader', ids.reader)];
    const reading = updateLayerUI(readerStack, ids.reader, { reader: 'full' });
    expect(reading[1]).toMatchObject({ id: ids.reader, ui: { reader: 'full' } });
    expect(historyStateFor(reading)).toEqual(historyStateFor(readerStack));
    expect(parseLayerHistory({
      tt: {
        v: 1,
        layers: [{ kind: 'reader', id: ids.reader, ui: { reader: 'full' } }],
      },
    })).toEqual({
      valid: true,
      refs: [{ kind: 'reader', id: ids.reader }],
    });
  });

  it('reconciles backward and forward, truncating at the first dead identity', () => {
    const place = layer('place', ids.place);
    const row = layer('row-detail', ids.row);
    const sheet = layer('sheet', ids.sheet);
    const reader = layer('reader', ids.reader);
    const registry = new Map([place, row, sheet, reader].map((item) => [item.id, item]));
    const resolve = (id: string) => registry.get(id);

    expect(reconcileLayerRefs(
      [place, row].map(({ kind, id }) => ({ kind, id })),
      resolve,
    )).toEqual({
      layers: [place, row],
      refs: [
        { kind: 'place', id: ids.place },
        { kind: 'row-detail', id: ids.row },
      ],
      truncated: false,
    });

    const forward = reconcileLayerRefs(
      [place, row, sheet, reader].map(({ kind, id }) => ({ kind, id })),
      resolve,
    );
    expect(forward.layers).toEqual([place, row, sheet, reader]);
    expect(forward.truncated).toBe(false);

    registry.delete(ids.sheet);
    const dead = reconcileLayerRefs(
      [place, row, sheet, reader].map(({ kind, id }) => ({ kind, id })),
      resolve,
    );
    expect(dead.layers).toEqual([place, row]);
    expect(dead.truncated).toBe(true);

    const mismatch = reconcileLayerRefs(
      [{ kind: 'reader', id: ids.row }],
      resolve,
    );
    expect(mismatch).toEqual({ layers: [], refs: [], truncated: true });

    expect(reconcileLayerRefs(
      [
        { kind: 'place', id: ids.place },
        { kind: 'reader', id: ids.reader },
        { kind: 'sheet', id: ids.sheet },
      ],
      resolve,
    )).toEqual({
      layers: [place, reader],
      refs: [
        { kind: 'place', id: ids.place },
        { kind: 'reader', id: ids.reader },
      ],
      truncated: true,
    });
    expect(reconcileLayerRefs(
      [
        { kind: 'place', id: ids.place },
        { kind: 'reader', id: ids.reader },
        { kind: 'row-detail', id: ids.row },
      ],
      resolve,
    )).toEqual({
      layers: [place, reader, row],
      refs: [
        { kind: 'place', id: ids.place },
        { kind: 'reader', id: ids.reader },
        { kind: 'row-detail', id: ids.row },
      ],
      truncated: false,
    });
    expect(reconcileLayerRefs(
      [
        { kind: 'place', id: ids.place },
        { kind: 'place', id: ids.other },
      ],
      resolve,
    )).toEqual({
      layers: [place],
      refs: [{ kind: 'place', id: ids.place }],
      truncated: true,
    });
  });
});
