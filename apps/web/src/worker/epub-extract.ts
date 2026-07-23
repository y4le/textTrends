/**
 * EPUB container extraction — the worker-side adapter behind the `epub` format.
 * It DYNAMICALLY imports the catalog-independent `@texttrends/standard-ebooks/
 * extract` subpath (so the zip/XML libraries load only when an EPUB is actually
 * ingested, never for txt/md users) and turns archive bytes into a `transformed`
 * PreparedExtraction: the joined reading-order text, one `epub-section`
 * candidate per included spine document, and container provenance. Core's
 * `finalizeExtraction` then validates and hashes it into the one canonical
 * artifact — this adapter never hand-assembles an artifact.
 */

import {
  finalizeExtraction,
  hashSourceBytes,
  type EbookPartition,
  type ExtractedDocument,
  type ExtractionRecipeProvisional,
  type PreparedExtraction,
  type StructureCandidateV1,
} from '@texttrends/core';

type EpubRecipe = Extract<ExtractionRecipeProvisional, { format: 'epub' }>;

/** A malformed archive/markup or a size overrun, classified so the engine maps
 *  it to the right wire error (PARSE_FAILED vs CAP_EXCEEDED) — never
 *  DECODE_FAILED, which is byte→text decoding the container path never runs. */
export class EpubExtractionError extends Error {
  constructor(message: string, readonly cap: boolean) {
    super(message);
    this.name = 'EpubExtractionError';
  }
}

/**
 * Extract an `.epub` document into a canonical ExtractionArtifactV1. Bounds the
 * total decompressed OPF/XHTML by `maxExtractedBytes` (a zip-bomb guard) inside
 * the library; the engine additionally enforces the per-document output UTF-16
 * cap on the returned text.
 */
export async function extractEpubDocument(
  bytes: Uint8Array,
  recipe: EpubRecipe,
  maxExtractedBytes: number,
): Promise<ExtractedDocument> {
  const { extractEpub, StandardEbooksError } = await import('@texttrends/standard-ebooks/extract');
  let result;
  try {
    result = extractEpub(bytes, {
      partitions: recipe.extractor.partitions as readonly EbookPartition[],
      maxExtractedBytes,
    });
  } catch (e) {
    const cap = e instanceof StandardEbooksError && e.code === 'CAP_EXCEEDED';
    throw new EpubExtractionError(e instanceof Error ? e.message : String(e), cap);
  }

  const hash = await hashSourceBytes(bytes);
  // One candidate per INCLUDED spine document: its title anchors a flat chapter
  // boundary at the section's start in the joined text (the structure builder
  // recomputes each span's end from the next boundary).
  const candidates: StructureCandidateV1[] = result.sections
    .filter((s) => s.includedInText && s.range !== null && s.title.trim() !== '')
    .map((s) => ({
      kind: 'epub-section',
      level: 1,
      title: s.title,
      chars: { start: s.range!.start, end: s.range!.end },
    }));

  const prepared: PreparedExtraction = {
    kind: 'transformed',
    source: {
      kind: 'container',
      hash,
      byteLength: bytes.length,
      format: 'epub',
      container: { internalDecoding: 'utf-8-strict', documentCount: result.sections.length },
    },
    text: result.text,
    candidates,
    evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0 },
  };
  return finalizeExtraction(prepared, recipe);
}
