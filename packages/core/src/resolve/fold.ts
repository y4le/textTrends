/**
 * Match-mode folding — Phase 1 plan §d.6. Versioned, honestly named:
 * - case: String.prototype.toLocaleLowerCase under the shard's RESOLVED
 *   locale ('locale-lower', not "Unicode full case folding" — it isn't);
 * - diacritics: NFD → strip Mark code points → NFC;
 * - order: case transform first, then diacritics.
 *
 * A Resolver OWNS its effective locale (taken from the shard's segmenter
 * provenance, never caller-supplied), its mode, its recipe (query surfaces
 * are normalized under the index recipe before folding — a smart-apostrophe
 * query must match the normalized index key), and the resolver version.
 * That bound metadata is exactly what cache keys and QueryHash/provenance
 * record (review findings 2 and 3).
 */

import type { LocalTypeId } from '../contract/brands.ts';
import { hashIndexRecipe, type IndexRecipeProvisional } from '../contract/recipes.ts';
import { tokenKey, type DocumentIndexV1 } from '../index/build.ts';

export const FOLD_RESOLVER = {
  id: 'fold',
  version: 1,
  case: 'locale-lower',
  diacritics: 'nfd-strip-nfc',
} as const;

export interface MatchMode {
  readonly case: 'sensitive' | 'folded';
  readonly diacritics: 'sensitive' | 'folded';
}

const MARKS_RE = /\p{M}+/gu;

export function foldKey(key: string, mode: MatchMode, locale: string): string {
  let k = key;
  if (mode.case === 'folded') k = k.toLocaleLowerCase(locale);
  if (mode.diacritics === 'folded') k = k.normalize('NFD').replace(MARKS_RE, '').normalize('NFC');
  return k;
}

export interface Resolver {
  readonly resolver: typeof FOLD_RESOLVER;
  readonly mode: MatchMode;
  /** Effective locale — from the shard's segmenter provenance. */
  readonly locale: string;
  readonly recipe: IndexRecipeProvisional;
  readonly map: ReadonlyMap<string, readonly LocalTypeId[]>;
  readonly shard: DocumentIndexV1;
}

/**
 * Build a resolver bound to one shard and one mode; the locale comes from the
 * shard, and the supplied recipe is VERIFIED against the shard's recipe hash —
 * an unrelated recipe would silently normalize queries differently than the
 * index keys were normalized (round-2 review finding).
 */
export async function buildResolver(
  shard: DocumentIndexV1,
  recipe: IndexRecipeProvisional,
  mode: MatchMode,
): Promise<Resolver> {
  if ((await hashIndexRecipe(recipe)) !== shard.recipe) {
    throw new RangeError('resolver recipe does not match the shard recipe identity');
  }
  const locale = shard.segmenter.locale;
  const map = new Map<string, LocalTypeId[]>();
  for (let id = 0; id < shard.vocabulary.length; id++) {
    const folded = foldKey(shard.vocabulary[id] as string, mode, locale);
    const list = map.get(folded);
    if (list) list.push(id as LocalTypeId);
    else map.set(folded, [id as LocalTypeId]);
  }
  return { resolver: FOLD_RESOLVER, mode, locale, recipe, map, shard };
}

/** Normalize a raw query surface exactly as the index normalized its keys. */
function queryKey(resolver: Resolver, surface: string): string {
  return foldKey(tokenKey(surface, resolver.recipe), resolver.mode, resolver.locale);
}

/** Resolve one raw surface to the matching local type ids. */
export function resolveToken(resolver: Resolver, surface: string): readonly LocalTypeId[] {
  return resolver.map.get(queryKey(resolver, surface)) ?? [];
}

/** Prefix/suffix resolution: linear scan over folded vocabulary keys (no trie in v1). */
export function resolveAffix(
  resolver: Resolver,
  kind: 'prefix' | 'suffix',
  stem: string,
): readonly LocalTypeId[] {
  const foldedStem = queryKey(resolver, stem);
  const out: LocalTypeId[] = [];
  const { shard, mode, locale } = resolver;
  for (let id = 0; id < shard.vocabulary.length; id++) {
    const folded = foldKey(shard.vocabulary[id] as string, mode, locale);
    const hit = kind === 'prefix' ? folded.startsWith(foldedStem) : folded.endsWith(foldedStem);
    if (hit) out.push(id as LocalTypeId);
  }
  return out;
}
