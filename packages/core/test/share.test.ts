import { describe, expect, it } from 'vitest';
import type { TextHash } from '../src/contract/brands.ts';
import { parseShareLink } from '../src/project/share.ts';
import type { ShareLinkV1 } from '../src/project/share.ts';

const HASH = 'a'.repeat(64) as TextHash;

function share(): ShareLinkV1 {
  return {
    s: 1,
    n: {
      schema: 'texttrends/query-notebook/1',
      groups: [{
        id: 'g1',
        name: 'clue',
        members: [{
          id: 'm1',
          kind: 'token',
          surface: 'clue',
          match: { case: 'folded', diacritics: 'folded' },
        }],
        countOverlaps: false,
      }],
    },
    a: [0],
    k: [0],
    v: {},
    x: [{ d: 'sender-a', h: HASH, t: 'A Study' }],
    r: [{
      doc: 'sender-a',
      text: HASH,
      chars: { start: 1, end: 4 },
    }],
  };
}

describe('share-link/1 admission', () => {
  it('admits an exact compact link and rejects unknown sender anchors', () => {
    expect(parseShareLink(share())).toEqual(share());
    expect(() => parseShareLink({
      ...share(),
      r: [{ ...share().r![0]!, doc: 'unknown' }],
    })).toThrow(/unknown sender document/);
  });

  it('rejects sparse indices, out-of-range indices, and extra fields', () => {
    const sparse = [0];
    sparse.length = 2;
    expect(() => parseShareLink({ ...share(), a: sparse })).toThrow(/dense/);
    expect(() => parseShareLink({ ...share(), a: [1] })).toThrow(/indices/);
    expect(() => parseShareLink({ ...share(), sourceText: 'secret' })).toThrow(/exact/);
  });
});
