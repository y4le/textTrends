/**
 * Project manifest — contract §12.6. The main thread edits the WORKING COPY;
 * the WORKER is the sole durable-admission authority — it stores the manifest
 * and answers project-load/save. Because the durable
 * user-data store persists an `unknown` payload, the worker MUST validate a
 * canonical ProjectManifestV2 before accepting project-save or emitting
 * project-loaded (engine-v4 consult): a corrupt/foreign manifest must not
 * enter the CAS, and the manifest's own revision is the single revision
 * authority (no wrapper/manifest double-count).
 *
 * This validator checks identity agreement (order ↔ docs), recipe values via
 * the same total core validators the wire boundary uses, and every claimed
 * hash. A stored hash is an assertion, so the durable boundary verifies
 * index/extraction recipe hashes and that each doc's
 * source format agrees with its extraction recipe. It is the deep authority
 * for durable project data; downstream handlers never re-verify these.
 */

import { exactArray, exactRecord, isNonNegSafeInt as isSafeNonNeg, isRecord as isRec, isString as isStr } from '../contract/guards.ts';
import { hashIndexRecipe, isIndexRecipeProvisional } from '../contract/recipes.ts';
import {
  hashExtractionRecipe,
  isValidSourceDescriptor,
  validateExtractionRecipe,
  type ExtractionRecipeProvisional,
  type SourceDescriptorV1,
  type SourceFormat,
} from '../extract/extraction.ts';
import type { IndexRecipeProvisional } from '../contract/recipes.ts';

export type SourceAvailability = 'bundled' | 'persisted' | 'external';

// The durable source descriptor IS core's extraction `SourceDescriptorV1`
// (text | container | markup) — the manifest admits exactly the shape the
// extractor produces, validated field-by-field in `validateDoc` below.

export interface DocumentMetaV1 {
  readonly title: string;
  readonly author?: string;
  readonly year?: number;
  readonly language: string;
  readonly tags: readonly string[];
}

export interface ProjectDocV1 {
  readonly doc: string;
  readonly sourceName: string;
  readonly meta: DocumentMetaV1;
  readonly source: SourceDescriptorV1;
  readonly sourceAvailability: SourceAvailability;
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: string;
    readonly text: string;
    readonly textLengthUtf16: number;
  };
}

export interface ProjectManifestV2 {
  readonly schema: 'texttrends/project/2';
  readonly id: string;
  readonly revision: number;
  readonly order: readonly string[];
  readonly docs: readonly ProjectDocV1[];
  readonly indexRecipe: IndexRecipeProvisional;
  readonly indexRecipeHash: string;
}

export class ManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestInvalidError';
  }
}


function validateMeta(m: unknown): void {
  if (!isRec(m)) throw new ManifestInvalidError('doc meta invalid');
  const keys = ['title', 'language', 'tags'];
  if (Object.prototype.hasOwnProperty.call(m, 'author')) keys.push('author');
  if (Object.prototype.hasOwnProperty.call(m, 'year')) keys.push('year');
  if (!exactRecord(m, keys) || !isStr(m.title) || !isStr(m.language)) throw new ManifestInvalidError('doc meta invalid');
  if (!Array.isArray(m.tags) || !exactArray(m.tags, m.tags.length) || !m.tags.every(isStr)) {
    throw new ManifestInvalidError('doc tags invalid');
  }
  if (m.author !== undefined && !isStr(m.author)) throw new ManifestInvalidError('doc author invalid');
  if (m.year !== undefined && (typeof m.year !== 'number' || !Number.isSafeInteger(m.year))) throw new ManifestInvalidError('doc year invalid');
}

async function validateDoc(v: unknown): Promise<ProjectDocV1> {
  if (!exactRecord(v, ['doc', 'sourceName', 'meta', 'source', 'sourceAvailability', 'extraction'])) {
    throw new ManifestInvalidError('doc has unexpected fields');
  }
  if (!isStr(v.doc) || !isStr(v.sourceName)) throw new ManifestInvalidError('doc identity invalid');
  validateMeta(v.meta);
  // ONE authority for source-descriptor admission: the SAME total guard the
  // extraction-artifact boundary applies (`isValidSourceDescriptor`). A durable
  // manifest must not accept a descriptor the artifact boundary would reject —
  // the hand-rolled arms here previously admitted `hadReplacementChars: true`,
  // which is structurally impossible under the implemented decoders and which
  // artifact admission refuses. The descriptor self-describes its hash/format;
  // `format` is cross-checked against the extraction recipe below, while `hash`
  // is the durable ASSERTED source identity — it carries no independent check
  // here and is verified against byte/artifact identities when the worker
  // consumes the source.
  const s = v.source;
  if (!isRec(s) || !isStr(s.hash) || !isValidSourceDescriptor(s, s.hash, s.format as SourceFormat)) {
    throw new ManifestInvalidError('doc source descriptor invalid');
  }
  if (v.sourceAvailability !== 'bundled' && v.sourceAvailability !== 'persisted' && v.sourceAvailability !== 'external') {
    throw new ManifestInvalidError('doc sourceAvailability invalid');
  }
  const e = v.extraction;
  if (
    !exactRecord(e, ['recipe', 'recipeHash', 'text', 'textLengthUtf16']) ||
    !isStr(e.recipeHash) || !isStr(e.text) || !isSafeNonNeg(e.textLengthUtf16)
  ) {
    throw new ManifestInvalidError('doc extraction identity invalid');
  }
  // validateExtractionRecipe throws RangeError; normalize to keep the
  // documented "every invalid manifest throws ManifestInvalidError" contract.
  // The validator RETURNS a canonical frozen snapshot of the recipe (Phase D /
  // D3); every check below — and the admitted doc itself — carries that
  // returned value, never the raw stored graph.
  let extractionRecipe: ExtractionRecipeProvisional;
  try {
    extractionRecipe = await validateExtractionRecipe(e.recipe); // deep authority (table hash etc.)
  } catch (err) {
    throw new ManifestInvalidError(`doc extraction recipe invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The extraction recipe determines the source format — a descriptor that
  // claims a different format than the recipe implements is inconsistent.
  if (s.format !== extractionRecipe.format) {
    throw new ManifestInvalidError('doc source format disagrees with its extraction recipe');
  }
  // The claimed recipe hash is an assertion — recompute it from the value.
  if ((await hashExtractionRecipe(extractionRecipe)) !== e.recipeHash) {
    throw new ManifestInvalidError('doc extraction recipeHash does not match its recipe');
  }
  // Substitute the CANONICAL recipe (deep-equal to the stored one — its hash
  // was just verified) so the admitted doc holds the immutable validated
  // snapshot: a later mutation of the raw stored graph cannot reach durable
  // writes, and revalidating the doc's recipe is a WeakSet identity hit.
  return { ...v, extraction: { ...e, recipe: extractionRecipe } } as unknown as ProjectDocV1;
}

/**
 * Total validation of a durable project manifest. Throws ManifestInvalidError
 * on any shape, identity, or recipe-value violation. Enforces
 * the single-revision-authority rule (a positive safe integer) and exact
 * agreement between `order` and `docs`.
 */
export async function validateProjectManifest(value: unknown): Promise<ProjectManifestV2> {
  if (!exactRecord(value, ['schema', 'id', 'revision', 'order', 'docs', 'indexRecipe', 'indexRecipeHash'])) {
    throw new ManifestInvalidError('manifest has unexpected fields or an invalid shape');
  }
  if (value.schema !== 'texttrends/project/2') throw new ManifestInvalidError('manifest schema invalid');
  if (!isStr(value.id)) throw new ManifestInvalidError('manifest id invalid');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ManifestInvalidError('manifest revision must be a positive safe integer');
  }
  if (!Array.isArray(value.order) || !exactArray(value.order, value.order.length) || !value.order.every(isStr)) {
    throw new ManifestInvalidError('manifest order invalid');
  }
  if (!Array.isArray(value.docs) || !exactArray(value.docs, value.docs.length)) {
    throw new ManifestInvalidError('manifest docs invalid');
  }
  if (!isIndexRecipeProvisional(value.indexRecipe) || !isStr(value.indexRecipeHash)) {
    throw new ManifestInvalidError('manifest index recipe invalid');
  }
  if ((await hashIndexRecipe(value.indexRecipe)) !== value.indexRecipeHash) {
    throw new ManifestInvalidError('manifest indexRecipeHash does not match its indexRecipe');
  }
  const docs = await Promise.all(value.docs.map(validateDoc));
  const ids = docs.map((d) => d.doc);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) throw new ManifestInvalidError('duplicate document ids');
  const order = value.order as string[];
  // order and docs must name exactly the same set, in agreement.
  if (order.length !== docs.length || !order.every((id) => idSet.has(id))) {
    throw new ManifestInvalidError('order and docs disagree');
  }
  if (new Set(order).size !== order.length) throw new ManifestInvalidError('order has duplicates');
  // Return the manifest carrying the ADMITTED docs (whose extraction recipes
  // are the canonical validated snapshots) — the caller must retain and use
  // this returned value, per the validated-recipe contract.
  return { ...value, docs } as unknown as ProjectManifestV2;
}
