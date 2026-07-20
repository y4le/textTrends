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

import { canonicalJson, sha256Hex, hashText } from '../contract/hash.ts';
import {
  DecodeError,
  assertWellFormed,
  decodeSource,
  windows1252TableHash,
  type DetectedEncoding,
} from './decode.ts';
import {
  hashStructureCandidates,
  scanMarkdownHeadings,
  type StructureCandidateV1,
} from './markdown.ts';

export type SourceFormat = 'txt' | 'md';

interface DecoderPolicyV0 {
  readonly id: 'bom-utf8-windows1252-v1';
  readonly bom: 'utf8-utf16le-utf16be-v1';
  readonly unicodeErrors: 'fatal';
  readonly fallback: 'windows-1252-whatwg-v1';
  readonly windows1252TableHash: string;
  readonly newlineNormalization: 'none';
}

/**
 * FORMAT-DISCRIMINATED (review finding): a well-typed recipe cannot pair
 * format 'md' with the txt parser or vice versa — the recipe must describe
 * exactly the operation the extractor performs.
 */
export type ExtractionRecipeProvisional =
  | {
      readonly schema: 'texttrends/extraction-recipe/0-provisional';
      readonly format: 'txt';
      readonly decoder: DecoderPolicyV0;
      readonly parser: { readonly id: 'txt-literal-v1' };
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
    };

/** PLAIN records only: a class instance or custom prototype could satisfy
 *  value checks while carrying behavior (getters, prototype state) outside
 *  the canonical-JSON domain the hash boundary operates on; symbol-keyed
 *  properties are invisible to key checks (round-4 review). */
const isRecord = (v: unknown): v is Record<string, unknown> => {
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

/**
 * Boundary validation — a TOTAL wire boundary: accepts `unknown`, requires
 * plain records with EXACT key sets, and matches every field against what
 * this extractor actually implements, INCLUDING the embedded windows-1252
 * table hash — a recipe claiming a different table would record an identity
 * for behavior that never ran. Every malformed input throws RangeError
 * (REQUEST_INVALID at the wire), never TypeError.
 */
export async function validateExtractionRecipe(recipe: unknown): Promise<ExtractionRecipeProvisional> {
  if (!isRecord(recipe)) throw new RangeError('extraction recipe must be an object');
  requireExactKeys(recipe, ['schema', 'format', 'decoder', 'parser'], 'extraction recipe');
  if (recipe.schema !== 'texttrends/extraction-recipe/0-provisional') {
    throw new RangeError(`unknown extraction recipe schema '${String(recipe.schema)}'`);
  }
  const d = recipe.decoder;
  if (!isRecord(d)) throw new RangeError('decoder policy must be an object');
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
  if (d.windows1252TableHash !== (await windows1252TableHash())) {
    throw new RangeError('decoder table hash does not match the implemented windows-1252 table');
  }
  const p = recipe.parser;
  if (!isRecord(p)) throw new RangeError('parser must be an object');
  if (recipe.format === 'txt') {
    requireExactKeys(p, ['id'], 'txt parser');
    if (p.id !== 'txt-literal-v1') throw new RangeError('format/parser combination is not a supported extraction');
  } else if (recipe.format === 'md') {
    requireExactKeys(p, ['id', 'textPolicy', 'headingScanner'], 'md parser');
    if (
      p.id !== 'markdown-literal-with-heading-scan-v0' ||
      p.textPolicy !== 'preserve-source-markdown' ||
      p.headingScanner !== 'markdown-heading-scan-v1'
    ) {
      throw new RangeError('format/parser combination is not a supported extraction');
    }
  } else {
    throw new RangeError(`unknown source format '${String(recipe.format)}'`);
  }
  return recipe as unknown as ExtractionRecipeProvisional;
}

/** The default recipes are async because the decoder table hash is part of
 *  the identity — computed once and cached. */
let defaultRecipes: Promise<{ txt: ExtractionRecipeProvisional; md: ExtractionRecipeProvisional }> | null = null;

export function defaultExtractionRecipes(): Promise<{
  txt: ExtractionRecipeProvisional;
  md: ExtractionRecipeProvisional;
}> {
  defaultRecipes ??= (async () => {
    const tableHash = await windows1252TableHash();
    const decoder = {
      id: 'bom-utf8-windows1252-v1',
      bom: 'utf8-utf16le-utf16be-v1',
      unicodeErrors: 'fatal',
      fallback: 'windows-1252-whatwg-v1',
      windows1252TableHash: tableHash,
      newlineNormalization: 'none',
    } as const;
    return {
      txt: { schema: 'texttrends/extraction-recipe/0-provisional', format: 'txt', decoder, parser: { id: 'txt-literal-v1' } },
      md: {
        schema: 'texttrends/extraction-recipe/0-provisional',
        format: 'md',
        decoder,
        parser: {
          id: 'markdown-literal-with-heading-scan-v0',
          textPolicy: 'preserve-source-markdown',
          headingScanner: 'markdown-heading-scan-v1',
        },
      },
    };
  })();
  return defaultRecipes;
}

export async function hashExtractionRecipe(recipe: ExtractionRecipeProvisional): Promise<string> {
  return sha256Hex(canonicalJson(recipe as unknown as Parameters<typeof canonicalJson>[0]));
}

export async function hashSourceBytes(bytes: Uint8Array): Promise<string> {
  // Cast for consumers type-checked against lib.dom's BufferSource (the
  // core ambient takes Uint8Array): every caller passes ArrayBuffer-backed
  // bytes.
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SourceDescriptorV1 {
  readonly hash: string; // SourceHash of the exact bytes
  readonly byteLength: number;
  readonly format: SourceFormat;
  readonly encoding: {
    readonly detected: DetectedEncoding;
    readonly hadReplacementChars: boolean; // decoder-inserted; see §12.4
  };
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
  readonly evidence: {
    readonly decoderReplacementCount: number;
    readonly suspiciousControlCount: number;
  };
}

export interface ExtractedDocument {
  readonly artifact: ExtractionArtifactV1;
  /** The extracted text itself — storage-resident, NEVER on the artifact. */
  readonly text: string;
}

/**
 * Extract a document: decode per policy, well-formedness gate, candidate
 * scan (md only). Throws DecodeError for malformed BOM-declared Unicode or
 * lone-surrogate UTF-16; the caller maps that to DECODE_FAILED.
 */
export async function extractDocument(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
): Promise<ExtractedDocument> {
  await validateExtractionRecipe(recipe);
  const source = await hashSourceBytes(bytes);
  const decoded = decodeSource(bytes);
  assertWellFormed(decoded.text, `source ${source.slice(0, 12)}…`);
  const candidates =
    recipe.parser.id === 'markdown-literal-with-heading-scan-v0'
      ? scanMarkdownHeadings(decoded.text)
      : [];
  const artifact: ExtractionArtifactV1 = {
    schema: 'texttrends/extraction/1',
    source,
    recipe: await hashExtractionRecipe(recipe),
    text: await hashText(decoded.text),
    textLengthUtf16: decoded.text.length,
    descriptor: {
      hash: source,
      byteLength: bytes.length,
      format: recipe.format,
      encoding: {
        detected: decoded.detected,
        hadReplacementChars: decoded.decoderReplacementCount > 0,
      },
    },
    candidates,
    candidateHash: await hashStructureCandidates(candidates),
    evidence: {
      decoderReplacementCount: decoded.decoderReplacementCount,
      suspiciousControlCount: decoded.suspiciousControlCount,
    },
  };
  return { artifact, text: decoded.text };
}

export { DecodeError };
