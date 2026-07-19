/**
 * Recipe types — analysis contract §3. Each recipe owns one invalidation
 * domain; hashes of these canonical forms key derived artifacts.
 *
 * IMPORTANT: this is a PROVISIONAL subset of the contracted IndexRecipeV1 —
 * the schema name says so. It omits the apostrophe/hyphen table hashes and
 * fuller policy tables the contract requires of the final v1; publishing this
 * subset under the canonical v1 name would silently change the hash domain of
 * v1 artifacts later (review finding). It graduates to
 * 'texttrends/index-recipe/1' only when those fields land.
 */

import { canonicalJson, sha256Hex } from './hash.ts';
import type { IndexRecipeHash } from './brands.ts';

export interface IndexRecipeProvisional {
  readonly schema: 'texttrends/index-recipe/0-provisional';
  readonly unicode: {
    readonly form: 'NFC' | 'NFKC';
    readonly application: 'per-emitted-token-after-segmentation';
  };
  readonly locale:
    | { readonly mode: 'document-metadata'; readonly fallback: string }
    | { readonly mode: 'fixed'; readonly value: string };
  readonly wordSegmentation: {
    readonly policy: 'intl-word-v1';
    readonly emittedClasses: 'word-like-v1';
  };
  readonly sentenceSegmentation: { readonly policy: 'intl-sentence-v1' };
  /**
   * 'unicode-blank-line-v1': paragraphs split at a blank line — two or more
   * consecutive Unicode line breaks (CR, CRLF, LF, NEL, LS, PS) with only
   * spaces/tabs between them.
   */
  readonly paragraphSegmentation: { readonly policy: 'unicode-blank-line-v1' };
  readonly apostrophes: { readonly policy: 'keep' | 'normalize' };
  /**
   * 'segmenter-default': no post-processing — Intl.Segmenter already splits
   * hyphenated compounds into their parts, and v1 does not reassemble them.
   * (Named honestly per review: a 'keep' policy would promise compound-token
   * preservation this pipeline does not perform.)
   */
  readonly hyphens: { readonly policy: 'segmenter-default' };
  readonly numerals: {
    readonly policy: 'keep' | 'drop';
    /** Classifier lives in the segmentation adapter; its version is recipe identity. */
    readonly classifierVersion: 'numeral-re-v1';
  };
}

export const DEFAULT_INDEX_RECIPE: IndexRecipeProvisional = {
  schema: 'texttrends/index-recipe/0-provisional',
  unicode: { form: 'NFC', application: 'per-emitted-token-after-segmentation' },
  locale: { mode: 'document-metadata', fallback: 'en' },
  wordSegmentation: { policy: 'intl-word-v1', emittedClasses: 'word-like-v1' },
  sentenceSegmentation: { policy: 'intl-sentence-v1' },
  paragraphSegmentation: { policy: 'unicode-blank-line-v1' },
  apostrophes: { policy: 'normalize' },
  hyphens: { policy: 'segmenter-default' },
  numerals: { policy: 'keep', classifierVersion: 'numeral-re-v1' },
};

export async function hashIndexRecipe(recipe: IndexRecipeProvisional): Promise<IndexRecipeHash> {
  return (await sha256Hex(canonicalJson(recipe))) as IndexRecipeHash;
}

/** Token classes — closed, versioned ABI (contract §3). 0 is reserved. */
export const TOKEN_CLASS = { lexical: 1, numeral: 2 } as const;
export const TOKEN_CLASS_VALUES: ReadonlySet<number> = new Set(Object.values(TOKEN_CLASS));
export type TokenClassVersion = 1;
