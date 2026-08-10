import { describe, expect, it } from 'vitest';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { compileAlias } from '../src/project/alias.ts';
import type { MatchMode } from '../src/resolve/fold.ts';

const FOLDED: MatchMode = { case: 'folded', diacritics: 'folded' };

function compiled(raw: string) {
  const result = compileAlias(raw, FOLDED, 'a0');
  expect(result.ok, result.ok ? undefined : result.message).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('compileAlias', () => {
  it('compiles tokens and one-ended wildcard tokens', () => {
    expect(compiled('NYC').member).toEqual({
      id: 'a0', kind: 'token', surface: 'NYC', match: FOLDED,
    });
    expect(compiled('Yo*').member).toEqual({
      id: 'a0', kind: 'prefix', stem: 'Yo', match: FOLDED,
    });
    expect(compiled('*ork').member).toEqual({
      id: 'a0', kind: 'suffix', stem: 'ork', match: FOLDED,
    });
  });

  it('compiles natural multiword aliases and applies a wildcard to the edge element', () => {
    expect(compiled('New York').member).toEqual({
      id: 'a0', kind: 'phrase',
      elements: [
        { kind: 'token', surface: 'New' },
        { kind: 'token', surface: 'York' },
      ],
      match: FOLDED, crossSentence: false,
    });
    expect(compiled('New Yo*').member).toEqual({
      id: 'a0', kind: 'phrase',
      elements: [
        { kind: 'token', surface: 'New' },
        { kind: 'prefix', stem: 'Yo' },
      ],
      match: FOLDED, crossSentence: false,
    });
    expect(compiled('*ork City').member).toEqual({
      id: 'a0', kind: 'phrase',
      elements: [
        { kind: 'suffix', stem: 'ork' },
        { kind: 'token', surface: 'City' },
      ],
      match: FOLDED, crossSentence: false,
    });
  });

  it('uses the index word and token-key policies for punctuation, hyphens, and NFC', () => {
    expect(compiled('Washington, D.C.').units).toEqual(['Washington', 'D.C']);
    expect(compiled('co-operation').units).toEqual(['co', 'operation']);
    expect(compiled('cafe\u0301').units).toEqual(['café']);
    const apostropheRecipe = {
      ...DEFAULT_INDEX_RECIPE,
      apostrophes: { policy: 'normalize' as const },
    };
    const apostrophe = compileAlias('OʼBrien', FOLDED, 'a0', apostropheRecipe);
    expect(apostrophe.ok && apostrophe.units).toEqual(["O'Brien"]);
  });

  it('rejects empty, punctuation-only, and malformed wildcard aliases without throwing', () => {
    for (const raw of ['', '  ', '…', '*', '*wolf*', 'wo*lf', '**']) {
      expect(compileAlias(raw, FOLDED, 'a0').ok, raw).toBe(false);
    }
  });

  it('is deterministic and preserves the selected uniform match mode', () => {
    const exact: MatchMode = { case: 'sensitive', diacritics: 'sensitive' };
    const a = compileAlias('New Yo*', exact, 'a0');
    const b = compileAlias('New Yo*', exact, 'a0');
    expect(a).toEqual(b);
    expect(a.ok && a.member.match).toEqual(exact);
  });

  it('enforces post-normalization unit and phrase-element bounds', () => {
    expect(compileAlias('x'.repeat(257), FOLDED, 'a0')).toMatchObject({
      ok: false, code: 'too-long',
    });
    expect(compileAlias(Array.from({ length: 17 }, () => 'word').join(' '), FOLDED, 'a0')).toMatchObject({
      ok: false, code: 'too-many-words',
    });
    const nfkcRecipe = {
      ...DEFAULT_INDEX_RECIPE,
      unicode: { ...DEFAULT_INDEX_RECIPE.unicode, form: 'NFKC' as const },
    };
    expect(compileAlias('ﬃ'.repeat(200), FOLDED, 'a0', nfkcRecipe)).toMatchObject({
      ok: false, code: 'too-long',
    });
  });

  it('drops numeral units when the index recipe drops numeral tokens', () => {
    const dropNumerals = {
      ...DEFAULT_INDEX_RECIPE,
      numerals: { ...DEFAULT_INDEX_RECIPE.numerals, policy: 'drop' as const },
    };
    const result = compileAlias('chapter 3 wolves', FOLDED, 'a0', dropNumerals);
    expect(result.ok && result.units).toEqual(['chapter', 'wolves']);
    expect(result.ok && result.member).toMatchObject({
      kind: 'phrase',
      elements: [
        { kind: 'token', surface: 'chapter' },
        { kind: 'token', surface: 'wolves' },
      ],
    });
  });
});
