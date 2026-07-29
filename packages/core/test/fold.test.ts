import { describe, expect, it } from 'vitest';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { createDocumentIndex } from '../src/index/build.ts';
import { buildResolver, foldKey, resolveAffix, resolveToken } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';

const R = DEFAULT_INDEX_RECIPE;
const BOTH = { case: 'folded', diacritics: 'folded' } as const;
const CASE_ONLY = { case: 'folded', diacritics: 'sensitive' } as const;
const EXACT = { case: 'sensitive', diacritics: 'sensitive' } as const;

async function shardOf(text: string, locale = 'en') {
  return createDocumentIndex(text, await segment(text, locale), R);
}

describe('foldKey', () => {
  it('case folds under the resolved locale — Turkish dotted/dotless I', () => {
    expect(foldKey('MAYIS', CASE_ONLY, 'tr')).toBe('mayıs'); // dotless ı
    expect(foldKey('MAYIS', CASE_ONLY, 'en')).toBe('mayis');
  });

  it('final sigma lowercases as Unicode specifies', () => {
    expect(foldKey('ΟΔΥΣΣΕΥΣ', CASE_ONLY, 'el')).toBe(
      'οδυσσευς', // final ς
    );
  });

  it('diacritic folding equates composed and decomposed forms', () => {
    expect(foldKey('café', BOTH, 'en')).toBe('cafe'); // precomposed
    expect(foldKey('café', BOTH, 'en')).toBe('cafe'); // decomposed
    expect(foldKey('naïve', BOTH, 'en')).toBe('naive');
  });

  it('applies case before diacritics (order is part of the contract)', () => {
    expect(foldKey('ÉTOILE', BOTH, 'en')).toBe('etoile');
  });
});

describe('resolvers bound to a shard', () => {
  it('owns the shard locale — a Turkish shard folds Turkish', async () => {
    const shard = await shardOf('MAYIS mayıs', 'tr');
    const r = await buildResolver(shard, R, CASE_ONLY);
    expect(r.locale).toBe('tr');
    // Under tr, MAYIS lowercases to mayıs — both surfaces unify.
    expect(resolveToken(r, 'MAYIS').length).toBe(2);
  });

  it('folded resolution unifies case variants; exact does not', async () => {
    const shard = await shardOf('May may MAY');
    const folded = await buildResolver(shard, R, CASE_ONLY);
    expect(resolveToken(folded, 'may').length).toBe(3);
    const exact = await buildResolver(shard, R, EXACT);
    expect(resolveToken(exact, 'may').length).toBe(1);
    expect(resolveToken(exact, 'MAY').length).toBe(1);
  });

  it('normalizes RAW query surfaces under the index recipe before folding', async () => {
    const shard = await shardOf('isn’t');
    const r = await buildResolver(shard, R, EXACT);
    // A smart-apostrophe QUERY must match the normalized index key…
    expect(resolveToken(r, 'isn’t').length).toBe(1);
    // …and so must the straight-quote spelling.
    expect(resolveToken(r, "isn't").length).toBe(1);
  });

  it('carries resolver version, mode, and recipe for cache keys/provenance', async () => {
    const shard = await shardOf('a');
    const r = await buildResolver(shard, R, BOTH);
    expect(r.resolver.version).toBe(1);
    expect(r.mode).toEqual(BOTH);
    expect(r.recipe.schema).toBe('texttrends/index-recipe/0-provisional');
  });

  it('rejects a recipe that does not match the shard recipe identity', async () => {
    const shard = await shardOf('isn’t');
    const mismatched = { ...R, apostrophes: { policy: 'keep' as const } };
    await expect(buildResolver(shard, mismatched, EXACT)).rejects.toThrow(/does not match the shard recipe/);
  });

  it('prefix and suffix match over folded keys, with normalized stems', async () => {
    const shard = await shardOf('Winterfell winter winters summer');
    const r = await buildResolver(shard, R, CASE_ONLY);
    expect(resolveAffix(r, 'prefix', 'Winter').length).toBe(3);
    expect(resolveAffix(r, 'suffix', 'er').length).toBe(2); // winter, summer
  });

  it('an EFFECTIVELY empty stem matches nothing, never the whole vocabulary', async () => {
    // validateGroup rejects raw-empty stems upstream; this is the resolution
    // guard for surfaces that fold/normalize away — '' would otherwise
    // vacuously prefix/suffix-match every folded key.
    const shard = await shardOf('winter summer otter');
    const r = await buildResolver(shard, R, BOTH);
    expect(resolveAffix(r, 'prefix', '')).toEqual([]);
    expect(resolveAffix(r, 'suffix', '')).toEqual([]);
    // A bare combining acute folds to nothing under diacritics:'folded'.
    expect(resolveAffix(r, 'prefix', '́')).toEqual([]);
  });

  it('affix output stays in vocabulary order when interleaved entries fold to one key', async () => {
    // 'Cafe' (id 0) and 'café' (id 2) both fold to 'cafe', with 'bar' (id 1)
    // between them — the collided bucket is [0, 2], not adjacent ids.
    const shard = await shardOf('Cafe bar café');
    expect(shard.vocabulary).toEqual(['Cafe', 'bar', 'café']);
    const r = await buildResolver(shard, R, BOTH);
    expect(resolveAffix(r, 'prefix', 'caf')).toEqual([0, 2]);
  });

  it('affix union across multiple buckets returns full vocabulary (ascending id) order', async () => {
    // Buckets in map insertion order: 'winter' → [0, 2], 'summer' → [1],
    // 'otter' → [3]; naive bucket flattening would yield [0, 2, 1, 3].
    const shard = await shardOf('winter summer Winter otter');
    expect(shard.vocabulary).toEqual(['winter', 'summer', 'Winter', 'otter']);
    const r = await buildResolver(shard, R, CASE_ONLY);
    expect(resolveAffix(r, 'suffix', 'er')).toEqual([0, 1, 2, 3]);
  });

});

describe('package entry point', () => {
  it('exports the milestone surface', async () => {
    const entry = await import('@texttrends/core');
    expect(typeof entry.composeSnapshot).toBe('function');
    expect(typeof entry.makeReadyDocument).toBe('function');
    expect(typeof entry.resolveSelection).toBe('function');
    expect(typeof entry.trend).toBe('function');
    expect(typeof entry.buildResolver).toBe('function');
  });
});

describe('large folded-collision buckets', () => {
  it('a bucket beyond the spread-argument limit resolves instead of throwing', async () => {
    // The review-c6-fold finding: `out.push(...ids)` overflows V8's call-
    // argument limit on a large single bucket, and a shard whose vocabulary
    // diacritic-folds thousands of variants onto one key is legal well under
    // maxVocabSize (reproduced end-to-end at 140k keys in review). The
    // resolver here is built over a real small shard, then its map is
    // swapped for a synthetic one-bucket view — the flatten path under test
    // is identical, without paying multi-second segmentation in a unit test.
    const shard = await shardOf('alpha beta');
    const real = await buildResolver(shard, R, CASE_ONLY);
    const big = Array.from({ length: 200_000 }, (_, i) => i as (typeof real.map extends ReadonlyMap<string, readonly (infer T)[]> ? T : never));
    const resolver = { ...real, map: new Map([['aaa', big]]) };
    const out = resolveAffix(resolver, 'prefix', 'a');
    expect(out.length).toBe(200_000);
    expect(out[0]).toBe(0);
    expect(out[199_999]).toBe(199_999);
  });
});
