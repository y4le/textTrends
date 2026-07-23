/**
 * The project layer (commit 7, per the recorded commit-7 ruling). One
 * current-project abstraction drives ALL analysis origins — the bundled
 * built-in corpus, a freshly imported set of files, a loaded durable project,
 * and a reattached one — through a single generation-spec builder. The main
 * thread owns project intent and the working copy; the worker remains the sole
 * durable-storage and analysis actor.
 *
 * This module holds the pure, worker-agnostic pieces: the working-copy data
 * model, the origin discriminant, the shared spec builder, and the statically
 * described built-in project. The session controller that runs import, CAS
 * save, source persistence, and reattachment against a client lives alongside
 * it. Deliberate contract choices from the ruling:
 * - An unsaved import is NOT a `ProjectManifestV1` at revision 0 — the durable
 *   validator requires a positive revision. The working copy carries
 *   `ProjectDataV1` (no schema/revision) plus a `baseRevision`; a manifest at
 *   revision `baseRevision + 1` is materialized and validated only at save.
 * - `sourceAvailability` is canonical manifest truth (`bundled | external |
 *   persisted`); durability progress is a separate transient runtime status.
 */

import {
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashStructureCandidates,
  hashStructureRecipe,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  type ExtractionRecipeProvisional,
  type PersistedOverride,
  type ProjectDocV1,
  type ProjectManifestV1,
} from '@texttrends/core';
import type { GenerationDocSpecV4, OverrideInputV4 } from '../worker/protocol-v4.ts';

/** The file-input `accept` attribute — every supported source extension, derived
 *  from the core format catalog so it can never drift from what import accepts. */
export const SOURCE_FILE_ACCEPT: string = SOURCE_FORMAT_IDS.flatMap((f) => SOURCE_FORMATS[f].extensions).join(',');

/** The main-thread WORKING COPY: a project manifest minus the two fields the
 *  durable layer owns (`schema` is fixed; `revision` is CAS state carried
 *  separately as `baseRevision`). Every origin materializes to this shape. */
export type ProjectDataV1 = Omit<ProjectManifestV1, 'schema' | 'revision'>;

/**
 * The current project with an EXPLICIT origin — the read-only-built-in boundary
 * the rest of commit 7 builds on. The built-in corpus is never CAS-saved,
 * persisted, or reattached; only the user arm carries a `baseRevision` (0 means
 * never durably saved). The session controller extends the user arm with edit/
 * saved epochs and operation state; this envelope establishes the invariant.
 */
export type CurrentProject =
  | { readonly kind: 'builtin'; readonly data: ProjectDataV1 }
  | { readonly kind: 'user'; readonly data: ProjectDataV1; readonly baseRevision: number };

/** The read-only built-in current project. */
export function builtinProject(data: ProjectDataV1): CurrentProject {
  return { kind: 'builtin', data };
}

/** The bundled corpus's stable durable id — a built-in, never CAS-saved. */
export const BUILTIN_SHERLOCK_ID = 'builtin/sherlock';
/** The single user project id in the v1 one-project scope. */
export const USER_PROJECT_ID = 'user/default';

/**
 * Map the persisted override status to the wire override input. `none` and an
 * `active` correction pass through; a `needs-review` correction is NOT applied
 * (its base identities no longer match the document), so it is sent as `none`
 * until the user rebases it — never as a stale `active` (§12.3 / engine-v4 §A).
 */
export function overrideInputFromPersisted(override: PersistedOverride): OverrideInputV4 {
  if (override.status === 'active') return { kind: 'active', value: override.value, hash: override.hash };
  return { kind: 'none' };
}

/**
 * The ONE generation-spec builder, shared by every project origin. It maps the
 * working copy's documents to `GenerationDocSpecV4` in DECLARED (`order`) order,
 * carrying each doc's recipe values + recomputed-hash assertions and expected
 * source/text/candidate identities so the worker warm-reopens exact hits and
 * cold-ingests only genuine misses. A doc named in `order` but absent from
 * `docs` is a malformed working copy (guaranteed not to occur for a validated
 * manifest, but checked so a bug surfaces as an error, not a silent drop).
 */
export function generationSpecsFromProject(data: ProjectDataV1): GenerationDocSpecV4[] {
  const byId = new Map(data.docs.map((d) => [d.doc, d] as const));
  return data.order.map((id) => {
    const doc = byId.get(id);
    if (!doc) throw new RangeError(`project order names '${id}' which is not in docs`);
    return {
      doc: doc.doc,
      language: doc.meta.language,
      source: {
        expectedHash: doc.source.hash,
        byteLength: doc.source.byteLength,
        format: doc.source.format,
        availability: doc.sourceAvailability,
      },
      extraction: {
        recipe: doc.extraction.recipe,
        recipeHash: doc.extraction.recipeHash,
        expectedText: doc.extraction.text,
        expectedTextLengthUtf16: doc.extraction.textLengthUtf16,
        expectedCandidates: doc.extraction.candidates,
      },
      structure: {
        recipe: doc.structure.recipe,
        recipeHash: doc.structure.recipeHash,
        override: overrideInputFromPersisted(doc.structure.override),
      },
    };
  });
}

/** Thrown when a save/persist/reattach path is entered for the built-in. */
export class ReadOnlyProjectError extends Error {
  constructor(message = 'the built-in project is read-only and cannot be saved') {
    super(message);
    this.name = 'ReadOnlyProjectError';
  }
}

/**
 * Materialize the durable manifest for a CAS save: the USER working copy at its
 * NEXT revision (`baseRevision + 1`). This is the single save-materialization
 * path and it REJECTS the built-in origin — Sherlock can never be written to
 * class-1 storage. The caller validates the result (validateProjectManifest)
 * before sending; this only assembles the canonical shape.
 */
export function manifestForSave(project: CurrentProject): ProjectManifestV1 {
  if (project.kind === 'builtin') throw new ReadOnlyProjectError();
  return { schema: 'texttrends/project/1', revision: project.baseRevision + 1, ...project.data };
}

/** Split a loaded durable manifest into a USER current project (its revision
 *  becomes the base revision). A loaded project is always the user arm. */
export function userProjectFromManifest(manifest: ProjectManifestV1): CurrentProject {
  const { schema: _schema, revision, ...data } = manifest;
  return { kind: 'user', data, baseRevision: revision };
}

/** One bundled built-in document's static description (no source-ready is ever
 *  emitted for a warm exact reopen, so the built-in must be fully described). */
export interface BuiltinDocFixture {
  readonly doc: string;
  readonly title: string;
  readonly bytes: number;
  readonly textLengthUtf16: number;
  readonly sourceHash: string;
  readonly textHash: string;
}

/**
 * Build the built-in corpus's `ProjectDataV1` from its static fixtures. The
 * recipe/candidate hashes are recomputed once (memoize at the call site) and
 * verified against the fixture's asserted per-doc identities by
 * validateProjectManifest — so a recipe change surfaces as a test failure, not
 * a silently stale constant. txt yields no structure candidates, so every doc
 * shares the empty-candidate hash. The built-in is `availability: 'bundled'`:
 * byte misses are fetched from its URL, never persisted or reattached.
 */
export async function buildBuiltinProjectData(id: string, docs: readonly BuiltinDocFixture[]): Promise<ProjectDataV1> {
  const { txt } = await defaultExtractionRecipes();
  const [extractionRecipeHash, structureRecipeHash, candidates, indexRecipeHash] = await Promise.all([
    hashExtractionRecipe(txt),
    hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE),
    hashStructureCandidates([]),
    hashIndexRecipe(DEFAULT_INDEX_RECIPE),
  ]);
  const projectDocs: ProjectDocV1[] = docs.map((d) => ({
    doc: d.doc,
    sourceName: d.doc,
    meta: { title: d.title, language: 'en', tags: [] },
    source: { kind: 'text', hash: d.sourceHash, byteLength: d.bytes, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
    sourceAvailability: 'bundled',
    extraction: { recipe: txt as ExtractionRecipeProvisional, recipeHash: extractionRecipeHash, text: d.textHash, textLengthUtf16: d.textLengthUtf16, candidates },
    structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: structureRecipeHash, override: { status: 'none' } },
  }));
  return {
    id,
    order: projectDocs.map((d) => d.doc),
    docs: projectDocs,
    indexRecipe: DEFAULT_INDEX_RECIPE,
    indexRecipeHash,
  };
}
