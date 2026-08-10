/**
 * Deterministic natural-text alias compilation. Authored aliases remain raw
 * notebook state; this module derives the exact occurrence member that every
 * query operation consumes.
 */

import { DEFAULT_INDEX_RECIPE, type IndexRecipeProvisional } from '../contract/recipes.ts';
import { tokenKey } from '../index/build.ts';
import { TERM_GROUP_LIMITS_V1, type GroupMember, type PhraseElement } from '../ops/occurrences.ts';
import type { MatchMode } from '../resolve/fold.ts';
import { isNumeralSegment } from '../segment/intl.ts';

export const ALIAS_COMPILER_V1 = {
  id: 'texttrends/alias-compiler/1',
  segmentation: 'intl-word-v1',
  locale: 'index-recipe-fixed-or-document-fallback',
  wildcard: 'one-asterisk-at-one-end-of-alias',
} as const;

export type AliasCompileErrorCode =
  | 'empty'
  | 'too-long'
  | 'wildcard'
  | 'no-word-units'
  | 'too-many-words';

export type AliasCompileResult =
  | {
      readonly ok: true;
      readonly alias: string;
      readonly units: readonly string[];
      readonly wildcard: 'none' | 'prefix' | 'suffix';
      readonly member: GroupMember;
    }
  | {
      readonly ok: false;
      readonly code: AliasCompileErrorCode;
      readonly message: string;
    };

function recipeLocale(recipe: IndexRecipeProvisional): string {
  return recipe.locale.mode === 'fixed' ? recipe.locale.value : recipe.locale.fallback;
}

const segmenters = new Map<string, Intl.Segmenter>();

function wordSegmenter(locale: string): Intl.Segmenter {
  const cached = segmenters.get(locale);
  if (cached) return cached;
  const created = new Intl.Segmenter(locale, { granularity: 'word' });
  segmenters.set(locale, created);
  return created;
}

/**
 * Compile one authored alias. A single leading or trailing asterisk applies to
 * the first or last word element respectively, so `New Yo*` is an adjacent
 * two-token phrase ending in a prefix match.
 */
export function compileAlias(
  raw: string,
  match: MatchMode,
  memberId: string,
  recipe: IndexRecipeProvisional = DEFAULT_INDEX_RECIPE,
): AliasCompileResult {
  const alias = raw.trim().normalize('NFC');
  if (alias === '') {
    return { ok: false, code: 'empty', message: 'type at least one letter or number' };
  }
  const leading = alias.startsWith('*');
  const trailing = alias.endsWith('*');
  if (alias === '*' || (leading && trailing)) {
    return {
      ok: false,
      code: 'wildcard',
      message: 'use one * at the start or end, like New Yo*',
    };
  }
  const body = (leading ? alias.slice(1) : trailing ? alias.slice(0, -1) : alias).trim();
  if (body.includes('*')) {
    return {
      ok: false,
      code: 'wildcard',
      message: 'use one * at the start or end, like New Yo*',
    };
  }
  if (body.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits) {
    return {
      ok: false,
      code: 'too-long',
      message: `an alias is at most ${TERM_GROUP_LIMITS_V1.maxSurfaceUnits} characters`,
    };
  }

  const segments = wordSegmenter(recipeLocale(recipe));
  const units: string[] = [];
  for (const segment of segments.segment(body)) {
    if (!segment.isWordLike) continue;
    if (recipe.numerals.policy === 'drop' && isNumeralSegment(segment.segment)) continue;
    units.push(tokenKey(segment.segment, recipe));
  }
  if (units.length === 0) {
    return { ok: false, code: 'no-word-units', message: 'type at least one letter or number' };
  }
  if (units.length > TERM_GROUP_LIMITS_V1.maxPhraseElements) {
    return {
      ok: false,
      code: 'too-many-words',
      message: `an alias is at most ${TERM_GROUP_LIMITS_V1.maxPhraseElements} words`,
    };
  }
  if (units.some((unit) => unit.length > TERM_GROUP_LIMITS_V1.maxSurfaceUnits)) {
    return {
      ok: false,
      code: 'too-long',
      message: `an alias unit is at most ${TERM_GROUP_LIMITS_V1.maxSurfaceUnits} characters after normalization`,
    };
  }

  const wildcard = leading ? 'suffix' : trailing ? 'prefix' : 'none';
  if (units.length === 1) {
    const unit = units[0]!;
    const member: GroupMember = wildcard === 'none'
      ? { id: memberId, kind: 'token', surface: unit, match }
      : { id: memberId, kind: wildcard, stem: unit, match };
    return { ok: true, alias, units, wildcard, member };
  }

  const elements: PhraseElement[] = units.map((surface) => ({ kind: 'token', surface }));
  if (wildcard === 'prefix') {
    elements[elements.length - 1] = { kind: 'prefix', stem: units.at(-1)! };
  } else if (wildcard === 'suffix') {
    elements[0] = { kind: 'suffix', stem: units[0]! };
  }
  return {
    ok: true,
    alias,
    units,
    wildcard,
    member: { id: memberId, kind: 'phrase', elements, match, crossSentence: false },
  };
}

export function compileAliasOrThrow(
  raw: string,
  match: MatchMode,
  memberId: string,
  recipe: IndexRecipeProvisional = DEFAULT_INDEX_RECIPE,
): GroupMember {
  const result = compileAlias(raw, match, memberId, recipe);
  if (!result.ok) throw new RangeError(result.message);
  return result.member;
}
