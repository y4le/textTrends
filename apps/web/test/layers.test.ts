import { describe, expect, it } from 'vitest';
import {
  historyStateFor,
  parseLayerHistory,
  pushLayer,
  reconcileLayerRefs,
  replaceTopLayer,
  type Layer,
} from '../src/lib/layers.ts';

const ids = {
  place: '00000000-0000-4000-8000-000000000001',
  row: '00000000-0000-4000-8000-000000000002',
  secondRow: '00000000-0000-4000-8000-000000000003',
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
      layer('row-detail', ids.row, { note: 'private note' }),
    ]);
    expect(state).toEqual({
      tt: {
        v: 1,
        layers: [
          { kind: 'place', id: ids.place },
          { kind: 'row-detail', id: ids.row },
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
      layer('row-detail', 'private passage text'),
    ])).toThrow(/minted UUID/);
  });

  it('is total and salvages the longest valid bounded prefix for normalization', () => {
    const whollyInvalid: readonly unknown[] = [
      null,
      {},
      { tt: { v: 2, layers: [] } },
      { tt: { v: 1, layers: 'nope' } },
      { tt: { v: 1, layers: [{ kind: 'row-detail', id: 'a passage or note' }] } },
      { tt: { v: 1, layers: [{ kind: 'sheet', id: ids.secondRow }] } },
    ];
    for (const state of whollyInvalid) {
      expect(() => parseLayerHistory(state)).not.toThrow();
      expect(parseLayerHistory(state)).toEqual({ valid: false, refs: [] });
    }

    const duplicate = { tt: { v: 1, layers: [
        { kind: 'row-detail', id: ids.row },
        { kind: 'row-detail', id: ids.row },
      ] } };
    expect(parseLayerHistory(duplicate)).toEqual({
      valid: false,
      refs: [{ kind: 'row-detail', id: ids.row }],
    });

    const misplacedPlace = { tt: { v: 1, layers: [
        { kind: 'row-detail', id: ids.row },
        { kind: 'place', id: ids.place },
      ] } };
    expect(parseLayerHistory(misplacedPlace)).toEqual({
      valid: false,
      refs: [{ kind: 'row-detail', id: ids.row }],
    });

    const overDeep = { tt: { v: 1, layers: Array.from({ length: 17 }, (_, i) => ({
        kind: 'row-detail',
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      })) } };
    const parsed = parseLayerHistory(overDeep);
    expect(parsed.valid).toBe(false);
    expect(parsed.refs).toHaveLength(16);
  });
});

describe('layer stack transitions', () => {
  it('starts a fresh stack for a place and preserves depth for transient layers', () => {
    const old = [layer('place', ids.place), layer('row-detail', ids.row)];
    const nextPlace = layer('place', ids.other);
    expect(pushLayer(old, nextPlace)).toEqual([nextPlace]);
    expect(pushLayer([nextPlace], layer('row-detail', ids.row))).toHaveLength(2);
  });

  it('keeps Reader terminal because the workbench is not mounted beneath it', () => {
    const place = layer('place', ids.place);
    const reader = layer('reader', ids.reader);
    const authoring = layer('row-detail', ids.row);
    expect(() => pushLayer([place, reader], authoring))
      .toThrow(/terminal layer/);
    expect(() => pushLayer([place, reader], layer('row-detail', ids.secondRow)))
      .toThrow(/terminal layer/);
    const deep = Array.from({ length: 16 }, (_, i) => layer(
      'row-detail',
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ));
    expect(() => pushLayer(deep, layer('row-detail', ids.other))).toThrow(/limited to 16/);
    expect(() => historyStateFor([place, reader, layer('row-detail', ids.secondRow)]))
      .toThrow(/terminal layer/);
  });

  it('replaces the active depth without admitting presentation metadata', () => {
    const place = layer('place', ids.place);
    const row = layer('row-detail', ids.row);
    const replacement = layer('row-detail', ids.other);
    expect(replaceTopLayer([place, row], replacement)).toEqual([place, replacement]);

    // Legacy or foreign presentation fields never cross the history boundary.
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
    const secondRow = layer('row-detail', ids.secondRow);
    const reader = layer('reader', ids.reader);
    const registry = new Map([place, row, secondRow, reader].map((item) => [item.id, item]));
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
      [place, row, secondRow, reader].map(({ kind, id }) => ({ kind, id })),
      resolve,
    );
    expect(forward.layers).toEqual([place, row, secondRow, reader]);
    expect(forward.truncated).toBe(false);

    registry.delete(ids.secondRow);
    const dead = reconcileLayerRefs(
      [place, row, secondRow, reader].map(({ kind, id }) => ({ kind, id })),
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
        { kind: 'row-detail', id: ids.secondRow },
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
