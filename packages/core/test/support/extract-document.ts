/**
 * Test-support fixture builder: the literal-format decode + finalize
 * composition. Production extraction goes through `@texttrends/extractors`'
 * `extractSource` (which enforces caps and runs the ownership hooks); tests
 * use this convenience to build extraction artifacts from raw bytes without
 * that runtime. Throws DecodeError for malformed BOM-declared Unicode or
 * lone-surrogate UTF-16.
 */
import {
  decodeDocumentSource,
  finalizeExtraction,
  validatedExtractionRecipe,
  type ExtractedDocument,
  type ExtractionRecipeProvisional,
} from '../../src/extract/extraction.ts';

export async function extractDocument(
  bytes: Uint8Array,
  recipe: ExtractionRecipeProvisional,
): Promise<ExtractedDocument> {
  // Canonicalize ONCE and thread the returned value through both phases —
  // their own revalidations are then WeakSet identity hits on the same object.
  const canonical = await validatedExtractionRecipe(recipe);
  return finalizeExtraction({ kind: 'literal', decoded: await decodeDocumentSource(bytes, canonical) }, canonical);
}
