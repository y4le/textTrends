import { describe, expect, it } from 'vitest';
import {
  liveReaderPlace,
  readerPlaceFor,
  sameReaderCursor,
  sameReaderPlace,
} from '../src/lib/reader-intent.ts';

describe('reader open intent', () => {
  it('turns a live served position into an around cursor', () => {
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'a', token: 7, from: 'kwic', anchor: 'occurrence' },
      's1',
      ['a', 'b'],
    )).toEqual({
      snapshot: 's1',
      doc: 'a',
      cursor: { kind: 'around', token: 7 },
      from: 'kwic',
      anchor: 'occurrence',
    });
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'b', token: 2, from: 'footer', anchor: 'position' },
      's1',
      ['a', 'b'],
    )?.from).toBe('footer');
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'a', token: 3, from: 'occurrence', anchor: 'occurrence' },
      's1',
      ['a'],
    )?.from).toBe('occurrence');
  });

  it('refuses stale snapshots, departed docs, and invalid tokens', () => {
    expect(readerPlaceFor(
      { snapshot: 'old', doc: 'a', token: 7, from: 'kwic', anchor: 'occurrence' },
      's1',
      ['a'],
    )).toBeNull();
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'gone', token: 7, from: 'barcode', anchor: 'occurrence' },
      's1',
      ['a'],
    )).toBeNull();
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'a', token: -1, from: 'kwic', anchor: 'occurrence' },
      's1',
      ['a'],
    )).toBeNull();
    expect(readerPlaceFor(
      {
        snapshot: 's1', doc: 'a', token: 1, from: 'kwic', anchor: 'invented',
      } as never,
      's1',
      ['a'],
    )).toBeNull();
  });

  it('compares the full snapshot/document/cursor/source identity', () => {
    const place = {
      snapshot: 's1',
      doc: 'a',
      cursor: { kind: 'around' as const, token: 3 },
      from: 'kwic' as const,
      anchor: 'occurrence' as const,
    };
    expect(sameReaderPlace(place, { ...place, cursor: { ...place.cursor } })).toBe(true);
    expect(sameReaderPlace(place, { ...place, cursor: { kind: 'from', token: 3 } })).toBe(false);
    expect(sameReaderPlace(place, { ...place, from: 'barcode' })).toBe(false);
    expect(sameReaderPlace(place, { ...place, anchor: 'position' })).toBe(false);
    expect(sameReaderPlace(place, null)).toBe(false);
    expect(sameReaderCursor(place.cursor, { ...place.cursor })).toBe(true);
    expect(sameReaderCursor(place.cursor, { kind: 'from', token: 3 })).toBe(false);
  });

  it('revalidates restored layer targets against shape and the live snapshot', () => {
    const place = {
      snapshot: 's1',
      doc: 'a',
      cursor: { kind: 'before' as const, token: 4 },
      from: 'barcode' as const,
      anchor: 'occurrence' as const,
    };
    expect(liveReaderPlace(place, 's1', ['a'])).toBe(place);
    expect(liveReaderPlace(place, 's2', ['a'])).toBeNull();
    expect(liveReaderPlace({ ...place, doc: 'gone' }, 's1', ['a'])).toBeNull();
    expect(liveReaderPlace(
      { ...place, cursor: { kind: 'before', token: 0 } },
      's1',
      ['a'],
    )).toBeNull();
    expect(liveReaderPlace(
      { ...place, from: 'invented' },
      's1',
      ['a'],
    )).toBeNull();
    expect(liveReaderPlace(
      { ...place, anchor: 'invented' },
      's1',
      ['a'],
    )).toBeNull();
  });
});
