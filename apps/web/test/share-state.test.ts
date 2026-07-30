import { describe, expect, it } from 'vitest';
import type { ShareLinkV1, TextHash } from '@texttrends/core';
import { deflateSync } from 'fflate';
import {
  decodeShareLink,
  encodeShareFragment,
  matchShareDocuments,
  SHARE_MAX_INFLATED_BYTES,
  shareUrlFor,
} from '../src/lib/share-state.ts';

const HASH = 'a'.repeat(64) as TextHash;

const value: ShareLinkV1 = {
  s: 1,
  n: { schema: 'texttrends/query-notebook/1', groups: [] },
  a: [],
  k: [],
  v: {},
  x: [{ d: 'sender', h: HASH, t: 'Book' }],
  r: [{ doc: 'sender', text: HASH, chars: { start: 2, end: 7 } }],
};

function b64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

describe('source-free share codec', () => {
  it('round-trips canonical state through a fragment and stays under the URL cap', () => {
    const fragment = encodeShareFragment(value);
    expect(fragment.startsWith('#s=')).toBe(true);
    expect(decodeShareLink(fragment)).toEqual(value);
    expect(shareUrlFor(value, 'https://example.test/app')).toContain('#s=');
  });

  it('matches anchors by TextHash rather than sender document id', () => {
    expect(matchShareDocuments(value, [{ doc: 'local-id', text: HASH }])).toEqual({
      anchors: [{ ...value.r![0], doc: 'local-id' }],
      matchedDocuments: 1,
      unmatchedDocuments: [],
    });
  });

  it('refuses an inflated payload before JSON parsing and carries no source excerpt', () => {
    const bomb = new TextEncoder().encode('x'.repeat(SHARE_MAX_INFLATED_BYTES + 1));
    expect(() => decodeShareLink(`#s=${b64(deflateSync(bomb))}`)).toThrow(/inflated bytes/);
    const knownExcerpt = 'To Sherlock Holmes she is always the woman';
    const fragment = encodeShareFragment(value);
    expect(fragment).not.toContain(knownExcerpt);
    expect(JSON.stringify(decodeShareLink(fragment))).not.toContain(knownExcerpt);
  });
});
