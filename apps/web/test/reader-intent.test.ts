import { describe, expect, it } from 'vitest';
import { readerPlaceFor } from '../src/lib/reader-intent.ts';

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
});
