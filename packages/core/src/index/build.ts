/**
 * Document index shard builder — analysis contract §4.
 *
 * Consumes the unchanged extracted text plus a validated SegmentationBatch and
 * produces the immutable, document-local DocumentIndexV1: interned
 * case-bearing vocabulary, CSR postings via counting sort, length overflow
 * tables, adapter-supplied token classes, and sentence/paragraph bounds with
 * terminal sentinels. Every batch is validated at this boundary before any
 * artifact is constructed (contract §1).
 */

import { V1_CAPS, type IndexRecipeHash, type TextHash } from '../contract/brands.ts';
import { hashText } from '../contract/hash.ts';
import {
  hashIndexRecipe,
  TOKEN_CLASS,
  TOKEN_CLASS_VALUES,
  type IndexRecipeProvisional,
} from '../contract/recipes.ts';
import { resolveLocale, type SegmentationBatch, type SegmenterFingerprint } from '../segment/intl.ts';

export interface DocumentIndexV1 {
  readonly schema: 'texttrends/document-index/1';
  /** Identity of the extracted text this index describes. */
  readonly text: TextHash;
  /** Canonical hash of the fully resolved index recipe. */
  readonly recipe: IndexRecipeHash;
  readonly segmenter: SegmenterFingerprint;

  readonly tokenTypeIds: Uint32Array;
  readonly startsUtf16: Uint32Array;
  readonly lengths8: Uint8Array;
  readonly longTokenPositions: Uint32Array;
  readonly longTokenLengths: Uint32Array;

  readonly tokenClassVersion: 1;
  readonly tokenClasses: Uint8Array;

  readonly vocabulary: readonly string[];

  readonly postings: {
    readonly offsets: Uint32Array;
    readonly positions: Uint32Array;
  };

  readonly sentenceBounds: Uint32Array;
  readonly paragraphBounds: Uint32Array;
}

/** Inputs binding the artifact to its identities; hashes computed by the caller. */
export interface ShardIdentity {
  readonly text: TextHash;
  readonly recipe: IndexRecipeHash;
}

// Curly/modifier apostrophes normalized to U+0027 under the 'normalize' policy.
const APOSTROPHES_RE = /[’ʼ]/g;

/** Per-emitted-token key production — normalization NEVER touches the source text. */
export function tokenKey(raw: string, recipe: IndexRecipeProvisional): string {
  let key = raw.normalize(recipe.unicode.form);
  if (recipe.apostrophes.policy === 'normalize') {
    key = key.replace(APOSTROPHES_RE, "'");
  }
  return key;
}

/**
 * Paragraph starts per `unicode-blank-line-v1`: a paragraph break is two or
 * more consecutive Unicode line breaks (CR, CRLF, LF, NEL U+0085, LS U+2028,
 * PS U+2029) separated only by spaces/tabs.
 */
export function paragraphCharStarts(text: string): number[] {
  const starts: number[] = [0];
  // A blank-line run: line break, then (optional spaces/tabs + line break)+.
  // Line break = CRLF | CR | LF | NEL U+0085 | LS U+2028 | PS U+2029.
  const re = /(?:\r\n|[\n\r\u0085\u2028\u2029])(?:[ \t]*(?:\r\n|[\n\r\u0085\u2028\u2029]))+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const next = m.index + m[0].length;
    if (next < text.length) starts.push(next);
  }
  return starts;
}

/** Map char boundary starts to token positions (first token at/after each start). */
function charStartsToTokenBounds(
  charStarts: ArrayLike<number>,
  boundCount: number,
  tokenStarts: Uint32Array,
  tokenCount: number,
): Uint32Array {
  const bounds: number[] = [];
  let t = 0;
  for (let i = 0; i < boundCount; i++) {
    const c = charStarts[i] as number;
    while (t < tokenCount && (tokenStarts[t] as number) < c) t++;
    // Collapse boundaries whose unit contains no emitted tokens.
    if (bounds.length === 0 || bounds[bounds.length - 1] !== t) bounds.push(t);
  }
  if (bounds.length === 0 || bounds[bounds.length - 1] !== tokenCount) bounds.push(tokenCount);
  return Uint32Array.from(bounds);
}

/** Reject malformed batches before any artifact is constructed (contract §1). */
export function validateBatch(text: string, seg: SegmentationBatch): void {
  const n = seg.startsUtf16.length;
  if (seg.endsUtf16.length !== n || seg.classes.length !== n) {
    throw new RangeError('segmentation arrays must be parallel');
  }
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const s = seg.startsUtf16[i] as number;
    const e = seg.endsUtf16[i] as number;
    if (!(s >= prevEnd && s < e && e <= text.length)) {
      throw new RangeError(`invalid or overlapping span at segment ${i}`);
    }
    if (!TOKEN_CLASS_VALUES.has(seg.classes[i] as number)) {
      throw new RangeError(`unknown token class at segment ${i}`);
    }
    prevEnd = e;
  }
  const sb = seg.sentenceBoundsUtf16;
  if (sb.length < 1) throw new RangeError('sentence bounds must include a terminal sentinel');
  if (text.length === 0) {
    if (sb.length !== 1 || sb[0] !== 0) throw new RangeError('empty text requires bounds [0]');
  } else {
    if (sb[0] !== 0) throw new RangeError('sentence bounds must start at 0');
    for (let i = 1; i < sb.length; i++) {
      if (!((sb[i] as number) > (sb[i - 1] as number))) {
        throw new RangeError('sentence bounds must be strictly increasing');
      }
    }
    if (sb[sb.length - 1] !== text.length) {
      throw new RangeError('sentence bounds must end at text.length');
    }
  }
  // No sentence boundary may bisect a word span — a token belongs to exactly
  // one sentence, and a boundary strictly inside a span would silently merge
  // two source sentences in the token-bound mapping.
  {
    let b = 0;
    for (let i = 0; i < n; i++) {
      const s = seg.startsUtf16[i] as number;
      const e = seg.endsUtf16[i] as number;
      while (b < sb.length && (sb[b] as number) <= s) b++;
      if (b < sb.length && (sb[b] as number) < e) {
        throw new RangeError(`sentence boundary ${sb[b]} bisects token span [${s},${e})`);
      }
    }
  }
}

export function buildDocumentIndex(
  text: string,
  seg: SegmentationBatch,
  recipe: IndexRecipeProvisional,
  identity: ShardIdentity,
): DocumentIndexV1 {
  if (text.length > V1_CAPS.maxDocTextUtf16) {
    throw new RangeError(`document exceeds v1 text cap (${text.length})`);
  }
  validateBatch(text, seg);
  const segCount = seg.startsUtf16.length;

  // Emit tokens (class filter per recipe), interning case-bearing keys.
  const vocabulary: string[] = [];
  const lookup = new Map<string, number>();
  const typeIds: number[] = [];
  const starts: number[] = [];
  const lens: number[] = [];
  const classes: number[] = [];
  const longPositions: number[] = [];
  const longLengths: number[] = [];

  for (let i = 0; i < segCount; i++) {
    const cls = seg.classes[i] as number;
    if (cls === TOKEN_CLASS.numeral && recipe.numerals.policy === 'drop') continue;
    const s = seg.startsUtf16[i] as number;
    const e = seg.endsUtf16[i] as number;
    const key = tokenKey(text.slice(s, e), recipe);
    let id = lookup.get(key);
    if (id === undefined) {
      id = vocabulary.length;
      if (id >= V1_CAPS.maxVocabSize) throw new RangeError('vocabulary exceeds v1 cap');
      vocabulary.push(key);
      lookup.set(key, id);
    }
    const pos = typeIds.length;
    typeIds.push(id);
    starts.push(s);
    classes.push(cls);
    const len = e - s; // SOURCE span length in UTF-16 code units, not key length
    lens.push(len);
    if (len > 254) {
      longPositions.push(pos);
      longLengths.push(len);
    }
  }

  const tokenCount = typeIds.length;
  if (tokenCount > V1_CAPS.maxDocTokens) throw new RangeError('document exceeds v1 token cap');

  const tokenTypeIds = Uint32Array.from(typeIds);
  const startsUtf16 = Uint32Array.from(starts);
  const tokenClasses = Uint8Array.from(classes);
  const lengths8 = Uint8Array.from(lens, (len) => (len > 254 ? 255 : len));

  // CSR postings via counting sort.
  const vocabSize = vocabulary.length;
  const offsets = new Uint32Array(vocabSize + 1);
  for (let i = 0; i < tokenCount; i++) {
    const slot = (tokenTypeIds[i] as number) + 1;
    offsets[slot] = (offsets[slot] as number) + 1;
  }
  for (let v = 0; v < vocabSize; v++) {
    offsets[v + 1] = (offsets[v + 1] as number) + (offsets[v] as number);
  }
  const positions = new Uint32Array(tokenCount);
  const cursor = offsets.slice(0, vocabSize);
  for (let i = 0; i < tokenCount; i++) {
    const v = tokenTypeIds[i] as number;
    positions[cursor[v] as number] = i;
    cursor[v] = (cursor[v] as number) + 1;
  }

  const sentenceBounds = charStartsToTokenBounds(
    seg.sentenceBoundsUtf16,
    seg.sentenceBoundsUtf16.length - 1, // exclude terminal char sentinel
    startsUtf16,
    tokenCount,
  );
  const paraStarts = paragraphCharStarts(text);
  const paragraphBounds = charStartsToTokenBounds(paraStarts, paraStarts.length, startsUtf16, tokenCount);

  return {
    schema: 'texttrends/document-index/1',
    text: identity.text,
    recipe: identity.recipe,
    segmenter: seg.provenance,
    tokenTypeIds,
    startsUtf16,
    lengths8,
    longTokenPositions: Uint32Array.from(longPositions),
    longTokenLengths: Uint32Array.from(longLengths),
    tokenClassVersion: 1,
    tokenClasses,
    vocabulary,
    postings: { offsets, positions },
    sentenceBounds,
    paragraphBounds,
  };
}

/** Postings for one local type id — a view into canonical storage (never transfer). */
export function postingsFor(index: DocumentIndexV1, typeId: number): Uint32Array {
  if (!Number.isInteger(typeId) || typeId < 0 || typeId >= index.vocabulary.length) {
    throw new RangeError(`type id ${typeId} out of range [0, ${index.vocabulary.length})`);
  }
  return index.postings.positions.subarray(
    index.postings.offsets[typeId] as number,
    index.postings.offsets[typeId + 1] as number,
  );
}

/**
 * The PUBLIC shard constructor: computes and binds the artifact identities
 * itself (text hash over well-formed UTF-16; canonical recipe hash), verifies
 * that the supplied batch was produced from THIS text (batch.text carries the
 * segmenter-computed identity), and verifies recipe/provenance agreement.
 * `buildDocumentIndex` is the trusted synchronous path for callers that have
 * already computed and verified identities.
 */
export async function createDocumentIndex(
  text: string,
  seg: SegmentationBatch,
  recipe: IndexRecipeProvisional,
): Promise<DocumentIndexV1> {
  if (recipe.numerals.classifierVersion !== seg.provenance.classifierVersion) {
    throw new RangeError('recipe classifier version disagrees with segmenter provenance');
  }
  if (recipe.locale.mode === 'fixed') {
    // Resolve through the same Intl path the adapter uses, then require the
    // COMPLETE effective locale to match: 'en-US' vs 'en-GB' is a mismatch,
    // while legacy aliases canonicalize correctly ('iw' resolves to 'he').
    const want = resolveLocale(recipe.locale.value);
    if (want !== seg.provenance.locale) {
      throw new RangeError(
        `fixed recipe locale '${recipe.locale.value}' (resolves to '${want}') disagrees with segmenter locale '${seg.provenance.locale}'`,
      );
    }
  }
  const [textHash, recipeHash] = await Promise.all([hashText(text), hashIndexRecipe(recipe)]);
  if (seg.text !== (textHash as TextHash)) {
    throw new RangeError('segmentation batch was produced from a different text');
  }
  return buildDocumentIndex(text, seg, recipe, {
    text: textHash as TextHash,
    recipe: recipeHash,
  });
}
