/**
 * The ONE extraction runtime both the browser worker and a future Node CLI
 * share. It folds the literal-vs-transformed dispatch (keyed off the core format
 * catalog's `extractionKind`), the decode/extract phase progression, the
 * awaitable ownership/cancellation gate, and the central per-document text-cap
 * invariant into a single call. Cold ingest and warm re-extraction share this
 * algorithm and differ ONLY in how they surface a failure (emit a wire code vs.
 * downgrade to a byte miss) — that policy stays at the call site.
 */

import {
  DecodeError,
  decodeDocumentSource,
  finalizeExtraction,
  isLiteralFormat,
  type ExtractedDocument,
  type ExtractionRecipeProvisional,
} from '@texttrends/core';
import { extractEpubDocument } from './epub-extract.ts';
import { extractHtmlDocument } from './html-extract.ts';
import { ExtractionFailure } from './failure.ts';

export interface ExtractionLimits {
  /** The per-document canonical-text UTF-16 ceiling (all formats). */
  readonly maxTextUtf16PerDoc: number;
  /** The decompressed-archive input ceiling a container extractor may read
   *  (epub only) — a zip-bomb guard on INPUT, distinct from the output text cap. */
  readonly maxArchiveInflatedBytesPerDoc: number;
}

export interface ExtractionHooks {
  /** Announce the phase about to run (for progress reporting). */
  onPhaseStart?(phase: 'decode' | 'extract'): void;
  /** An awaitable ownership/cancellation gate (cold ingest passes its doc
   *  gate; warm re-extraction its generation/ownership gate). EXACT timing,
   *  once per branch: the literal path runs it BETWEEN decode and finalize;
   *  the transformed path runs it once AFTER the adapter returns. It is NOT
   *  the final result-consumption fence — a caller with ownership/cancellation
   *  semantics MUST gate again after `extractSource` returns, before consuming
   *  the result (both engine call sites do; the transformed path therefore
   *  double-checks, which is harmless and deliberate). An OPAQUE
   *  supersession/cancellation thrown here passes through UNCHANGED — it is
   *  never remapped to a failure code. */
  afterPhase?(): void | Promise<void>;
}

/** Dispatch a transformed format to its adapter with the correct budget unit. */
function extractTransformed(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
  limits: ExtractionLimits,
): Promise<ExtractedDocument> {
  switch (recipe.format) {
    case 'epub':
      return extractEpubDocument(bytes, recipe, limits.maxArchiveInflatedBytesPerDoc);
    case 'html':
      return extractHtmlDocument(bytes, recipe, limits.maxTextUtf16PerDoc);
    default:
      // Unreachable for a validated transformed recipe; a programming fault.
      throw new Error(`extractSource: '${recipe.format}' is not a transformed format`);
  }
}

/**
 * Extract a document to the ONE canonical ExtractionArtifactV1. Literal formats
 * decode → finalize; transformed formats route to their adapter. Throws an
 * `ExtractionFailure` (DECODE_FAILED | PARSE_FAILED | CAP_EXCEEDED) for
 * understood domain failures; any other exception propagates UNCHANGED so the
 * caller classifies it by its own taxonomy (not as an extraction-domain code).
 */
export async function extractSource(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
  limits: ExtractionLimits,
  hooks?: ExtractionHooks,
): Promise<ExtractedDocument> {
  let result: ExtractedDocument;
  if (isLiteralFormat(recipe.format)) {
    hooks?.onPhaseStart?.('decode');
    let decoded;
    try {
      decoded = await decodeDocumentSource(bytes, recipe);
    } catch (e) {
      if (e instanceof DecodeError) throw new ExtractionFailure('DECODE_FAILED', e.message, { cause: e });
      throw e; // a validation/programming fault, not a domain decode failure
    }
    await hooks?.afterPhase?.();
    // Enforce the text cap at the post-decode boundary — BEFORE announcing and
    // running the extract phase — so an over-cap literal does no finalize work
    // and adds no extract-phase await window (lifecycle parity with the prior
    // per-branch cold/warm paths, which capped `decoded.text` here).
    if (decoded.decoded.text.length > limits.maxTextUtf16PerDoc) {
      throw new ExtractionFailure('CAP_EXCEEDED', `decoded text of ${decoded.decoded.text.length} exceeds the per-document UTF-16 cap`);
    }
    hooks?.onPhaseStart?.('extract');
    result = await finalizeExtraction({ kind: 'literal', decoded }, recipe);
  } else {
    hooks?.onPhaseStart?.('extract');
    result = await extractTransformed(bytes, recipe, limits);
    await hooks?.afterPhase?.();
  }
  // The central invariant, retained as a defense for the transformed adapters
  // (whose own cap check is not a complete guard): the canonical text never
  // exceeds the per-document cap. The literal path already enforced this above.
  if (result.text.length > limits.maxTextUtf16PerDoc) {
    throw new ExtractionFailure(
      'CAP_EXCEEDED',
      `extracted text of ${result.text.length} exceeds the per-document UTF-16 cap`,
    );
  }
  return result;
}
