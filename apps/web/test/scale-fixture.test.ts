import { describe, expect, it } from 'vitest';
import { segment } from '@texttrends/core';
import { SCALE_FIXTURE, scaleDocument, scaleDocumentLength, scaleWord } from '../bench/scale-fixture.ts';

describe('scale fixture contract', () => {
  it.each([1, 19, 20, 99, 100, 2000])('produces exactly %i real tokens and the declared source length', async (tokens) => {
    const text = scaleDocument(tokens, 0);
    expect(text.length).toBe(scaleDocumentLength(tokens));
    expect(new TextEncoder().encode(text).length).toBe(text.length);
    expect((await segment(text, 'en')).startsUtf16.length).toBe(tokens);
  });
  it('has distinct lexical vocabulary and reproducible document-specific streams', () => {
    const vocabulary = Array.from({ length: SCALE_FIXTURE.vocabulary }, (_, i) => scaleWord(i));
    expect(new Set(vocabulary).size).toBe(SCALE_FIXTURE.vocabulary);
    expect(vocabulary.every((word) => /^[a-z]{4}$/.test(word))).toBe(true);
    expect(scaleDocument(1000, 0)).toBe(scaleDocument(1000, 0));
    expect(scaleDocument(1000, 0)).not.toBe(scaleDocument(1000, 1));
  });
});
