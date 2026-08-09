/**
 * Shared REAL-HASH generation fixtures (slice-2 ruling §A — the narrowly
 * approved G2 support). One memoized set of canonical recipes/hashes and ONE
 * visible-default `GenerationDocSpecV4` builder over the real extraction
 * pipeline. Malformed hashes, cap edges, and boundary violations stay LOCAL
 * to the suites that need them — these fixtures cannot manufacture
 * invalid-by-default production inputs.
 */

import {
  decodeDocumentSource,
  DEFAULT_INDEX_RECIPE,
  defaultExtractionRecipes,
  finalizeExtraction,
  hashExtractionRecipe,
  hashIndexRecipe,
  type ExtractionRecipeProvisional,
} from '@texttrends/core';
import type { GenerationDocSpecV4 } from '../../src/worker/protocol-v4.ts';

export interface CanonicalRecipeHashes {
  readonly recipes: { readonly txt: ExtractionRecipeProvisional; readonly md: ExtractionRecipeProvisional };
  readonly txtRecipeHash: string;
  readonly mdRecipeHash: string;
  readonly indexRecipeHash: string;
}

let memo: Promise<CanonicalRecipeHashes> | null = null;

/** The canonical default recipes and their hashes, computed once per run. */
export function canonicalRecipeHashes(): Promise<CanonicalRecipeHashes> {
  memo ??= (async () => {
    const recipes = await defaultExtractionRecipes();
    const [txtRecipeHash, mdRecipeHash, indexRecipeHash] = await Promise.all([
      hashExtractionRecipe(recipes.txt),
      hashExtractionRecipe(recipes.md),
      hashIndexRecipe(DEFAULT_INDEX_RECIPE),
    ]);
    return { recipes: { txt: recipes.txt, md: recipes.md }, txtRecipeHash, mdRecipeHash, indexRecipeHash };
  })();
  return memo;
}

/** Real extraction over the literal split pipeline (decode + finalize). */
export async function extractLiteral(bytes: Uint8Array, recipe: ExtractionRecipeProvisional) {
  return finalizeExtraction({ kind: 'literal', decoded: await decodeDocumentSource(bytes, recipe) }, recipe);
}

/**
 * The ONE visible-default real-hash doc-spec builder: every hash is computed
 * by the production pipeline for the given text, so the spec is valid by
 * construction. Suites derive malformed variants locally by spreading.
 */
export async function buildDocSpec(
  doc: string,
  text: string,
  opts: {
    format?: 'txt' | 'md';
    availability?: 'bundled' | 'persisted' | 'external';
  } = {},
): Promise<GenerationDocSpecV4> {
  const canon = await canonicalRecipeHashes();
  const format = opts.format ?? 'txt';
  const recipe = format === 'md' ? canon.recipes.md : canon.recipes.txt;
  const bytes = new TextEncoder().encode(text);
  const extracted = await extractLiteral(bytes, recipe);
  return {
    doc,
    language: 'en',
    source: { expectedHash: extracted.artifact.source, byteLength: bytes.length, format, availability: opts.availability ?? 'external' },
    extraction: {
      recipe,
      recipeHash: format === 'md' ? canon.mdRecipeHash : canon.txtRecipeHash,
      expectedText: extracted.artifact.text,
      expectedTextLengthUtf16: extracted.artifact.textLengthUtf16,
    },
  };
}
