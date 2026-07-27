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

import { CapError, V1_CAPS, type IndexRecipeHash, type TextHash } from '../contract/brands.ts';
import { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from '../contract/verified-text.ts';
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
    throw new CapError(`document exceeds v1 text cap (${text.length})`);
  }
  validateBatch(text, seg);
  const segCount = seg.startsUtf16.length;

  // Emit tokens (class filter per recipe), interning case-bearing keys. The
  // dense token arrays are preallocated at segCount — an upper bound, since
  // filtered segments emit nothing — and filled through a tokenCount cursor.
  // The sparse overflow tables stay ordinary arrays: they are usually empty.
  const vocabulary: string[] = [];
  const lookup = new Map<string, number>();
  let tokenTypeIds = new Uint32Array(segCount);
  let startsUtf16 = new Uint32Array(segCount);
  let lengths8 = new Uint8Array(segCount);
  let tokenClasses = new Uint8Array(segCount);
  const longPositions: number[] = [];
  const longLengths: number[] = [];

  let tokenCount = 0;
  for (let i = 0; i < segCount; i++) {
    const cls = seg.classes[i] as number;
    if (cls === TOKEN_CLASS.numeral && recipe.numerals.policy === 'drop') continue;
    const s = seg.startsUtf16[i] as number;
    const e = seg.endsUtf16[i] as number;
    const key = tokenKey(text.slice(s, e), recipe);
    let id = lookup.get(key);
    if (id === undefined) {
      id = vocabulary.length;
      if (id >= V1_CAPS.maxVocabSize) throw new CapError('vocabulary exceeds v1 cap');
      vocabulary.push(key);
      lookup.set(key, id);
    }
    const pos = tokenCount;
    tokenTypeIds[pos] = id;
    startsUtf16[pos] = s;
    tokenClasses[pos] = cls;
    const len = e - s; // SOURCE span length in UTF-16 code units, not key length
    lengths8[pos] = len > 254 ? 255 : len;
    if (len > 254) {
      longPositions.push(pos);
      longLengths.push(len);
    }
    tokenCount++;
  }

  if (tokenCount > V1_CAPS.maxDocTokens) throw new CapError('document exceeds v1 token cap');

  if (tokenCount !== segCount) {
    // Exact-size copies via slice, never subarray — a subarray view would
    // retain (and possibly transfer) the oversized segCount backing buffer.
    tokenTypeIds = tokenTypeIds.slice(0, tokenCount);
    startsUtf16 = startsUtf16.slice(0, tokenCount);
    lengths8 = lengths8.slice(0, tokenCount);
    tokenClasses = tokenClasses.slice(0, tokenCount);
  }

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

/**
 * Full structural validation of a document-index shard against the v1 ABI —
 * required whenever arrays arrive from outside this builder (loaded from
 * storage, copied at a residency boundary): descriptor identity is NOT
 * integrity. Checks constructors, parallel lengths, strictly increasing
 * starts, overflow-table agreement, token classes, postings CSR permutation
 * agreement with tokenTypeIds, and bounds sentinels.
 */
export function validateShardStructure(shard: DocumentIndexV1): void {
  if (shard.schema !== 'texttrends/document-index/1') {
    throw new RangeError(`unknown shard schema '${shard.schema}'`);
  }
  if (shard.tokenClassVersion !== 1) {
    throw new RangeError(`unknown token class version ${shard.tokenClassVersion}`);
  }
  const u32 = (v: unknown, name: string): Uint32Array => {
    if (!(v instanceof Uint32Array)) throw new RangeError(`${name} must be a Uint32Array`);
    return v;
  };
  const u8 = (v: unknown, name: string): Uint8Array => {
    if (!(v instanceof Uint8Array)) throw new RangeError(`${name} must be a Uint8Array`);
    return v;
  };
  const tokens = u32(shard.tokenTypeIds, 'tokenTypeIds');
  const starts = u32(shard.startsUtf16, 'startsUtf16');
  const lengths = u8(shard.lengths8, 'lengths8');
  const classes = u8(shard.tokenClasses, 'tokenClasses');
  const longPos = u32(shard.longTokenPositions, 'longTokenPositions');
  const longLen = u32(shard.longTokenLengths, 'longTokenLengths');
  const offsets = u32(shard.postings.offsets, 'postings.offsets');
  const positions = u32(shard.postings.positions, 'postings.positions');
  const sentenceBounds = u32(shard.sentenceBounds, 'sentenceBounds');
  const paragraphBounds = u32(shard.paragraphBounds, 'paragraphBounds');
  if (!Array.isArray(shard.vocabulary) || shard.vocabulary.some((k) => typeof k !== 'string')) {
    throw new RangeError('vocabulary must be an array of strings');
  }

  const n = tokens.length;
  const vocabSize = shard.vocabulary.length;
  if (n > V1_CAPS.maxDocTokens || vocabSize > V1_CAPS.maxVocabSize) {
    throw new CapError('shard exceeds v1 caps');
  }
  if (starts.length !== n || lengths.length !== n || classes.length !== n) {
    throw new RangeError('token arrays must be parallel');
  }
  if (longPos.length !== longLen.length) {
    throw new RangeError('overflow tables must be parallel');
  }

  if (new Set(shard.vocabulary).size !== vocabSize) {
    throw new RangeError('vocabulary keys must be unique');
  }

  let overflowCursor = 0;
  let prevEnd = 0; // end char of the previous token — spans must not overlap
  for (let i = 0; i < n; i++) {
    const start = starts[i] as number;
    if ((tokens[i] as number) >= vocabSize) {
      throw new RangeError(`tokenTypeIds[${i}] out of vocabulary range`);
    }
    if (!TOKEN_CLASS_VALUES.has(classes[i] as number)) {
      throw new RangeError(`unknown token class at ${i}`);
    }
    // Resolve the ACTUAL length (overflow-aware) so span geometry is checked
    // with real extents — strictly-increasing starts alone admit overlapping
    // and zero-length spans (review round 5).
    const len8 = lengths[i] as number;
    let len = len8;
    if (len8 === 255) {
      if (overflowCursor >= longPos.length || (longPos[overflowCursor] as number) !== i) {
        throw new RangeError(`missing overflow entry for token ${i}`);
      }
      len = longLen[overflowCursor] as number;
      if (len <= 254) {
        throw new RangeError(`overflow length for token ${i} must exceed 254`);
      }
      overflowCursor++;
    }
    if (len === 0) throw new RangeError(`zero-length token span at ${i}`);
    if (start < prevEnd) {
      throw new RangeError(`token span at ${i} overlaps its predecessor`);
    }
    const end = start + len;
    // Deliberately a plain RangeError, not CapError: a span leaving the v1
    // address domain is corrupt artifact GEOMETRY, not a capacity request.
    if (end > V1_CAPS.maxDocTextUtf16) {
      throw new RangeError(`token span at ${i} leaves the v1 UTF-16 address domain`);
    }
    prevEnd = end;
  }
  if (overflowCursor !== longPos.length) {
    throw new RangeError('overflow table lists tokens without 255 sentinels');
  }

  // Postings CSR: offsets frame a permutation of [0, n) whose entries agree
  // with tokenTypeIds, each run sorted strictly increasing.
  if (offsets.length !== vocabSize + 1 || (offsets[0] as number) !== 0) {
    throw new RangeError('postings offsets must have vocab+1 entries starting at 0');
  }
  if ((offsets[vocabSize] as number) !== n || positions.length !== n) {
    throw new RangeError('postings must cover exactly the token count');
  }
  for (let t = 0; t < vocabSize; t++) {
    const from = offsets[t] as number;
    const to = offsets[t + 1] as number;
    if (to < from) throw new RangeError(`postings offsets decrease at type ${t}`);
    for (let i = from; i < to; i++) {
      const p = positions[i] as number;
      if (p >= n) throw new RangeError(`posting position ${p} out of range`);
      if ((tokens[p] as number) !== t) {
        throw new RangeError(`posting for type ${t} points at a different token type`);
      }
      if (i > from && p <= (positions[i - 1] as number)) {
        throw new RangeError(`postings for type ${t} must be strictly increasing`);
      }
    }
  }

  const checkBounds = (bounds: Uint32Array, name: string): void => {
    if (bounds.length < 1) throw new RangeError(`${name} must include a terminal sentinel`);
    if ((bounds[0] as number) !== 0 && !(n === 0 && bounds.length === 1)) {
      if (n === 0) throw new RangeError(`${name} for an empty shard must be [0]`);
      throw new RangeError(`${name} must start at 0`);
    }
    for (let i = 1; i < bounds.length; i++) {
      if ((bounds[i] as number) <= (bounds[i - 1] as number)) {
        throw new RangeError(`${name} must be strictly increasing`);
      }
    }
    if ((bounds[bounds.length - 1] as number) !== n) {
      throw new RangeError(`${name} must end at the token count`);
    }
  };
  checkBounds(sentenceBounds, 'sentenceBounds');
  checkBounds(paragraphBounds, 'paragraphBounds');
}

/** Char length of the token at pos, honoring the 255-overflow table. */
export function tokenCharLength(index: DocumentIndexV1, pos: number): number {
  if (!Number.isInteger(pos) || pos < 0 || pos >= index.tokenTypeIds.length) {
    throw new RangeError(`token position ${pos} out of range [0, ${index.tokenTypeIds.length})`);
  }
  const len8 = index.lengths8[pos] as number;
  if (len8 !== 255) return len8;
  // Overflow positions are sorted; binary search.
  const arr = index.longTokenPositions;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid] as number;
    if (v === pos) return index.longTokenLengths[mid] as number;
    if (v < pos) lo = mid + 1;
    else hi = mid - 1;
  }
  throw new RangeError(`overflow length missing for token ${pos}`);
}

/** End char offset (exclusive) of the token at pos in the extracted text. */
export function tokenEndChar(index: DocumentIndexV1, pos: number): number {
  return (index.startsUtf16[pos] as number) + tokenCharLength(index, pos);
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
  // The safe self-verifying entry: hash once (rejecting ill-formed UTF-16),
  // then delegate to the verified fast lane.
  return createDocumentIndexVerified(await verifyText(text), seg, recipe);
}

/**
 * The verified fast lane of `createDocumentIndex`: the text identity comes
 * from the capability (no re-digest), and the batch must still have been
 * produced from THAT text — a mismatched intermediate rejects. Every non-hash
 * invariant (classifier/locale agreement, full batch validation in
 * `buildDocumentIndex`) is unchanged.
 */
export async function createDocumentIndexVerified(
  verified: VerifiedText,
  seg: SegmentationBatch,
  recipe: IndexRecipeProvisional,
): Promise<DocumentIndexV1> {
  const text = verifiedTextOf(verified); // authenticates; throws on forgeries
  const textHash = verifiedHashOf(verified);
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
  if (seg.text !== textHash) {
    throw new RangeError('segmentation batch was produced from a different text');
  }
  const recipeHash = await hashIndexRecipe(recipe);
  return buildDocumentIndex(text, seg, recipe, {
    text: textHash,
    recipe: recipeHash,
  });
}
