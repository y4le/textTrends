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

/** A PLAIN record with EXACTLY `keys` as own enumerable data properties —
 *  an extra field would be serialized into a DISTINCT recipe/override hash
 *  though no code reads it (the "one operation, many identities" hazard the
 *  extraction validator already guards). Shared by every recipe/override
 *  wire validator. */
export function exactRecord(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(v).length !== 0) return false;
  const names = Object.getOwnPropertyNames(v);
  if (names.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return false;
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(v, name)!;
    if (!d.enumerable || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}

/** A DENSE Array of exactly `length` elements carrying no extra own
 *  properties (named or symbol), no holes, and plain enumerable data
 *  descriptors — an identity-bearing tuple whose canonical JSON must not
 *  smuggle a named array property (which structuredClone preserves and the
 *  canonical hasher rejects). */
export function exactArray(v: unknown, length: number): v is readonly unknown[] {
  if (!Array.isArray(v) || v.length !== length) return false;
  if (Object.getOwnPropertySymbols(v).length !== 0) return false;
  const names = Object.getOwnPropertyNames(v);
  // Own names must be exactly the numeric indices [0..length) plus 'length'.
  if (names.length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (!d || !d.enumerable || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Total structural validation of an IndexRecipeProvisional — every field is
 * a CLOSED enum; an unsupported value must be refused, not hashed into a
 * novel identity for behavior the builder never implements. Wire boundaries
 * (and the worker) narrow with this before recomputing the recipe hash.
 */
export function isIndexRecipeProvisional(v: unknown): v is IndexRecipeProvisional {
  if (!exactRecord(v, ['schema', 'unicode', 'locale', 'wordSegmentation', 'sentenceSegmentation', 'paragraphSegmentation', 'apostrophes', 'hyphens', 'numerals'])) return false;
  if (v.schema !== 'texttrends/index-recipe/0-provisional') return false;
  const u = v.unicode, l = v.locale, w = v.wordSegmentation, s = v.sentenceSegmentation,
    p = v.paragraphSegmentation, a = v.apostrophes, h = v.hyphens, n = v.numerals;
  const localeOk =
    (exactRecord(l, ['mode', 'fallback']) && l.mode === 'document-metadata' && typeof l.fallback === 'string') ||
    (exactRecord(l, ['mode', 'value']) && l.mode === 'fixed' && typeof l.value === 'string');
  return (
    exactRecord(u, ['form', 'application']) && (u.form === 'NFC' || u.form === 'NFKC') && u.application === 'per-emitted-token-after-segmentation' &&
    localeOk &&
    exactRecord(w, ['policy', 'emittedClasses']) && w.policy === 'intl-word-v1' && w.emittedClasses === 'word-like-v1' &&
    exactRecord(s, ['policy']) && s.policy === 'intl-sentence-v1' &&
    exactRecord(p, ['policy']) && p.policy === 'unicode-blank-line-v1' &&
    exactRecord(a, ['policy']) && (a.policy === 'keep' || a.policy === 'normalize') &&
    exactRecord(h, ['policy']) && h.policy === 'segmenter-default' &&
    exactRecord(n, ['policy', 'classifierVersion']) && (n.policy === 'keep' || n.policy === 'drop') && n.classifierVersion === 'numeral-re-v1'
  );
}

/** Token classes — closed, versioned ABI (contract §3). 0 is reserved. */
export const TOKEN_CLASS = { lexical: 1, numeral: 2 } as const;
export const TOKEN_CLASS_VALUES: ReadonlySet<number> = new Set(Object.values(TOKEN_CLASS));
export type TokenClassVersion = 1;
