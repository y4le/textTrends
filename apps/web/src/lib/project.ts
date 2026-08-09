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
 * - An unsaved import is not a durable manifest at revision 0 — the durable
 *   validator requires a positive revision. The working copy carries
 *   `ProjectDataV1` (no schema/revision) plus a `baseRevision`; a manifest at
 *   revision `baseRevision + 1` is materialized and validated only at save.
 * - `sourceAvailability` is canonical manifest truth (`bundled | external |
 *   persisted`); durability progress is a separate transient runtime status.
 */

import {
  DEFAULT_INDEX_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  type ExtractionRecipeProvisional,
  type ProjectDocV1,
  type ProjectManifestV2,
} from '@texttrends/core';
import type { GenerationDocSpecV4 } from '../shared/analysis-contract.ts';

/** The file-input `accept` attribute — every supported source extension, derived
 *  from the core format catalog so it can never drift from what import accepts. */
export const SOURCE_FILE_ACCEPT: string = SOURCE_FORMAT_IDS.flatMap((f) => SOURCE_FORMATS[f].extensions).join(',');

/** The main-thread WORKING COPY: a project manifest minus the two fields the
 *  durable layer owns (`schema` is fixed; `revision` is CAS state carried
 *  separately as `baseRevision`). Every origin materializes to this shape. */
export type ProjectDataV1 = Omit<ProjectManifestV2, 'schema' | 'revision'>;

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

/** Stable ids for the read-only bundled corpora — never CAS-saved. */
export const BUILTIN_SHERLOCK_ID = 'builtin/sherlock';
export const BUILTIN_ASOIF_ID = 'builtin/asoif';
export const BUILTIN_LOTR_ID = 'builtin/lotr';

export type BuiltinCorpusId =
  | typeof BUILTIN_SHERLOCK_ID
  | typeof BUILTIN_ASOIF_ID
  | typeof BUILTIN_LOTR_ID;

export interface BuiltinCorpusOption {
  readonly id: BuiltinCorpusId;
  readonly sourceDirectory: 'sherlock' | 'asoif' | 'lotr';
  readonly label: string;
  readonly defaultTerms: string;
}

/** Presentation + bootstrap vocabulary for the bundled demo picker. */
export const BUILTIN_CORPORA: readonly BuiltinCorpusOption[] = [
  { id: BUILTIN_SHERLOCK_ID, sourceDirectory: 'sherlock', label: 'Sherlock Holmes', defaultTerms: 'Holmes, Moriarty' },
  { id: BUILTIN_ASOIF_ID, sourceDirectory: 'asoif', label: 'A Song of Ice and Fire', defaultTerms: 'Jon, Tyrion, Daenerys' },
  { id: BUILTIN_LOTR_ID, sourceDirectory: 'lotr', label: 'The Lord of the Rings', defaultTerms: 'Frodo, Gandalf, Sauron' },
];

export function builtinCorpusOption(id: string): BuiltinCorpusOption | undefined {
  return BUILTIN_CORPORA.find((corpus) => corpus.id === id);
}

/** The single user project id in the v1 one-project scope. */
export const USER_PROJECT_ID = 'user/default';

/**
 * The ONE generation-spec builder, shared by every project origin. It maps the
 * working copy's documents to `GenerationDocSpecV4` in DECLARED (`order`) order,
 * carrying each doc's recipe values + recomputed-hash assertions and expected
 * source/text identities so the worker warm-reopens exact hits and
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
 * class-1 storage. Deliberately construction-only: the WORKER is the sole
 * deep-validation authority at its trust boundary (an invalid manifest comes
 * back as a typed REQUEST_INVALID, never a durable write).
 */
export function manifestForSave(project: CurrentProject): ProjectManifestV2 {
  if (project.kind === 'builtin') throw new ReadOnlyProjectError();
  return { schema: 'texttrends/project/2', revision: project.baseRevision + 1, ...project.data };
}

/** Split a loaded durable manifest into a USER current project (its revision
 *  becomes the base revision). A loaded project is always the user arm. */
export function userProjectFromManifest(manifest: ProjectManifestV2): CurrentProject {
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
 * recipe hashes are recomputed once (memoize at the call site) and
 * verified against the fixture's asserted per-doc identities by
 * validateProjectManifest — so a recipe change surfaces as a test failure, not
 * a silently stale constant. The built-in is `availability: 'bundled'`:
 * byte misses are fetched from its URL, never persisted or reattached.
 */
export async function buildBuiltinProjectData(
  id: string,
  sourceDirectory: BuiltinCorpusOption['sourceDirectory'],
  docs: readonly BuiltinDocFixture[],
): Promise<ProjectDataV1> {
  const { txt } = await defaultExtractionRecipes();
  const [extractionRecipeHash, indexRecipeHash] = await Promise.all([
    hashExtractionRecipe(txt),
    hashIndexRecipe(DEFAULT_INDEX_RECIPE),
  ]);
  const projectDocs: ProjectDocV1[] = docs.map((d) => ({
    doc: d.doc,
    sourceName: `${sourceDirectory}/${d.doc}`,
    meta: { title: d.title, language: 'en', tags: [] },
    source: { kind: 'text', hash: d.sourceHash, byteLength: d.bytes, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
    sourceAvailability: 'bundled',
    extraction: { recipe: txt as ExtractionRecipeProvisional, recipeHash: extractionRecipeHash, text: d.textHash, textLengthUtf16: d.textLengthUtf16 },
  }));
  return {
    id,
    order: projectDocs.map((d) => d.doc),
    docs: projectDocs,
    indexRecipe: DEFAULT_INDEX_RECIPE,
    indexRecipeHash,
  };
}

/** Manifest with the exact staged LF byte lengths and FULL content hashes —
 *  a 200-with-HTML-shell response must never be indexed as a book, and a
 *  fixture compares every entry against the shipped assets (round 2: the
 *  first manifest carried pre-normalization CRLF sizes and rejected all six).
 *
 *  `sourceHash` (SHA-256 of the exact bytes) and `textHash` (hashText of the
 *  decoded text) are DISTINCT identities (§12.4): for these UTF-8 files with no
 *  ill-formed sequences the two values coincide, and the fixture asserts each
 *  independently plus the coincidence — but the two fields carry different
 *  meanings so a future BOM/1252/transform file can diverge without a data-model
 *  change, and a TextHash can never be routed into a source/extraction key. The
 *  hashes are the authoritative warm-reopen identities the worker rehydrates
 *  against; a mutable doc-label → hash cache must never outrank this manifest. */
export const SHERLOCK: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - A Study in Scarlet - Arthur Conan Doyle', title: 'A Study in Scarlet', bytes: 243457, textLengthUtf16: 238367, sourceHash: '9a8fb27682b3c441f5ae94133bec243338cf33604c231cbbfbf9dc939cd90b4a', textHash: '9a8fb27682b3c441f5ae94133bec243338cf33604c231cbbfbf9dc939cd90b4a' },
  { doc: '2 - The Sign of the Four - Arthur Conan Doyle', title: 'The Sign of the Four', bytes: 236437, textLengthUtf16: 231255, sourceHash: '6aaf169211a16d024b6144074586d0ca32b6a27fcc2d2df26bfed512dc593e1a', textHash: '6aaf169211a16d024b6144074586d0ca32b6a27fcc2d2df26bfed512dc593e1a' },
  { doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle', title: 'The Adventures of Sherlock Holmes', bytes: 576164, textLengthUtf16: 561275, sourceHash: '768d3d31e334e7138acc2e302fe390cd35115c3cd2db0a08fbc7884182cb467e', textHash: '768d3d31e334e7138acc2e302fe390cd35115c3cd2db0a08fbc7884182cb467e' },
  { doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle', title: 'The Memoirs of Sherlock Holmes', bytes: 527990, textLengthUtf16: 514316, sourceHash: '8bf2ce1dbbc0af0db330e06177225af94cb241fce9f13d848f5786f9405bd97d', textHash: '8bf2ce1dbbc0af0db330e06177225af94cb241fce9f13d848f5786f9405bd97d' },
  { doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle', title: 'The Hound of the Baskervilles', bytes: 324763, textLengthUtf16: 317491, sourceHash: 'a35d4fb37d632ea347e4d38545b8394265415b2ebd7ec6de80f2eb1e6563ca02', textHash: 'a35d4fb37d632ea347e4d38545b8394265415b2ebd7ec6de80f2eb1e6563ca02' },
  { doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle', title: 'The Return of Sherlock Holmes', bytes: 623869, textLengthUtf16: 609845, sourceHash: '939525ae69ffadc5c545ca9249007b31099ca225582d0187809c0f2d0476200b', textHash: '939525ae69ffadc5c545ca9249007b31099ca225582d0187809c0f2d0476200b' },
];

export const ASOIF: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - A Game of Thrones - George R. R. Martin', title: 'A Game of Thrones', bytes: 1589135, textLengthUtf16: 1589135, sourceHash: '0c18548fd97bc83cf9c6e62c73443595b002e1babeccc60888df0aec5bb858ef', textHash: '0c18548fd97bc83cf9c6e62c73443595b002e1babeccc60888df0aec5bb858ef' },
  { doc: '2 - A Clash of Kings - George R. R. Martin', title: 'A Clash of Kings', bytes: 1732896, textLengthUtf16: 1732892, sourceHash: 'f6f3816664d419adf436b25837d2cf172da028c4fb3423e66c9627ff683ddfe6', textHash: 'f6f3816664d419adf436b25837d2cf172da028c4fb3423e66c9627ff683ddfe6' },
  { doc: '3 - A Storm of Swords - George R. R. Martin', title: 'A Storm of Swords', bytes: 2248306, textLengthUtf16: 2248306, sourceHash: 'df415ab2967ebcd7b298ff2a2b8187fef092c46b4b0c90acafa83e0280b2bfcb', textHash: 'df415ab2967ebcd7b298ff2a2b8187fef092c46b4b0c90acafa83e0280b2bfcb' },
  { doc: '4 - A Feast for Crows - George R. R. Martin', title: 'A Feast for Crows', bytes: 1600851, textLengthUtf16: 1600641, sourceHash: 'ec71a2cd3a869748015b1b25c88ac245b1d29389ad6aea971a4de6b05418b7a8', textHash: 'ec71a2cd3a869748015b1b25c88ac245b1d29389ad6aea971a4de6b05418b7a8' },
  { doc: '5 - A Dance with Dragons - George R. R. Martin', title: 'A Dance with Dragons', bytes: 2261026, textLengthUtf16: 2260424, sourceHash: '9a5731820527226336b49549c9643f702e7123fa52c87878cf68de83901d6039', textHash: '9a5731820527226336b49549c9643f702e7123fa52c87878cf68de83901d6039' },
];

export const LOTR: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - The Fellowship of the Ring - J. R. R. Tolkien', title: 'The Fellowship of the Ring', bytes: 1000126, textLengthUtf16: 994303, sourceHash: 'a32d1b2c8a487b614ca4a1367261a976af4e3618810122893025ff13b09a0450', textHash: 'a32d1b2c8a487b614ca4a1367261a976af4e3618810122893025ff13b09a0450' },
  { doc: '2 - The Two Towers - J. R. R. Tolkien', title: 'The Two Towers', bytes: 817956, textLengthUtf16: 817178, sourceHash: '2ca2c50996b260524c3ce2670177e82b577fc04785883627f51a543b94b2f747', textHash: '2ca2c50996b260524c3ce2670177e82b577fc04785883627f51a543b94b2f747' },
  { doc: '3 - The Return of the King - J. R. R. Tolkien', title: 'The Return of the King', bytes: 723615, textLengthUtf16: 709748, sourceHash: '96cad064a56aa3cd67f47d59b3c10e856fe6717ab293524beaad8f88d1e617c2', textHash: '96cad064a56aa3cd67f47d59b3c10e856fe6717ab293524beaad8f88d1e617c2' },
];

/** Bundled corpora as read-only `ProjectDataV1` values, each built ONCE (the
 *  recipe and empty-candidate hashes are corpus-wide constants). One project
 *  abstraction drives every origin; Sherlock is simply the initial selection.
 *  The composition root (`store-instance.ts`) awaits the registry to construct
 *  the session's initial `CurrentProject`. Lives HERE with the rest of the
 *  built-in vocabulary — the state container is not the authority for assets. */
const FIXTURES: Readonly<Record<BuiltinCorpusId, readonly BuiltinDocFixture[]>> = {
  [BUILTIN_SHERLOCK_ID]: SHERLOCK,
  [BUILTIN_ASOIF_ID]: ASOIF,
  [BUILTIN_LOTR_ID]: LOTR,
};

const builtinData = new Map<BuiltinCorpusId, Promise<ProjectDataV1>>();

export function builtinProjectData(id: BuiltinCorpusId): Promise<ProjectDataV1> {
  let data = builtinData.get(id);
  if (data === undefined) {
    const option = builtinCorpusOption(id);
    if (option === undefined) throw new RangeError(`unknown built-in corpus '${id}'`);
    data = buildBuiltinProjectData(id, option.sourceDirectory, FIXTURES[id]);
    builtinData.set(id, data);
  }
  return data;
}

export function sherlockProjectData(): Promise<ProjectDataV1> {
  return builtinProjectData(BUILTIN_SHERLOCK_ID);
}

export async function builtinProjectRegistry(): Promise<ReadonlyMap<BuiltinCorpusId, ProjectDataV1>> {
  const entries = await Promise.all(
    BUILTIN_CORPORA.map(async ({ id }) => [id, await builtinProjectData(id)] as const),
  );
  return new Map(entries);
}
