/**
 * Extraction — contract §12.1/§12.4. Bytes → extracted text + structure
 * candidates + evidence, under a versioned provisional recipe whose hash
 * keys the extraction artifact: ['extraction', schema, SourceHash,
 * ExtractionRecipeHash]. Deliberately platform-neutral (TextDecoder + Web
 * Crypto only), like the rest of core.
 *
 * PROVISIONAL discipline mirrors the index recipe: this schema graduates to
 * 'texttrends/extraction-recipe/1' only via an amendment; artifacts keyed by
 * provisional hashes are disposable and never aliased to canonical names.
 */

import { canonicalJson, hashSourceBytes, sha256Hex } from '../contract/hash.ts';
import { verifiedHashOf, verifyText, type VerifiedText } from '../contract/verified-text.ts';
import { exactRecord, isNonNegSafeInt as isNonNegInt } from '../contract/guards.ts';
import {
  DETECTED_ENCODINGS,
  DecodeError,
  assertWellFormed,
  decodeSource,
  windows1252TableHash,
  type DecodedSource,
  type DetectedEncoding,
} from './decode.ts';
import {
  assertValidCandidates,
  hashStructureCandidates,
  type StructureCandidateV1,
} from './candidates.ts';
import { scanMarkdownHeadings } from './markdown.ts';
// The format catalog (formats.ts) is the single authority for SourceFormat, the
// kind↔format pairing, and candidate-reconstruction semantics; SourceFormat and
// CandidateReconstruction are re-exported here so existing importers of the
// extraction module keep working.
import { isLiteralFormat, isSourceFormat, SOURCE_FORMATS, type CandidateReconstruction, type SourceFormat } from './formats.ts';
export type { CandidateReconstruction, SourceFormat };

/** Which reading-order partitions an EPUB extraction includes in its text. */
export type EbookPartition = 'frontmatter' | 'bodymatter' | 'backmatter' | 'unknown';

interface DecoderPolicyV0 {
  readonly id: 'bom-utf8-windows1252-v1';
  readonly bom: 'utf8-utf16le-utf16be-v1';
  readonly unicodeErrors: 'fatal';
  readonly fallback: 'windows-1252-whatwg-v1';
  readonly windows1252TableHash: string;
  readonly newlineNormalization: 'none';
}

/**
 * The EPUB extractor policy — every knob that can change the extracted bytes is
 * in the recipe IDENTITY, so an algorithm change that alters output can only run
 * under a NEW recipe hash (a warm re-extract that no longer reproduces the
 * manifest's TextHash is an EXTRACTION_MISMATCH, never a silent rewrite). `id`
 * versions the extractor, `serializer` the DOM→text walk, `sectioning` the
 * spine→candidate mapping; `partitions` selects the included reading order.
 */
export interface EpubExtractorPolicyV0 {
  readonly id: 'standard-ebooks-epub-v1';
  readonly partitions: readonly EbookPartition[];
  readonly serializer: 'xhtml-block-collapse-v1';
  readonly sectioning: 'spine-order-v1';
}

/**
 * The HTML extractor policy. `decoder` pins how the source bytes become an HTML
 * string (BOM → strict UTF-8 → total windows-1252 — the shared literal decoder,
 * NOT a `<meta charset>` sniff, which is a documented future refinement);
 * `parser` pins the HTML5 tree builder; `serializer` the DOM→text walk;
 * `sectioning` the heading→candidate mapping. All in the recipe identity so an
 * output-changing upgrade forces a new hash.
 */
export interface HtmlExtractorPolicyV0 {
  readonly id: 'html5-inert-v1';
  readonly decoder: DecoderPolicyV0;
  readonly parser: 'parse5-v7';
  readonly serializer: 'html-block-collapse-v1';
  readonly sectioning: 'heading-order-v1';
}

/**
 * FORMAT-DISCRIMINATED (review finding): a well-typed recipe cannot pair a
 * format with a foreign parser — the recipe must describe exactly the operation
 * the extractor performs. Literal formats carry a byte `decoder`; a container
 * format (`epub`) carries an `extractor` policy instead, and its candidates are
 * `source`-reconstructed (the container, not the text, holds the structure).
 */
export type ExtractionRecipeProvisional =
  | {
      readonly schema: 'texttrends/extraction-recipe/0-provisional';
      readonly format: 'txt';
      readonly decoder: DecoderPolicyV0;
      readonly parser: { readonly id: 'txt-literal-v1' };
      readonly candidateReconstruction: 'text';
    }
  | {
      readonly schema: 'texttrends/extraction-recipe/0-provisional';
      readonly format: 'md';
      readonly decoder: DecoderPolicyV0;
      /** The honestly-named literal mode — the indexed text IS the raw
       *  markdown; headings become structure candidates (spike decision). */
      readonly parser: {
        readonly id: 'markdown-literal-with-heading-scan-v0';
        readonly textPolicy: 'preserve-source-markdown';
        readonly headingScanner: 'markdown-heading-scan-v1';
      };
      readonly candidateReconstruction: 'text';
    }
  | {
      readonly schema: 'texttrends/extraction-recipe/0-provisional';
      readonly format: 'epub';
      readonly extractor: EpubExtractorPolicyV0;
      readonly candidateReconstruction: 'source';
    }
  | {
      readonly schema: 'texttrends/extraction-recipe/0-provisional';
      readonly format: 'html';
      readonly extractor: HtmlExtractorPolicyV0;
      readonly candidateReconstruction: 'source';
    };

/** IDENTITY-TIER record guard: PLAIN records only — a class instance or
 *  custom prototype could satisfy value checks while carrying behavior
 *  (getters, prototype state) outside the canonical-JSON domain the hash
 *  boundary operates on; symbol-keyed properties are invisible to key checks
 *  (round-4 review). Deliberately STRICTER than the shared plain-shape
 *  `isRecord` in contract/guards.ts and named differently so the two tiers
 *  can never be confused. */
const isStrictPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.getOwnPropertySymbols(v).length === 0;
};

/** Exact-key guard: an extra field would be HASHED into the recipe identity
 *  while changing no behavior — two identities for one operation, the exact
 *  drift this boundary exists to prevent. Own PROPERTY NAMES are compared
 *  (catching non-enumerable extras), and every property must be a plain
 *  enumerable data property (a getter could answer differently per read). */
function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], what: string): void {
  const present = Object.getOwnPropertyNames(record);
  if (present.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(record, k))) {
    throw new RangeError(`${what} must have exactly the keys [${keys.join(', ')}]; got [${present.join(', ')}]`);
  }
  for (const key of present) {
    const desc = Object.getOwnPropertyDescriptor(record, key)!;
    if (!desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
      throw new RangeError(`${what} property '${key}' must be a plain enumerable data property`);
    }
  }
}

/** Reading order — the ONE canonical order + de-dup for a partition SELECTION,
 *  so `['bodymatter','frontmatter']`, its reverse, and duplicates all describe
 *  the same operation under a single recipe identity (the extractor treats
 *  partitions as a set; spine order alone determines output). */
const PARTITION_ORDER: readonly EbookPartition[] = ['frontmatter', 'bodymatter', 'backmatter', 'unknown'];
const EBOOK_PARTITIONS: ReadonlySet<string> = new Set<EbookPartition>(PARTITION_ORDER);

const canonicalPartitions = (ps: readonly EbookPartition[]): EbookPartition[] =>
  PARTITION_ORDER.filter((p) => ps.includes(p));

/** A partitions array is canonical iff it equals its de-duped reading-order
 *  projection (unique, in canonical order, non-empty). */
function isCanonicalPartitions(ps: readonly unknown[]): boolean {
  if (ps.length === 0 || !ps.every((x) => EBOOK_PARTITIONS.has(x as string))) return false;
  const canon = canonicalPartitions(ps as EbookPartition[]);
  return ps.length === canon.length && ps.every((p, i) => p === canon[i]);
}

/** Deep-freeze an OWNED canonical recipe graph (plain records + dense arrays
 *  of primitives, acyclic by construction — every node was minted by the
 *  snapshotter, so freezing cannot leak to caller-visible objects). */
function deepFreezeOwned(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreezeOwned((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

/**
 * SYNCHRONOUS field-by-field snapshot of an untrusted recipe into an OWNED,
 * deeply-frozen canonical object — a schema-specific normalizer, deliberately
 * NOT a generic clone, so every hostile shape has a reviewable answer:
 * prototypes/symbols (isStrictPlainRecord rejects), accessors and
 * non-enumerable extras (requireExactKeys rejects), unknown fields (the exact
 * key sets reject — an extra field would hash a SECOND identity for the same
 * behavior), cycles (nothing is walked generically; only the closed set of
 * expected fields is read, each exactly once), and known fields are re-stated
 * as literals or copied primitives, never aliased from the input graph.
 *
 * Performs the COMPLETE structural + literal-value validation. The one
 * ASYNC semantic proof (the embedded windows-1252 table hash) is the caller's
 * job — it runs against the frozen snapshot, immune to input mutation.
 * Every malformed input throws RangeError (REQUEST_INVALID), never TypeError.
 */
function snapshotExtractionRecipe(recipe: unknown): ExtractionRecipeProvisional {
  if (!isStrictPlainRecord(recipe)) throw new RangeError('extraction recipe must be an object');
  if (recipe.schema !== 'texttrends/extraction-recipe/0-provisional') {
    throw new RangeError(`unknown extraction recipe schema '${String(recipe.schema)}'`);
  }
  if (!isSourceFormat(recipe.format)) {
    throw new RangeError(`unknown source format '${String(recipe.format)}'`);
  }
  // The redundant-but-hashed discriminant must match the CATALOG's fact for the
  // format — stated once here, never per format arm.
  if (recipe.candidateReconstruction !== SOURCE_FORMATS[recipe.format].candidateReconstruction) {
    throw new RangeError(
      `format '${recipe.format}' must declare candidateReconstruction '${SOURCE_FORMATS[recipe.format].candidateReconstruction}'`,
    );
  }
  // Container and literal formats carry DIFFERENT key sets — the exact-key
  // guard is applied per format so an extra field can never be hashed into a
  // second identity for the same behavior.
  let owned: ExtractionRecipeProvisional;
  if (recipe.format === 'txt' || recipe.format === 'md') {
    requireExactKeys(recipe, ['schema', 'format', 'decoder', 'parser', 'candidateReconstruction'], 'extraction recipe');
    const decoder = snapshotDecoderPolicy(recipe.decoder);
    const p = recipe.parser;
    if (!isStrictPlainRecord(p)) throw new RangeError('parser must be an object');
    if (recipe.format === 'txt') {
      requireExactKeys(p, ['id'], 'txt parser');
      if (p.id !== 'txt-literal-v1') throw new RangeError('format/parser combination is not a supported extraction');
      owned = {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'txt',
        decoder,
        parser: { id: 'txt-literal-v1' },
        candidateReconstruction: 'text',
      };
    } else {
      requireExactKeys(p, ['id', 'textPolicy', 'headingScanner'], 'md parser');
      if (
        p.id !== 'markdown-literal-with-heading-scan-v0' ||
        p.textPolicy !== 'preserve-source-markdown' ||
        p.headingScanner !== 'markdown-heading-scan-v1'
      ) {
        throw new RangeError('format/parser combination is not a supported extraction');
      }
      owned = {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'md',
        decoder,
        parser: {
          id: 'markdown-literal-with-heading-scan-v0',
          textPolicy: 'preserve-source-markdown',
          headingScanner: 'markdown-heading-scan-v1',
        },
        candidateReconstruction: 'text',
      };
    }
  } else if (recipe.format === 'epub') {
    requireExactKeys(recipe, ['schema', 'format', 'extractor', 'candidateReconstruction'], 'extraction recipe');
    const e = recipe.extractor;
    if (!isStrictPlainRecord(e)) throw new RangeError('extractor policy must be an object');
    requireExactKeys(e, ['id', 'partitions', 'serializer', 'sectioning'], 'epub extractor');
    if (e.id !== 'standard-ebooks-epub-v1' || e.serializer !== 'xhtml-block-collapse-v1' || e.sectioning !== 'spine-order-v1') {
      throw new RangeError('unsupported epub extractor policy');
    }
    if (!Array.isArray(e.partitions)) {
      throw new RangeError('epub extractor partitions must be unique and in canonical reading order');
    }
    // Copy the elements ONCE into an owned dense array under canonical-JSON
    // array discipline (no named/accessor/hole slots), then validate the COPY —
    // an exotic slot must not answer one value to validation and another to
    // hashing, and the snapshot must never alias the caller's array.
    const partitions = snapshotDenseElements(e.partitions, 'epub extractor partitions');
    if (!isCanonicalPartitions(partitions)) {
      throw new RangeError('epub extractor partitions must be unique and in canonical reading order');
    }
    owned = {
      schema: 'texttrends/extraction-recipe/0-provisional',
      format: 'epub',
      extractor: {
        id: 'standard-ebooks-epub-v1',
        partitions: partitions as EbookPartition[],
        serializer: 'xhtml-block-collapse-v1',
        sectioning: 'spine-order-v1',
      },
      candidateReconstruction: 'source',
    };
  } else {
    // recipe.format === 'html' — the closed catalog admits nothing else.
    requireExactKeys(recipe, ['schema', 'format', 'extractor', 'candidateReconstruction'], 'extraction recipe');
    const e = recipe.extractor;
    if (!isStrictPlainRecord(e)) throw new RangeError('extractor policy must be an object');
    requireExactKeys(e, ['id', 'decoder', 'parser', 'serializer', 'sectioning'], 'html extractor');
    if (
      e.id !== 'html5-inert-v1' || e.parser !== 'parse5-v7' ||
      e.serializer !== 'html-block-collapse-v1' || e.sectioning !== 'heading-order-v1'
    ) {
      throw new RangeError('unsupported html extractor policy');
    }
    owned = {
      schema: 'texttrends/extraction-recipe/0-provisional',
      format: 'html',
      extractor: {
        id: 'html5-inert-v1',
        decoder: snapshotDecoderPolicy(e.decoder),
        parser: 'parse5-v7',
        serializer: 'html-block-collapse-v1',
        sectioning: 'heading-order-v1',
      },
      candidateReconstruction: 'source',
    };
  }
  deepFreezeOwned(owned);
  return owned;
}

/** Snapshot + structurally validate the shared byte-decoder policy of the
 *  byte-decoding (txt/md/html) formats. The embedded table-hash STRING is
 *  copied here; whether it equals the implemented table's digest is the async
 *  proof in validatedExtractionRecipe. */
function snapshotDecoderPolicy(d: unknown): DecoderPolicyV0 {
  if (!isStrictPlainRecord(d)) throw new RangeError('decoder policy must be an object');
  requireExactKeys(
    d,
    ['id', 'bom', 'unicodeErrors', 'fallback', 'windows1252TableHash', 'newlineNormalization'],
    'decoder policy',
  );
  if (
    d.id !== 'bom-utf8-windows1252-v1' || d.bom !== 'utf8-utf16le-utf16be-v1' ||
    d.unicodeErrors !== 'fatal' || d.fallback !== 'windows-1252-whatwg-v1' ||
    d.newlineNormalization !== 'none'
  ) {
    throw new RangeError('unsupported decoder policy');
  }
  if (typeof d.windows1252TableHash !== 'string') {
    // A non-string claim can never equal the implemented table's hex digest —
    // same class + message as the semantic mismatch, decided synchronously.
    throw new RangeError('decoder table hash does not match the implemented windows-1252 table');
  }
  return {
    id: 'bom-utf8-windows1252-v1',
    bom: 'utf8-utf16le-utf16be-v1',
    unicodeErrors: 'fatal',
    fallback: 'windows-1252-whatwg-v1',
    windows1252TableHash: d.windows1252TableHash,
    newlineNormalization: 'none',
  };
}

/** Copy an untrusted array's elements once into an owned dense array under
 *  the same own-slot discipline canonicalJson enforces (index-spelled data
 *  slots only — no named extras, accessors, or holes), so the snapshot can
 *  never admit an array the hash boundary rejects. */
function snapshotDenseElements(a: readonly unknown[], what: string): unknown[] {
  // Symbols are outside canonicalJson's identity domain and must REJECT, not
  // be silently normalized away — a snapshot that dropped them would admit
  // input the raw hash path used to refuse (review-d3-recipes finding).
  if (Object.getOwnPropertySymbols(a).length !== 0) {
    throw new RangeError(`${what} has symbol-keyed properties`);
  }
  for (const k of Object.getOwnPropertyNames(a)) {
    if (k === 'length') continue;
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= a.length || String(idx) !== k) {
      throw new RangeError(`${what} has a non-index array property '${k}'`);
    }
  }
  const out: unknown[] = [];
  for (let i = 0; i < a.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(a, i);
    if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
      throw new RangeError(`${what} element ${i} must be a plain data element`);
    }
    out.push(desc.value);
  }
  return out;
}

/** Successfully validated CANONICAL recipes — module-private. Only objects
 *  MINTED by snapshotExtractionRecipe (owned, deeply frozen) are ever added,
 *  so membership IS proof of validation: no caller-held mutable graph can be
 *  cached and then mutated into a falsely-trusted state. Never keyed by raw
 *  input or by recipe hash — identity of the canonical object only. */
const VALIDATED_RECIPES = new WeakSet<object>();

/**
 * The CANONICALIZING validator (Phase D / D3 ruling). Contract:
 * 1. synchronously snapshot the untrusted input into an owned canonical object
 *    (field-by-field normalizer; unknown fields reject) and deeply FREEZE it —
 *    both BEFORE the first await, so mutating the input after this call begins
 *    cannot reach validation or the returned value;
 * 2. run the async semantic proof (the embedded windows-1252 table hash must
 *    be the digest of the table this build implements — a recipe claiming a
 *    different table would record an identity for behavior that never ran)
 *    against the frozen snapshot;
 * 3. cache the canonical object in the module-private WeakSet on SUCCESS only.
 * Passing a previously-returned canonical object back in is an O(1) identity
 * hit returning the same object. Callers must retain and USE the returned
 * value — it, not the input, is the validated recipe.
 */
export async function validatedExtractionRecipe(input: unknown): Promise<ExtractionRecipeProvisional> {
  if (typeof input === 'object' && input !== null && VALIDATED_RECIPES.has(input)) {
    return input as ExtractionRecipeProvisional; // already a frozen validated canonical object
  }
  const canonical = snapshotExtractionRecipe(input); // sync: snapshot + structural proof + deep freeze
  const claimedTableHash =
    canonical.format === 'txt' || canonical.format === 'md'
      ? canonical.decoder.windows1252TableHash
      : canonical.format === 'html'
        ? canonical.extractor.decoder.windows1252TableHash
        : null; // epub carries no byte decoder — no table proof to run
  if (claimedTableHash !== null && claimedTableHash !== (await windows1252TableHash())) {
    throw new RangeError('decoder table hash does not match the implemented windows-1252 table');
  }
  VALIDATED_RECIPES.add(canonical);
  return canonical;
}

/**
 * Boundary validation — a TOTAL wire boundary: accepts `unknown`, requires
 * plain records with EXACT key sets, and matches every field against what
 * this extractor actually implements, INCLUDING the embedded windows-1252
 * table hash. Every malformed input throws RangeError (REQUEST_INVALID at
 * the wire), never TypeError.
 *
 * Assertion-style wrapper over `validatedExtractionRecipe`: it RETURNS the
 * canonical frozen snapshot, never the untrusted input — callers must carry
 * the returned value forward (Phase D / D3 ruling).
 */
export async function validateExtractionRecipe(recipe: unknown): Promise<ExtractionRecipeProvisional> {
  return validatedExtractionRecipe(recipe);
}

/** The recipe arm for one format, so a caller holding the default recipe for a
 *  format sees its exact shape (not the whole union). */
export type ExtractionRecipeFor<F extends SourceFormat> = Extract<ExtractionRecipeProvisional, { format: F }>;

/** The default extraction recipe for every catalog format, so a caller selects
 *  `recipes[format]` with no per-format switch. The EPUB default reads the
 *  bodymatter partition; non-default partition selections use
 *  `epubExtractionRecipe`. */
export type DefaultExtractionRecipes = { readonly [F in SourceFormat]: ExtractionRecipeFor<F> };

/** The default recipes are async because the decoder table hash is part of
 *  the identity — computed once and cached (cleared on rejection so a
 *  transient digest failure is retryable, mirroring windows1252TableHash). */
let defaultRecipes: Promise<DefaultExtractionRecipes> | null = null;

export function defaultExtractionRecipes(): Promise<DefaultExtractionRecipes> {
  defaultRecipes ??= (async (): Promise<DefaultExtractionRecipes> => {
    const tableHash = await windows1252TableHash();
    const decoder = {
      id: 'bom-utf8-windows1252-v1',
      bom: 'utf8-utf16le-utf16be-v1',
      unicodeErrors: 'fatal',
      fallback: 'windows-1252-whatwg-v1',
      windows1252TableHash: tableHash,
      newlineNormalization: 'none',
    } as const;
    // Minted through the ONE canonicalizer, so the defaults are exactly the
    // frozen owned objects validation returns (already in the validated set —
    // revalidating a default is an identity hit).
    return Object.freeze({
      txt: (await validatedExtractionRecipe({
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'txt',
        decoder,
        parser: { id: 'txt-literal-v1' },
        candidateReconstruction: 'text',
      })) as ExtractionRecipeFor<'txt'>,
      md: (await validatedExtractionRecipe({
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'md',
        decoder,
        parser: {
          id: 'markdown-literal-with-heading-scan-v0',
          textPolicy: 'preserve-source-markdown',
          headingScanner: 'markdown-heading-scan-v1',
        },
        candidateReconstruction: 'text',
      })) as ExtractionRecipeFor<'md'>,
      epub: epubExtractionRecipe(['bodymatter']) as ExtractionRecipeFor<'epub'>,
      html: (await validatedExtractionRecipe({
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'html',
        extractor: {
          id: 'html5-inert-v1',
          decoder,
          parser: 'parse5-v7',
          serializer: 'html-block-collapse-v1',
          sectioning: 'heading-order-v1',
        },
        candidateReconstruction: 'source',
      })) as ExtractionRecipeFor<'html'>,
    });
  })().catch((e: unknown) => {
    defaultRecipes = null; // retryable, never a cached permanent failure
    throw e;
  });
  return defaultRecipes;
}

/** The EPUB extraction recipe for a NON-DEFAULT reading-order partition
 *  selection. Production staging uses `defaultExtractionRecipes()` for every
 *  format (no partition-selection UI exists); this constructor is exercised by
 *  tests until one does. Synchronous (no decoder table hash) and pure. */
export function epubExtractionRecipe(
  partitions: readonly EbookPartition[] = ['bodymatter'],
): ExtractionRecipeProvisional {
  if (partitions.length === 0 || !partitions.every((p) => EBOOK_PARTITIONS.has(p))) {
    throw new RangeError('epub partitions must be a non-empty subset of the reading-order partitions');
  }
  // Minted through the ONE canonicalizer so the constructor cannot drift from
  // validation: the result is the same owned, deeply-frozen shape
  // validatedExtractionRecipe returns.
  const canonical = snapshotExtractionRecipe({
    schema: 'texttrends/extraction-recipe/0-provisional',
    format: 'epub',
    extractor: {
      id: 'standard-ebooks-epub-v1',
      // Canonical (unique, reading order) so equivalent selections share one
      // recipe identity.
      partitions: canonicalPartitions(partitions),
      serializer: 'xhtml-block-collapse-v1',
      sectioning: 'spine-order-v1',
    },
    candidateReconstruction: 'source',
  });
  // The epub arm has no byte decoder, hence no async table proof — the
  // synchronous snapshot IS the complete validation, so the minted object
  // joins the validated set directly (keeping this constructor synchronous).
  VALIDATED_RECIPES.add(canonical);
  return canonical;
}

export async function hashExtractionRecipe(recipe: ExtractionRecipeProvisional): Promise<string> {
  return sha256Hex(canonicalJson(recipe));
}

/**
 * Source provenance, discriminated by HOW the bytes became text. A `text`
 * source has ONE decoded encoding (the literal txt/md path). A `container`
 * source (epub) is an archive of independently-encoded documents — it has no
 * single source encoding, so it records the internal-decoding policy and the
 * spine document count instead of inventing a `detected` value.
 */
export interface TextSourceDescriptorV1 {
  readonly kind: 'text';
  readonly hash: string; // SourceHash of the exact bytes
  readonly byteLength: number;
  readonly format: 'txt' | 'md';
  readonly encoding: {
    readonly detected: DetectedEncoding;
    readonly hadReplacementChars: boolean; // decoder-inserted; see §12.4
  };
}

export interface ContainerSourceDescriptorV1 {
  readonly kind: 'container';
  readonly hash: string; // SourceHash of the exact archive bytes
  readonly byteLength: number;
  readonly format: 'epub';
  readonly container: {
    /** Every internal document is decoded strictly as UTF-8 (no BOM sniff). */
    readonly internalDecoding: 'utf-8-strict';
    /** Number of spine documents the extractor read. */
    readonly documentCount: number;
  };
}

/** A single markup document (html) — one decoded source encoding (like a text
 *  source), but the indexed text is EXTRACTED from the parsed tree, so its
 *  candidates are source-reconstructed. */
export interface MarkupSourceDescriptorV1 {
  readonly kind: 'markup';
  readonly hash: string; // SourceHash of the exact bytes
  readonly byteLength: number;
  readonly format: 'html';
  readonly encoding: {
    readonly detected: DetectedEncoding;
    readonly hadReplacementChars: boolean;
  };
}

export type SourceDescriptorV1 =
  | TextSourceDescriptorV1
  | ContainerSourceDescriptorV1
  | MarkupSourceDescriptorV1;

/** Decode-quality evidence surfaced with an extraction. NOTE the per-format
 *  semantics of `suspiciousControlCount` (admission only requires
 *  `decoderReplacementCount === 0`, so this is advisory):
 *  - txt/md: counted over the decoded text (the indexed text itself);
 *  - html: counted over the RAW decoded markup source, tags included — a
 *    signal about the input document, not the extracted text;
 *  - epub: always 0 (the container's XHTML is parsed, never byte-decoded as
 *    one stream, so no comparable count exists). */
export interface ExtractionEvidence {
  readonly decoderReplacementCount: number;
  readonly suspiciousControlCount: number;
}

export interface ExtractionArtifactV1 {
  readonly schema: 'texttrends/extraction/1';
  readonly source: string;  // SourceHash
  readonly recipe: string;  // ExtractionRecipeHash
  readonly text: string;    // TextHash of the extracted text
  readonly textLengthUtf16: number;
  readonly descriptor: SourceDescriptorV1;
  readonly candidates: readonly StructureCandidateV1[];
  readonly candidateHash: string; // StructureCandidateHash
  readonly evidence: ExtractionEvidence;
}

export interface ExtractedDocument {
  readonly artifact: ExtractionArtifactV1;
  /** The extracted text itself — storage-resident, NEVER on the artifact. */
  readonly text: string;
  /** The text-identity capability minted when extraction authenticated the
   *  output — `verifiedHashOf(verified)` IS `artifact.text`. Realm-local:
   *  never structured-clone/post it; a receiving boundary re-mints by hashing. */
  readonly verified: VerifiedText;
}

export interface CandidateBundle {
  readonly candidates: readonly StructureCandidateV1[];
  readonly candidateHash: string;
}

/**
 * Candidate derivation as a DETERMINISTIC function of verified text + recipe
 * — the shared core capability (engine-v4 consult §B). Cold extraction calls
 * it after decoding; warm reopen calls it to reconstruct candidates from
 * verified text without a source fetch. Because it is pure, the two paths
 * cannot drift. A FUTURE parser whose candidates depend on source bytes or a
 * transformed representation must NOT be routed here — its warm path must
 * require a valid extraction artifact instead.
 */
export async function deriveCandidatesFromText(
  text: string,
  recipe: ExtractionRecipeProvisional,
): Promise<CandidateBundle> {
  // Carry the RETURNED canonical snapshot — never the caller's mutable input
  // (an already-canonical recipe is an O(1) identity hit).
  const canonical = await validatedExtractionRecipe(recipe);
  // A source-dependent recipe (an EPUB's container structure) has NO text-only
  // reconstruction — refuse rather than return an empty bundle that would
  // silently erase real structure on a warm reopen (planner ruling §1).
  if (canonical.candidateReconstruction !== 'text') {
    throw new RangeError(
      `recipe for format '${canonical.format}' declares source-dependent candidates; they cannot be reconstructed from text`,
    );
  }
  const candidates =
    canonical.format === 'md' && canonical.parser.id === 'markdown-literal-with-heading-scan-v0'
      ? scanMarkdownHeadings(text)
      : [];
  return { candidates, candidateHash: await hashStructureCandidates(candidates) };
}

/**
 * The DECODE phase alone (engine-v4 consult §6): pure byte→text under the
 * recipe's decoder policy, well-formedness gated, carrying the SourceHash and
 * byte length the finalize phase needs. Split out so a worker can emit a
 * `decode` progress event immediately before this work and an `extract` event
 * immediately before candidate derivation — a phase is honest only when it
 * precedes exactly the work it names. Throws DecodeError for malformed
 * BOM-declared Unicode or lone-surrogate UTF-16 (the caller maps DECODE_FAILED).
 */
export interface DecodedDocument {
  readonly decoded: DecodedSource;
  readonly source: string; // SourceHash of the exact bytes
  readonly byteLength: number;
}

export async function decodeDocumentSource(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
): Promise<DecodedDocument> {
  // Decide the format from the RETURNED canonical snapshot, not the mutable input.
  const canonical = await validatedExtractionRecipe(recipe);
  if (!isLiteralFormat(canonical.format)) {
    throw new RangeError(`${canonical.format} is a transformed format and has no whole-file byte-decode path; extract it and finalize a transformed document`);
  }
  const source = await hashSourceBytes(bytes);
  const decoded = decodeSource(bytes);
  assertWellFormed(decoded.text, `source ${source.slice(0, 12)}…`);
  return { decoded, source, byteLength: bytes.length };
}

/**
 * A document prepared for the ONE canonical artifact builder. Either the
 * `literal` decode of source bytes (txt/md — the indexed text IS the decoded
 * source), or the `transformed` output of a container extractor (epub) that has
 * already produced the final text, its container-derived candidates, and the
 * source provenance. Core validates and hashes BOTH into the same
 * ExtractionArtifactV1 — a worker never hand-assembles an artifact and never
 * masquerades transformed output as a `DecodedDocument` (planner ruling §1).
 */
export type PreparedExtraction =
  | { readonly kind: 'literal'; readonly decoded: DecodedDocument }
  | {
      readonly kind: 'transformed';
      readonly source: SourceDescriptorV1;
      readonly text: string;
      readonly candidates: readonly StructureCandidateV1[];
      readonly evidence: ExtractionEvidence;
    };


/**
 * The EXACT source-descriptor ABI — the SINGLE authority the transformed
 * builder AND artifact admission (`validate.ts`) both apply, so a builder can
 * never mint a descriptor admission rejects (Codex review). Requires exact/plain
 * records at every level, the kind↔format pairing, the closed detected-encoding
 * set, and the zero-replacement policy; also that the descriptor's SourceHash
 * and format equal the ones it is being admitted against.
 */
export function isValidSourceDescriptor(d: unknown, sourceHash: string, format: SourceFormat): d is SourceDescriptorV1 {
  if (!isStrictPlainRecord(d) || d.hash !== sourceHash || !isNonNegInt(d.byteLength) || d.format !== format) return false;
  // The catalog is the ONE authority for the kind↔format pairing: the descriptor
  // `kind` MUST be the one this format is declared to produce. A catalog edit
  // propagates here instead of drifting from a second, restated format list.
  if (!isSourceFormat(format) || d.kind !== SOURCE_FORMATS[format].sourceKind) return false;
  const encodingOk = (): boolean =>
    exactRecord(d.encoding, ['detected', 'hadReplacementChars']) &&
    (d.encoding as { hadReplacementChars: unknown }).hadReplacementChars === false &&
    DETECTED_ENCODINGS.has((d.encoding as { detected: unknown }).detected as string);
  if (d.kind === 'text') {
    return exactRecord(d, ['kind', 'hash', 'byteLength', 'format', 'encoding']) && encodingOk();
  }
  if (d.kind === 'container') {
    return exactRecord(d, ['kind', 'hash', 'byteLength', 'format', 'container']) &&
      exactRecord(d.container, ['internalDecoding', 'documentCount']) &&
      (d.container as { internalDecoding: unknown }).internalDecoding === 'utf-8-strict' &&
      isNonNegInt((d.container as { documentCount: unknown }).documentCount);
  }
  if (d.kind === 'markup') {
    return exactRecord(d, ['kind', 'hash', 'byteLength', 'format', 'encoding']) && encodingOk();
  }
  return false;
}

/** The EXACT evidence ABI, shared with admission: an exact record of two
 *  non-negative counts, with the replacement count structurally zero under the
 *  implemented total-decode / strict-UTF-8 policies. */
export function isValidExtractionEvidence(ev: unknown): ev is ExtractionEvidence {
  return (
    exactRecord(ev, ['decoderReplacementCount', 'suspiciousControlCount']) &&
    isNonNegInt((ev as { decoderReplacementCount: unknown }).decoderReplacementCount) &&
    isNonNegInt((ev as { suspiciousControlCount: unknown }).suspiciousControlCount) &&
    (ev as { decoderReplacementCount: number }).decoderReplacementCount === 0
  );
}

/** The single artifact assembler both prepared kinds route through — the one
 *  place source/text/candidate/recipe identities are hashed together. This is
 *  where the ONE text digest of a cold ingest happens: the VerifiedText
 *  capability is minted here and carried on the returned document so the
 *  downstream verified lanes (segment/index/bind) never re-digest. */
async function assembleArtifact(
  recipe: ExtractionRecipeProvisional,
  sourceHash: string,
  text: string,
  descriptor: SourceDescriptorV1,
  candidates: readonly StructureCandidateV1[],
  candidateHash: string,
  evidence: ExtractionEvidence,
): Promise<ExtractedDocument> {
  const verified = await verifyText(text);
  const artifact: ExtractionArtifactV1 = {
    schema: 'texttrends/extraction/1',
    source: sourceHash,
    recipe: await hashExtractionRecipe(recipe),
    text: verifiedHashOf(verified),
    textLengthUtf16: text.length,
    descriptor,
    candidates,
    candidateHash,
    evidence,
  };
  return { artifact, text, verified };
}

/**
 * The EXTRACT phase: assemble the ExtractionArtifactV1 from a prepared document.
 * For `literal`, candidates come from the SAME deriveCandidatesFromText a warm
 * reopen uses, so cold and warm cannot drift. For `transformed`, core does NOT
 * trust the adapter: it re-validates the recipe, requires a source-reconstructed
 * recipe, deeply validates the descriptor/evidence/candidates against the same
 * ABI admission enforces, re-checks well-formed UTF-16, and hashes everything
 * itself. Every successful result therefore passes `validateExtractionArtifact`.
 */
export async function finalizeExtraction(
  prepared: PreparedExtraction,
  recipe: ExtractionRecipeProvisional,
): Promise<ExtractedDocument> {
  // ONE canonicalization up front; every later step (candidate derivation,
  // descriptor checks, hashing) reads the RETURNED frozen snapshot, so a
  // caller mutating its recipe mid-flight cannot skew the artifact identity.
  const canonical = await validatedExtractionRecipe(recipe);
  if (prepared.kind === 'literal') {
    if (!isLiteralFormat(canonical.format)) {
      throw new RangeError(`${canonical.format} cannot use the literal extract path`);
    }
    const { decoded, source, byteLength } = prepared.decoded;
    const { candidates, candidateHash } = await deriveCandidatesFromText(decoded.text, canonical);
    const descriptor: SourceDescriptorV1 = {
      kind: 'text',
      hash: source,
      byteLength,
      format: canonical.format,
      encoding: {
        detected: decoded.detected,
        hadReplacementChars: decoded.decoderReplacementCount > 0,
      },
    };
    return assembleArtifact(canonical, source, decoded.text, descriptor, candidates, candidateHash, {
      decoderReplacementCount: decoded.decoderReplacementCount,
      suspiciousControlCount: decoded.suspiciousControlCount,
    });
  }
  const { source: descriptor, text, candidates, evidence } = prepared;
  if (canonical.candidateReconstruction !== 'source') {
    throw new RangeError('a transformed extraction requires a source-reconstructed recipe (its candidates are container-derived, not a function of the text)');
  }
  if (!isValidSourceDescriptor(descriptor, descriptor.hash, canonical.format)) {
    throw new RangeError('transformed source descriptor is not a valid, admissible descriptor');
  }
  if (!isValidExtractionEvidence(evidence)) {
    throw new RangeError('transformed extraction evidence is not a valid, admissible record');
  }
  assertWellFormed(text, `transformed source ${descriptor.hash.slice(0, 12)}…`);
  assertValidCandidates(candidates, text.length);
  const candidateHash = await hashStructureCandidates(candidates);
  return assembleArtifact(canonical, descriptor.hash, text, descriptor, candidates, candidateHash, evidence);
}

/**
 * TEST ORACLE — not a production entry point. Production extraction goes
 * through `@texttrends/extractors`' `extractSource` (which enforces caps and
 * runs the ownership hooks); this convenience composition of
 * decodeDocumentSource + finalizeExtraction exists so tests can assert the
 * split pipeline composes to exactly what the monolithic path produces, and
 * as a fixture builder. Throws DecodeError for malformed BOM-declared Unicode
 * or lone-surrogate UTF-16.
 */
export async function extractDocument(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
): Promise<ExtractedDocument> {
  // Canonicalize ONCE and thread the returned value through both phases —
  // their own revalidations are then WeakSet identity hits on the same object.
  const canonical = await validatedExtractionRecipe(recipe);
  return finalizeExtraction({ kind: 'literal', decoded: await decodeDocumentSource(bytes, canonical) }, canonical);
}

export { DecodeError };
