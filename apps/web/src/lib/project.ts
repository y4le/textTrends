/**
 * Runtime corpus descriptions. Durable intent lives in WorkspaceV1 and source
 * bytes live in the browser library; this module only derives worker inputs and
 * the bundled demo fixtures. Warm text identity is a verified cache hint, not
 * source truth.
 */

import {
  DEFAULT_INDEX_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  reconcileWorkspaceDocuments,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  type ExtractionRecipeProvisional,
  type IndexRecipeProvisional,
  type SourceFormat,
  type WorkspaceDocumentMetaV1,
  type WorkspaceV1,
} from '@texttrends/core';
import type { GenerationDocSpecV4 } from '../shared/analysis-contract.ts';

/** The file-input `accept` attribute — every supported source extension, derived
 *  from the core format catalog so it can never drift from what import accepts. */
export const SOURCE_FILE_ACCEPT: string = SOURCE_FORMAT_IDS.flatMap((f) => SOURCE_FORMATS[f].extensions).join(',');

export interface ProjectDocV1 {
  readonly doc: string;
  readonly sourceName: string;
  readonly library?: string;
  readonly meta: WorkspaceDocumentMetaV1;
  readonly source: {
    readonly hash: string;
    readonly byteLength: number;
    readonly format: SourceFormat;
  };
  readonly sourceAvailability: 'bundled' | 'library';
  readonly extraction: {
    readonly recipe: ExtractionRecipeProvisional;
    readonly recipeHash: string;
    readonly text?: string;
    readonly textLengthUtf16?: number;
  };
}

export interface ProjectDataV1 {
  readonly id: string;
  readonly order: readonly string[];
  readonly docs: readonly ProjectDocV1[];
  readonly indexRecipe: IndexRecipeProvisional;
  readonly indexRecipeHash: string;
}

/**
 * One current corpus with an explicit byte origin. Both arms are durable as
 * workspace intent; only the built-in source bytes live outside the library.
 */
export type CurrentProject =
  | { readonly kind: 'builtin'; readonly data: ProjectDataV1 }
  | { readonly kind: 'library'; readonly data: ProjectDataV1 };

/** The read-only built-in current project. */
export function builtinProject(data: ProjectDataV1): CurrentProject {
  return { kind: 'builtin', data };
}

/** Stable ids for the read-only bundled corpora. */
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

export const LIBRARY_PROJECT_ID = 'library';

/**
 * The ONE generation-spec builder, shared by every project origin. It maps the
 * working copy's documents to `GenerationDocSpecV4` in DECLARED (`order`) order,
 * carrying each doc's recipe values + recomputed-hash assertions and expected
 * source/text identities so the worker warm-reopens exact hits and
 * cold-ingests only genuine misses. A doc named in `order` but absent from
 * `docs` is a malformed runtime corpus and surfaces as an error, not a silent
 * drop.
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
      },
      extraction: {
        recipe: doc.extraction.recipe,
        recipeHash: doc.extraction.recipeHash,
        ...(doc.extraction.text === undefined ? {} : { expectedText: doc.extraction.text }),
        ...(doc.extraction.textLengthUtf16 === undefined
          ? {}
          : { expectedTextLengthUtf16: doc.extraction.textLengthUtf16 }),
      },
    };
  });
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
 * checked against the fixture's asserted per-doc identities, so a recipe
 * change surfaces as a test failure, not a silently stale constant. Bundled
 * byte misses are fetched from the corpus URL.
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
    source: { hash: d.sourceHash, byteLength: d.bytes, format: 'txt' },
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

export interface LibrarySourceInfo {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly format: SourceFormat;
  readonly contentHash: string;
}

export interface ReconciledLibraryWorkspace {
  readonly workspace: WorkspaceV1;
  readonly removedDocuments: readonly string[];
}

/** Drop documents whose source no longer exists, then clear view references
 * to the departed documents. The result can be written before analysis opens. */
export function reconcileLibraryWorkspace(
  workspace: WorkspaceV1,
  availableLibrary: ReadonlySet<string>,
): ReconciledLibraryWorkspace {
  if (workspace.corpus.kind !== 'library') return { workspace, removedDocuments: [] };
  const docs = workspace.corpus.docs.filter((doc) => availableLibrary.has(doc.library));
  const availableDocuments = new Set(docs.map((doc) => doc.doc));
  const removedDocuments = workspace.corpus.order.filter((doc) => !availableDocuments.has(doc));
  if (removedDocuments.length === 0) return { workspace, removedDocuments };
  const corpus = {
    kind: 'library' as const,
    order: workspace.corpus.order.filter((doc) => availableDocuments.has(doc)),
    docs,
  };
  return {
    workspace: reconcileWorkspaceDocuments({ ...workspace, corpus }, availableDocuments),
    removedDocuments,
  };
}

/** Build runtime worker inputs from workspace references and the current
 * library catalog. Missing references are refused rather than papered over. */
export async function libraryProject(
  workspace: WorkspaceV1,
  sources: ReadonlyMap<string, LibrarySourceInfo>,
): Promise<CurrentProject> {
  if (workspace.corpus.kind !== 'library') {
    throw new RangeError('a library project requires a library-backed workspace');
  }
  const recipes = await defaultExtractionRecipes();
  const [indexRecipeHash, recipeHashes] = await Promise.all([
    hashIndexRecipe(DEFAULT_INDEX_RECIPE),
    Promise.all(SOURCE_FORMAT_IDS.map((format) => hashExtractionRecipe(recipes[format]))),
  ]);
  const hashByFormat = new Map(
    SOURCE_FORMAT_IDS.map((format, index) => [format, recipeHashes[index]!]),
  );
  const workspaceDocs = new Map(workspace.corpus.docs.map((doc) => [doc.doc, doc]));
  const docs = workspace.corpus.order.map((docId): ProjectDocV1 => {
    const saved = workspaceDocs.get(docId);
    if (saved === undefined) throw new RangeError(`workspace order names missing document '${docId}'`);
    const source = sources.get(saved.library);
    if (source === undefined) throw new RangeError(`workspace source '${saved.library}' is missing`);
    return {
      doc: saved.doc,
      sourceName: source.name,
      library: source.id,
      meta: saved.meta,
      source: {
        hash: source.contentHash,
        byteLength: source.size,
        format: source.format,
      },
      sourceAvailability: 'library',
      extraction: {
        recipe: recipes[source.format],
        recipeHash: hashByFormat.get(source.format)!,
        ...(saved.warm === undefined ? {} : {
          text: saved.warm.textHash,
          textLengthUtf16: saved.warm.textLengthUtf16,
        }),
      },
    };
  });
  return {
    kind: 'library',
    data: {
      id: 'library',
      order: workspace.corpus.order,
      docs,
      indexRecipe: DEFAULT_INDEX_RECIPE,
      indexRecipeHash,
    },
  };
}

/** Built-in fixtures with exact staged LF byte lengths and full content hashes —
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
 *  hashes are the authoritative warm-reopen identities the worker verifies. */
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
