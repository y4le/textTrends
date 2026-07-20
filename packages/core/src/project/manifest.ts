/**
 * Project manifest — contract §12.6. The main thread OWNS this; the worker
 * stores it durably and answers project-load/save. Because the durable
 * user-data store persists an `unknown` payload, the worker MUST validate a
 * canonical ProjectManifestV1 before accepting project-save or emitting
 * project-loaded (engine-v4 consult): a corrupt/foreign manifest must not
 * enter the CAS, and the manifest's own revision is the single revision
 * authority (no wrapper/manifest double-count).
 *
 * This validator checks structure, identity agreement (order ↔ docs), and
 * the recipe/override VALUES via the same total core validators the wire
 * boundary uses — it is the deep authority for durable project data.
 */

import { exactArray, exactRecord, isIndexRecipeProvisional } from '../contract/recipes.ts';
import { isStructureOverrideV1, isStructureRecipeProvisional } from '../structure/build.ts';
import { validateExtractionRecipe, type ExtractionRecipeProvisional } from '../extract/extraction.ts';
import type { IndexRecipeProvisional } from '../contract/recipes.ts';
import type { StructureOverrideV1, StructureRecipeProvisional } from '../structure/build.ts';

export type SourceAvailability = 'bundled' | 'persisted' | 'external';

export interface SourceDescriptorV1 {
  readonly hash: string;
  readonly byteLength: number;
  readonly format: 'txt' | 'md';
  readonly encoding: { readonly detected: string; readonly hadReplacementChars: boolean };
}

export interface DocumentMetaV1 {
  readonly title: string;
  readonly author?: string;
  readonly year?: number;
  readonly language: string;
  readonly tags: readonly string[];
}

/** The persisted override, honestly discriminated: an active correction is
 *  retained verbatim with its base identities; needs-review keeps a stale
 *  correction for later rebase without letting it affect the section table
 *  (§12.3). */
export type PersistedOverride =
  | { readonly status: 'none' }
  | { readonly status: 'active'; readonly value: StructureOverrideV1; readonly hash: string }
  | { readonly status: 'needs-review'; readonly value: StructureOverrideV1; readonly hash: string };

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
    readonly candidates: string;
  };
  readonly structure: {
    readonly recipe: StructureRecipeProvisional;
    readonly recipeHash: string;
    readonly override: PersistedOverride;
  };
}

export interface ProjectManifestV1 {
  readonly schema: 'texttrends/project/1';
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

const isStr = (v: unknown): v is string => typeof v === 'string';
const isSafeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Enclosing identities the override's status must be consistent with (§12.6). */
interface DocIdentities {
  readonly text: string;
  readonly candidates: string;
  readonly structureRecipeHash: string;
}

function validateOverride(o: unknown, id: DocIdentities): PersistedOverride {
  if (!isRec(o) || !isStr(o.status)) throw new ManifestInvalidError('override status missing');
  if (o.status === 'none') {
    if (!exactRecord(o, ['status'])) throw new ManifestInvalidError('none override has extra fields');
    return { status: 'none' };
  }
  if (o.status === 'active' || o.status === 'needs-review') {
    if (!exactRecord(o, ['status', 'value', 'hash']) || !isStructureOverrideV1(o.value) || !isStr(o.hash)) {
      throw new ManifestInvalidError(`${o.status} override malformed`);
    }
    // §12.6 invariant: active IFF all three base identities match the doc's
    // current extraction/structure; needs-review IFF at least one differs.
    const matches = o.value.text === id.text && o.value.candidates === id.candidates && o.value.baseRecipe === id.structureRecipeHash;
    if (o.status === 'active' && !matches) {
      throw new ManifestInvalidError('active override base identities do not match the document');
    }
    if (o.status === 'needs-review' && matches) {
      throw new ManifestInvalidError('needs-review override still matches the document (should be active)');
    }
    return o as unknown as PersistedOverride;
  }
  throw new ManifestInvalidError(`unknown override status '${String(o.status)}'`);
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
  if (!exactRecord(v, ['doc', 'sourceName', 'meta', 'source', 'sourceAvailability', 'extraction', 'structure'])) {
    throw new ManifestInvalidError('doc has unexpected fields');
  }
  if (!isStr(v.doc) || !isStr(v.sourceName)) throw new ManifestInvalidError('doc identity invalid');
  validateMeta(v.meta);
  const s = v.source;
  if (
    !exactRecord(s, ['hash', 'byteLength', 'format', 'encoding']) || !isStr(s.hash) || !isSafeNonNeg(s.byteLength) ||
    (s.format !== 'txt' && s.format !== 'md') ||
    !exactRecord(s.encoding, ['detected', 'hadReplacementChars']) || !isStr(s.encoding.detected) || typeof s.encoding.hadReplacementChars !== 'boolean'
  ) {
    throw new ManifestInvalidError('doc source descriptor invalid');
  }
  if (v.sourceAvailability !== 'bundled' && v.sourceAvailability !== 'persisted' && v.sourceAvailability !== 'external') {
    throw new ManifestInvalidError('doc sourceAvailability invalid');
  }
  const e = v.extraction;
  if (
    !exactRecord(e, ['recipe', 'recipeHash', 'text', 'textLengthUtf16', 'candidates']) ||
    !isStr(e.recipeHash) || !isStr(e.text) || !isSafeNonNeg(e.textLengthUtf16) || !isStr(e.candidates)
  ) {
    throw new ManifestInvalidError('doc extraction identity invalid');
  }
  // validateExtractionRecipe throws RangeError; normalize to keep the
  // documented "every invalid manifest throws ManifestInvalidError" contract.
  try {
    await validateExtractionRecipe(e.recipe); // deep authority (table hash etc.)
  } catch (err) {
    throw new ManifestInvalidError(`doc extraction recipe invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  const st = v.structure;
  if (!exactRecord(st, ['recipe', 'recipeHash', 'override']) || !isStructureRecipeProvisional(st.recipe) || !isStr(st.recipeHash)) {
    throw new ManifestInvalidError('doc structure recipe invalid');
  }
  validateOverride(st.override, { text: e.text, candidates: e.candidates, structureRecipeHash: st.recipeHash });
  return v as unknown as ProjectDocV1;
}

/**
 * Total validation of a durable project manifest. Throws ManifestInvalidError
 * on any structural, identity, or recipe/override-value violation. Enforces
 * the single-revision-authority rule (a positive safe integer) and exact
 * agreement between `order` and `docs`.
 */
export async function validateProjectManifest(value: unknown): Promise<ProjectManifestV1> {
  if (!exactRecord(value, ['schema', 'id', 'revision', 'order', 'docs', 'indexRecipe', 'indexRecipeHash'])) {
    throw new ManifestInvalidError('manifest has unexpected fields or an invalid shape');
  }
  if (value.schema !== 'texttrends/project/1') throw new ManifestInvalidError('manifest schema invalid');
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
  return value as unknown as ProjectManifestV1;
}
