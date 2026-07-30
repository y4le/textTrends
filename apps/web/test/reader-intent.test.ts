import { describe, expect, it } from 'vitest';
import {
  readerPlaceFor,
  sameReaderCursor,
  sameReaderPlace,
} from '../src/lib/reader-intent.ts';

describe('reader open intent', () => {
  it('turns a live served position into an around cursor', () => {
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'a', token: 7, from: 'pin' },
      's1',
      ['a', 'b'],
    )).toEqual({
      snapshot: 's1',
      doc: 'a',
      cursor: { kind: 'around', token: 7 },
      from: 'pin',
    });
  });

  it('refuses stale snapshots, departed docs, and invalid tokens', () => {
    expect(readerPlaceFor(
      { snapshot: 'old', doc: 'a', token: 7, from: 'kwic' },
      's1',
      ['a'],
    )).toBeNull();
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'gone', token: 7, from: 'barcode' },
      's1',
      ['a'],
    )).toBeNull();
    expect(readerPlaceFor(
      { snapshot: 's1', doc: 'a', token: -1, from: 'passage' },
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
    };
    expect(sameReaderPlace(place, { ...place, cursor: { ...place.cursor } })).toBe(true);
    expect(sameReaderPlace(place, { ...place, cursor: { kind: 'from', token: 3 } })).toBe(false);
    expect(sameReaderPlace(place, { ...place, from: 'pin' })).toBe(false);
    expect(sameReaderPlace(place, null)).toBe(false);
    expect(sameReaderCursor(place.cursor, { ...place.cursor })).toBe(true);
    expect(sameReaderCursor(place.cursor, { kind: 'from', token: 3 })).toBe(false);
  });
});
