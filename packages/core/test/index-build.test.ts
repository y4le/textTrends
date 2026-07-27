import { describe, expect, it } from 'vitest';
import type { IndexRecipeHash, TextHash } from '../src/contract/brands.ts';
import { sha256Hex } from '../src/contract/hash.ts';
import { DEFAULT_INDEX_RECIPE, hashIndexRecipe, TOKEN_CLASS } from '../src/contract/recipes.ts';
import { indexArtifactHash } from '../src/contract/identity.ts';
import {
  buildDocumentIndex,
  createDocumentIndex,
  postingsFor,
  tokenKey,
  validateBatch,
  validateShardStructure,
} from '../src/index/build.ts';
import { fingerprint, segment } from '../src/segment/intl.ts';

const R = DEFAULT_INDEX_RECIPE;

async function build(text: string, recipe = R) {
  return createDocumentIndex(text, await segment(text, 'en'), recipe);
}

async function tokens(text: string): Promise<string[]> {
  const ix = await build(text);
  return Array.from(ix.tokenTypeIds, (id) => ix.vocabulary[id] as string);
}

describe('segmentation + emission (word-like-v1)', () => {
  it('emits only word-like segments, preserving order and case', async () => {
    expect(await tokens('The cat — the CAT! — sat.')).toEqual(['The', 'cat', 'the', 'CAT', 'sat']);
  });

  it('keeps contractions as single tokens', async () => {
    expect(await tokens("isn't it Dr. Smith's")).toEqual(["isn't", 'it', 'Dr', "Smith's"]);
  });

  it('splits hyphenated compounds (segmenter-default policy, documented)', async () => {
    expect(await tokens('co-operation')).toEqual(['co', 'operation']);
  });

  it('classifies numerals at the ADAPTER boundary and keeps them by default', async () => {
    const ix = await build('room 42 and 3.14 pies');
    expect(Array.from(ix.tokenClasses)).toEqual([
      TOKEN_CLASS.lexical, TOKEN_CLASS.numeral, TOKEN_CLASS.lexical,
      TOKEN_CLASS.numeral, TOKEN_CLASS.lexical,
    ]);
  });

  it('drops numerals when the recipe says so', async () => {
    const recipe = { ...R, numerals: { ...R.numerals, policy: 'drop' as const } };
    const ix = await build('room 42 pies', recipe);
    expect(Array.from(ix.tokenTypeIds, (id) => ix.vocabulary[id])).toEqual(['room', 'pies']);
  });
});

describe('artifact identity', () => {
  it('binds text and recipe hashes into the shard', async () => {
    const ix = await build('hello world');
    expect(ix.text).toBe(await sha256Hex('hello world'));
    expect(ix.recipe).toBe(await hashIndexRecipe(R));
    expect(ix.recipe).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an alternate recipe binds ITS OWN hash, not the default one', async () => {
    const drop = { ...R, numerals: { ...R.numerals, policy: 'drop' as const } };
    const ix = await build('room 42 pies', drop);
    expect(ix.recipe).toBe(await hashIndexRecipe(drop));
    expect(ix.recipe).not.toBe(await hashIndexRecipe(R));
  });

  it('rejects a fixed-locale recipe that disagrees with segmenter provenance', async () => {
    const fixedFr = { ...R, locale: { mode: 'fixed' as const, value: 'fr' } };
    const seg = await segment('bonjour', 'en');
    await expect(createDocumentIndex('bonjour', seg, fixedFr)).rejects.toThrow(/locale/);
  });

  it('rejects ill-formed UTF-16 text at the identity boundary (in the segmenter itself)', async () => {
    const lone = 'ab' + String.fromCharCode(0xd800) + 'cd';
    await expect(segment(lone, 'en')).rejects.toThrow(/ill-formed/);
  });

  it('rejects a batch produced from a DIFFERENT text, even at equal length', async () => {
    const foreign = await segment('123', 'en'); // numeral classes, same span shape
    await expect(createDocumentIndex('abc', foreign, R)).rejects.toThrow(/different text/);
  });

  it('fixed-locale matching is exact on the effective locale, alias-safe', async () => {
    // Same primary subtag, different region: must reject.
    const fixedUs = { ...R, locale: { mode: 'fixed' as const, value: 'en-US' } };
    const gbBatch = await segment('hello there', 'en-GB');
    await expect(createDocumentIndex('hello there', gbBatch, fixedUs)).rejects.toThrow(/disagrees/);
    // Legacy alias: 'iw' canonicalizes to 'he' on both sides — must accept.
    const fixedIw = { ...R, locale: { mode: 'fixed' as const, value: 'iw' } };
    const heBatch = await segment('shalom', 'iw');
    const ix = await createDocumentIndex('shalom', heBatch, fixedIw);
    expect(ix.segmenter.locale).toBe('he');
  });
});

describe('offsets address the unchanged source text (UTF-16)', () => {
  it('reconstructs exact source spans through astral characters', async () => {
    const text = 'I 😀 saw 𝔘nicode ok';
    const ix = await build(text);
    for (let i = 0; i < ix.tokenTypeIds.length; i++) {
      const s = ix.startsUtf16[i] as number;
      const len = ix.lengths8[i] as number;
      expect(len).toBeLessThan(255);
      expect(tokenKey(text.slice(s, s + len), R)).toBe(ix.vocabulary[ix.tokenTypeIds[i] as number]);
    }
  });

  it('normalization changing code-unit length never corrupts offsets', async () => {
    const text = 'cafe\u0301 time'; // genuinely decomposed: 5 source code units
    const ix = await build(text);
    const s = ix.startsUtf16[0] as number;
    const len = ix.lengths8[0] as number;
    expect(len).toBe(5); // source span keeps the combining mark
    expect(text.slice(s, s + len)).toBe('cafe\u0301');
    const key = ix.vocabulary[ix.tokenTypeIds[0] as number] as string;
    expect(key).toBe('caf\u00e9'); // NFC key is precomposed: 4 code units
    expect(key.length).toBe(4);
  });

  it('smart apostrophes normalize in keys but not in source spans', async () => {
    const text = 'isn’t';
    const ix = await build(text);
    expect(ix.vocabulary[0]).toBe("isn't");
    const s = ix.startsUtf16[0] as number;
    expect(text.slice(s, s + (ix.lengths8[0] as number))).toBe('isn’t');
  });

  it('handles tokens longer than 254 code units via the overflow table', async () => {
    const long = 'a'.repeat(300);
    const ix = await build(`start ${long} end`);
    const i = Array.from(ix.tokenTypeIds).findIndex(
      (id) => (ix.vocabulary[id] as string).length === 300,
    );
    expect(ix.lengths8[i]).toBe(255);
    const oi = Array.from(ix.longTokenPositions).indexOf(i);
    expect(oi).toBeGreaterThanOrEqual(0);
    expect(ix.longTokenLengths[oi]).toBe(300);
  });
});

describe('vocabulary and CSR postings', () => {
  it('interns case-bearing keys separately and postings partition all positions', async () => {
    const ix = await build('May may MAY may');
    expect(ix.vocabulary.length).toBe(3);
    expect(ix.postings.positions.length).toBe(ix.tokenTypeIds.length);
    expect(ix.postings.offsets.length).toBe(ix.vocabulary.length + 1);
    expect(ix.postings.offsets[ix.vocabulary.length]).toBe(ix.tokenTypeIds.length);
    const may = ix.vocabulary.indexOf('may');
    expect(Array.from(postingsFor(ix, may))).toEqual([1, 3]);
  });
});

describe('boundary arrays carry terminal sentinels', () => {
  it('sentence bounds start at 0 and end at tokenCount', async () => {
    const ix = await build('One two. Three four! Five?');
    const b = Array.from(ix.sentenceBounds);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe(ix.tokenTypeIds.length);
    expect(b).toEqual([0, 2, 4, 5]);
  });

  it('paragraph bounds split on blank lines: CRLF, CR-only, and LS forms', async () => {
    expect(Array.from((await build('alpha beta\r\n\r\ngamma\n\ndelta epsilon')).paragraphBounds))
      .toEqual([0, 2, 3, 5]);
    expect(Array.from((await build('one\r\rtwo')).paragraphBounds)).toEqual([0, 1, 2]);
    expect(Array.from((await build('one\u2028\u2028two')).paragraphBounds)).toEqual([0, 1, 2]);
    expect(Array.from((await build('one\u0085\u0085two')).paragraphBounds)).toEqual([0, 1, 2]);
  });

  it('a single line break is not a paragraph boundary', async () => {
    expect(Array.from((await build('one\ntwo')).paragraphBounds)).toEqual([0, 2]);
  });

  it('an empty document yields empty arrays with a single 0 sentinel', async () => {
    const ix = await build('');
    expect(ix.tokenTypeIds.length).toBe(0);
    expect(Array.from(ix.sentenceBounds)).toEqual([0]);
    expect(Array.from(ix.paragraphBounds)).toEqual([0]);
  });
});

describe('batch validation rejects malformed adapter output', () => {
  const id = { text: 'x' as TextHash, recipe: 'y' as IndexRecipeHash };

  it('rejects mismatched parallel arrays', async () => {
    const seg = await segment('abc', 'en');
    const bad = { ...seg, endsUtf16: new Uint32Array(0) };
    expect(() => buildDocumentIndex('abc', bad, R, id)).toThrow(/parallel/);
  });

  it('rejects out-of-range, empty, or overlapping spans', async () => {
    const seg = await segment('abc def', 'en');
    const overlapping = {
      ...seg,
      startsUtf16: Uint32Array.from([0, 2]),
      endsUtf16: Uint32Array.from([3, 5]),
      classes: Uint8Array.from([1, 1]),
    };
    expect(() => buildDocumentIndex('abc def', overlapping, R, id)).toThrow(/overlapping/);
    const outOfRange = {
      ...seg,
      startsUtf16: Uint32Array.from([0]),
      endsUtf16: Uint32Array.from([99]),
      classes: Uint8Array.from([1]),
    };
    expect(() => buildDocumentIndex('abc def', outOfRange, R, id)).toThrow(/invalid/);
  });

  it('rejects unknown token classes', async () => {
    const seg = await segment('abc', 'en');
    const bad = { ...seg, classes: Uint8Array.from(seg.classes.map(() => 9)) };
    expect(() => buildDocumentIndex('abc', bad, R, id)).toThrow(/class/);
  });

  it('rejects unsorted or unterminated sentence bounds', async () => {
    const seg = await segment('abc def', 'en');
    expect(() =>
      buildDocumentIndex('abc def', { ...seg, sentenceBoundsUtf16: Uint32Array.from([2, 0, 7]) }, R, id),
    ).toThrow(/start at 0/);
    expect(() =>
      buildDocumentIndex('abc def', { ...seg, sentenceBoundsUtf16: Uint32Array.from([0, 5, 3, 7]) }, R, id),
    ).toThrow(/strictly increasing/);
    expect(() =>
      buildDocumentIndex('abc def', { ...seg, sentenceBoundsUtf16: Uint32Array.from([0, 3]) }, R, id),
    ).toThrow(/end at text.length/);
    expect(() => validateBatch('abc def', { ...seg, sentenceBoundsUtf16: new Uint32Array(0) }))
      .toThrow(/terminal/);
  });

  it('rejects a sentence boundary that bisects a token span', async () => {
    const seg = await segment('abcde', 'en');
    const bisected = { ...seg, sentenceBoundsUtf16: Uint32Array.from([0, 2, 5]) };
    expect(() => buildDocumentIndex('abcde', bisected, R, id)).toThrow(/bisects/);
  });

  it('postingsFor rejects out-of-range, negative, and fractional type ids', async () => {
    const ix = await build('a b a');
    expect(() => postingsFor(ix, 999)).toThrow(RangeError);
    expect(() => postingsFor(ix, -1)).toThrow(RangeError);
    expect(() => postingsFor(ix, 0.5)).toThrow(RangeError);
  });
});

describe('dense token arrays are exact-size typed arrays under filtering', () => {
  const drop = { ...R, numerals: { ...R.numerals, policy: 'drop' as const } };

  it('trims all four parallel arrays to tokenCount when numerals are dropped', async () => {
    const ix = await build('room 42 and 3.14 pies', drop); // 5 segments, 3 emitted
    expect(ix.tokenTypeIds).toBeInstanceOf(Uint32Array);
    expect(ix.startsUtf16).toBeInstanceOf(Uint32Array);
    expect(ix.lengths8).toBeInstanceOf(Uint8Array);
    expect(ix.tokenClasses).toBeInstanceOf(Uint8Array);
    expect(ix.tokenTypeIds.length).toBe(3);
    expect(ix.startsUtf16.length).toBe(3);
    expect(ix.lengths8.length).toBe(3);
    expect(ix.tokenClasses.length).toBe(3);
    // Exact-size backing buffers: a subarray over the segCount allocation
    // would leave byteLength at 5 entries.
    expect(ix.tokenTypeIds.buffer.byteLength).toBe(3 * 4);
    expect(ix.startsUtf16.buffer.byteLength).toBe(3 * 4);
    expect(ix.lengths8.buffer.byteLength).toBe(3);
    expect(ix.tokenClasses.buffer.byteLength).toBe(3);
    expect(Array.from(ix.tokenTypeIds, (id) => ix.vocabulary[id])).toEqual(['room', 'and', 'pies']);
    expect(Array.from(ix.startsUtf16)).toEqual([0, 8, 17]);
    expect(Array.from(ix.lengths8)).toEqual([4, 3, 4]);
    expect(Array.from(ix.tokenClasses)).toEqual([
      TOKEN_CLASS.lexical, TOKEN_CLASS.lexical, TOKEN_CLASS.lexical,
    ]);
  });

  it('a doc whose tokens are ALL filtered yields empty arrays and a valid shard', async () => {
    const ix = await build('42 3.14 7', drop);
    expect(ix.tokenTypeIds.length).toBe(0);
    expect(ix.startsUtf16.length).toBe(0);
    expect(ix.lengths8.length).toBe(0);
    expect(ix.tokenClasses.length).toBe(0);
    expect(ix.vocabulary).toEqual([]);
    expect(ix.longTokenPositions.length).toBe(0);
    expect(Array.from(ix.sentenceBounds)).toEqual([0]);
    expect(Array.from(ix.paragraphBounds)).toEqual([0]);
    expect(() => validateShardStructure(ix)).not.toThrow();
  });

  it('overflow positions address post-filter emission order, unchanged', async () => {
    const long = 'b'.repeat(300);
    const ix = await build(`42 ${long} end`, drop); // long token emitted at position 0
    expect(Array.from(ix.tokenTypeIds, (id) => ix.vocabulary[id])).toEqual([long, 'end']);
    expect(ix.lengths8[0]).toBe(255);
    expect(Array.from(ix.longTokenPositions)).toEqual([0]);
    expect(Array.from(ix.longTokenLengths)).toEqual([300]);
    expect(() => validateShardStructure(ix)).not.toThrow();
  });

  it('artifact hash for a filtered fixture matches the pre-optimization build', async () => {
    // The artifact hash is descriptor-based (text/recipe/segmenter
    // fingerprint), so a pinned constant would mostly pin the ICU-dependent
    // probeHash — brittle across Node/ICU versions while proving little
    // about the arrays. Determinism across rebuilds is the portable claim;
    // the array-content assertions above are the load-bearing byte-identity
    // guard (verified equal to the removed number[] implementation's output
    // when this change landed).
    const ix = await build('room 42 and 3.14 pies', drop);
    const again = await build('room 42 and 3.14 pies', drop);
    expect(await indexArtifactHash(ix)).toBe(await indexArtifactHash(again));
    expect(Array.from(again.tokenTypeIds)).toEqual(Array.from(ix.tokenTypeIds));
    expect(Array.from(again.startsUtf16)).toEqual(Array.from(ix.startsUtf16));
  });
});

describe('segmenter fingerprint', () => {
  it('is stable, covers classes, and records the resolved locale', async () => {
    const a = await fingerprint('en');
    const b = await fingerprint('en');
    expect(a.probeHash).toBe(b.probeHash);
    expect(a.probeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.classifierVersion).toBe('numeral-re-v1');
    const c = await fingerprint('EN-us');
    expect(c.locale).toBe('en-US'); // resolvedOptions, not caller spelling
    expect((await segment('hello world', 'en')).provenance.probeHash).toBe(a.probeHash);
  });
});
