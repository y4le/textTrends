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
export const BUILTIN_AUSTEN_ID = 'builtin/austen';
export const BUILTIN_BIBLE_ID = 'builtin/bible';
export const BUILTIN_QURAN_ID = 'builtin/quran';
export const BUILTIN_POLITICAL_ARGUMENTS_ID = 'builtin/political-arguments';
export const BUILTIN_SHAKESPEARE_ID = 'builtin/shakespeare';
export const BUILTIN_INAUGURALS_ID = 'builtin/inaugurals';
export const BUILTIN_DARWIN_ORIGIN_ID = 'builtin/darwin-origin';
export const BUILTIN_CLASSIC_NOVELS_ID = 'builtin/classic-novels';
export const BUILTIN_ASOIF_ID = 'builtin/asoif';
export const BUILTIN_LOTR_ID = 'builtin/lotr';

export type BuiltinCorpusId =
  | typeof BUILTIN_SHERLOCK_ID
  | typeof BUILTIN_AUSTEN_ID
  | typeof BUILTIN_BIBLE_ID
  | typeof BUILTIN_QURAN_ID
  | typeof BUILTIN_POLITICAL_ARGUMENTS_ID
  | typeof BUILTIN_SHAKESPEARE_ID
  | typeof BUILTIN_INAUGURALS_ID
  | typeof BUILTIN_DARWIN_ORIGIN_ID
  | typeof BUILTIN_CLASSIC_NOVELS_ID
  | typeof BUILTIN_ASOIF_ID
  | typeof BUILTIN_LOTR_ID;

export interface BuiltinCorpusOption {
  readonly id: BuiltinCorpusId;
  readonly sourceDirectory:
    | 'sherlock'
    | 'austen'
    | 'bible'
    | 'quran'
    | 'political-arguments'
    | 'shakespeare'
    | 'inaugurals'
    | 'darwin-origin'
    | 'standard-ebooks'
    | 'asoif'
    | 'lotr';
  readonly label: string;
  readonly shortLabel: string;
  readonly defaultTerms: string;
}

/** Presentation + bootstrap vocabulary for the bundled demo picker. */
export const BUILTIN_CORPORA: readonly BuiltinCorpusOption[] = [
  { id: BUILTIN_SHERLOCK_ID, sourceDirectory: 'sherlock', label: 'Sherlock Holmes', shortLabel: 'Sherlock', defaultTerms: 'Holmes, Watson, Moriarty' },
  { id: BUILTIN_AUSTEN_ID, sourceDirectory: 'austen', label: 'Jane Austen', shortLabel: 'Austen', defaultTerms: 'family, friend, heart' },
  { id: BUILTIN_BIBLE_ID, sourceDirectory: 'bible', label: 'World English Bible', shortLabel: 'Bible', defaultTerms: 'God, Israel, Jesus' },
  { id: BUILTIN_QURAN_ID, sourceDirectory: 'quran', label: 'Quran — Pickthall translation', shortLabel: 'Quran', defaultTerms: 'Allah, mercy, believe' },
  { id: BUILTIN_POLITICAL_ARGUMENTS_ID, sourceDirectory: 'political-arguments', label: 'Political Arguments', shortLabel: 'Arguments', defaultTerms: 'liberty, property, class' },
  { id: BUILTIN_SHAKESPEARE_ID, sourceDirectory: 'shakespeare', label: 'Shakespeare', shortLabel: 'Shakespeare', defaultTerms: 'thou, thee, you' },
  { id: BUILTIN_INAUGURALS_ID, sourceDirectory: 'inaugurals', label: 'U.S. Inaugural Addresses', shortLabel: 'Inaugurals', defaultTerms: 'union, war, freedom' },
  { id: BUILTIN_DARWIN_ORIGIN_ID, sourceDirectory: 'darwin-origin', label: 'Origin of Species Editions', shortLabel: 'Darwin', defaultTerms: 'evolution, selection, variation' },
  { id: BUILTIN_CLASSIC_NOVELS_ID, sourceDirectory: 'standard-ebooks', label: 'Classic Novels', shortLabel: 'Classics', defaultTerms: 'she, he, God' },
  { id: BUILTIN_ASOIF_ID, sourceDirectory: 'asoif', label: 'A Song of Ice and Fire', shortLabel: 'ASOIF', defaultTerms: 'Jon, Tyrion, Daenerys' },
  { id: BUILTIN_LOTR_ID, sourceDirectory: 'lotr', label: 'The Lord of the Rings', shortLabel: 'LOTR', defaultTerms: 'Frodo, Gandalf, Sauron' },
];

/** Public, rights-documented samples shown in the ordinary Inputs picker. */
export const FEATURED_DEMO_IDS: readonly BuiltinCorpusId[] = [
  BUILTIN_SHERLOCK_ID,
  BUILTIN_AUSTEN_ID,
  BUILTIN_BIBLE_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_POLITICAL_ARGUMENTS_ID,
  BUILTIN_SHAKESPEARE_ID,
  BUILTIN_INAUGURALS_ID,
  BUILTIN_DARWIN_ORIGIN_ID,
  BUILTIN_CLASSIC_NOVELS_ID,
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
  { doc: '7 - The Valley of Fear - Arthur Conan Doyle', title: 'The Valley of Fear', bytes: 321508, textLengthUtf16: 311799, sourceHash: '06918557d08ee549aca789a1e46cb8c665132867eb305493d2192c3133c606bb', textHash: '06918557d08ee549aca789a1e46cb8c665132867eb305493d2192c3133c606bb' },
  { doc: '8 - His Last Bow - Arthur Conan Doyle', title: 'His Last Bow', bytes: 330484, textLengthUtf16: 322578, sourceHash: 'aadb73104b66d16d920cf88ed5b38e1fb8d4abf0b7414e6e648839ce7e11ef65', textHash: 'aadb73104b66d16d920cf88ed5b38e1fb8d4abf0b7414e6e648839ce7e11ef65' },
  { doc: '9 - The Casebook of Sherlock Holmes - Arthur Conan Doyle', title: 'The Casebook of Sherlock Holmes', bytes: 455606, textLengthUtf16: 443018, sourceHash: '34f47c8cc14133b9cab96bc0621a45c1f7a3aafb443cdbc377a58ccefc2efab1', textHash: '34f47c8cc14133b9cab96bc0621a45c1f7a3aafb443cdbc377a58ccefc2efab1' },
];

export const AUSTEN: readonly { doc: string; title: string; bytes: number; textLengthUtf16: number; sourceHash: string; textHash: string }[] = [
  { doc: '1 - Sense and Sensibility - Jane Austen', title: 'Sense and Sensibility', bytes: 680078, textLengthUtf16: 668537, sourceHash: '28af5a66ce42d4404597b69a0515b898b135d1a62002b356a3903cfc6870f3cd', textHash: '28af5a66ce42d4404597b69a0515b898b135d1a62002b356a3903cfc6870f3cd' },
  { doc: '2 - Pride and Prejudice - Jane Austen', title: 'Pride and Prejudice', bytes: 695888, textLengthUtf16: 684097, sourceHash: '40c27855a8dc3ba6db2a7d9c819902ce538d4be1f5c69d81c693cbc912774545', textHash: '40c27855a8dc3ba6db2a7d9c819902ce538d4be1f5c69d81c693cbc912774545' },
  { doc: '3 - Mansfield Park - Jane Austen', title: 'Mansfield Park', bytes: 893089, textLengthUtf16: 881543, sourceHash: '35b87fc0d15ca145478655dd54022b3b0471d12b7b95a3437d41c0eb40ac057c', textHash: '35b87fc0d15ca145478655dd54022b3b0471d12b7b95a3437d41c0eb40ac057c' },
  { doc: '4 - Emma - Jane Austen', title: 'Emma', bytes: 905802, textLengthUtf16: 880580, sourceHash: '3b62bf84995b427381cdb2537deb71125320c2dad9ed36ccda29aaec69f350e6', textHash: '3b62bf84995b427381cdb2537deb71125320c2dad9ed36ccda29aaec69f350e6' },
  { doc: '5 - Northanger Abbey - Jane Austen', title: 'Northanger Abbey', bytes: 438994, textLengthUtf16: 431617, sourceHash: '2cc65a0d9e39ea4f4cf5ee52675db1b76a3c3c882477800762552a7637a0350b', textHash: '2cc65a0d9e39ea4f4cf5ee52675db1b76a3c3c882477800762552a7637a0350b' },
  { doc: '6 - Persuasion - Jane Austen', title: 'Persuasion', bytes: 470176, textLengthUtf16: 464737, sourceHash: '86336fa710a623600f88e0e4a4a1bc25ec8363f47c651b1d0e4834d8033979f3', textHash: '86336fa710a623600f88e0e4a4a1bc25ec8363f47c651b1d0e4834d8033979f3' },
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

export const BIBLE: readonly BuiltinDocFixture[] = [
  { doc: '001 - Genesis - World English Bible', title: 'Genesis', bytes: 191711, textLengthUtf16: 188265, sourceHash: '2a5393451e479c1c1b1893b594221c9a3a6cc44d6539ff3cda8d2600eebbeeb5', textHash: '2a5393451e479c1c1b1893b594221c9a3a6cc44d6539ff3cda8d2600eebbeeb5' },
  { doc: '002 - Exodus - World English Bible', title: 'Exodus', bytes: 163483, textLengthUtf16: 161571, sourceHash: 'b7ca8130e0e47e0557695d3453c49007ab35e841d0c1cd946c861e6832722c16', textHash: 'b7ca8130e0e47e0557695d3453c49007ab35e841d0c1cd946c861e6832722c16' },
  { doc: '003 - Leviticus - World English Bible', title: 'Leviticus', bytes: 123308, textLengthUtf16: 121894, sourceHash: '1da63ef7430443c8b8c6957f4bba9243a77dc2a2a4223862dea4467f99c25f36', textHash: '1da63ef7430443c8b8c6957f4bba9243a77dc2a2a4223862dea4467f99c25f36' },
  { doc: '004 - Numbers - World English Bible', title: 'Numbers', bytes: 169239, textLengthUtf16: 167617, sourceHash: '35b41b95c6953ed9bb25ce66bc7da4a79188b0b7a8a2f82399e0a62ebadb90d3', textHash: '35b41b95c6953ed9bb25ce66bc7da4a79188b0b7a8a2f82399e0a62ebadb90d3' },
  { doc: '005 - Deuteronomy - World English Bible', title: 'Deuteronomy', bytes: 142248, textLengthUtf16: 141192, sourceHash: 'aa7d7f9166879ddb8ebb649caf3236387f3a75757ea11fe64bbebc90fdcb7ede', textHash: 'aa7d7f9166879ddb8ebb649caf3236387f3a75757ea11fe64bbebc90fdcb7ede' },
  { doc: '006 - Joshua - World English Bible', title: 'Joshua', bytes: 96636, textLengthUtf16: 95876, sourceHash: '53870e4b729019c984eb36586f68813236f8b38dbf54fc813bf10a11ae3d7a50', textHash: '53870e4b729019c984eb36586f68813236f8b38dbf54fc813bf10a11ae3d7a50' },
  { doc: '007 - Judges - World English Bible', title: 'Judges', bytes: 95935, textLengthUtf16: 94423, sourceHash: '64aeae58245c0492939fd34e933effa7ee7b146c4e0ecbee5cfda9ce4880bfcd', textHash: '64aeae58245c0492939fd34e933effa7ee7b146c4e0ecbee5cfda9ce4880bfcd' },
  { doc: '008 - Ruth - World English Bible', title: 'Ruth', bytes: 12927, textLengthUtf16: 12673, sourceHash: 'cabf8de30090cccc392c0f86bbe518a05a6d1236131ba30ef67906352c99ffde', textHash: 'cabf8de30090cccc392c0f86bbe518a05a6d1236131ba30ef67906352c99ffde' },
  { doc: '009 - 1 Samuel - World English Bible', title: '1 Samuel', bytes: 126051, textLengthUtf16: 123767, sourceHash: '7b7d26deedc3c50ab57025b698c94cb599e630f70154e0834d8be0c6764ba964', textHash: '7b7d26deedc3c50ab57025b698c94cb599e630f70154e0834d8be0c6764ba964' },
  { doc: '010 - 2 Samuel - World English Bible', title: '2 Samuel', bytes: 103666, textLengthUtf16: 101812, sourceHash: '9a619e373a99b1f326a1d123f25e1f9b2e2bd1564006212a39b8ade68e0598d5', textHash: '9a619e373a99b1f326a1d123f25e1f9b2e2bd1564006212a39b8ade68e0598d5' },
  { doc: '011 - 1 Kings - World English Bible', title: '1 Kings', bytes: 122901, textLengthUtf16: 121033, sourceHash: '5e7b27c5dcc9dbf84fc6710b686807b70b808d1da757806f0ef980d0ea88172e', textHash: '5e7b27c5dcc9dbf84fc6710b686807b70b808d1da757806f0ef980d0ea88172e' },
  { doc: '012 - 2 Kings - World English Bible', title: '2 Kings', bytes: 118337, textLengthUtf16: 116231, sourceHash: '58a835b70a3b1980e3d4333617964b603a59796c0f38e524b91e0a54b6c6e1c6', textHash: '58a835b70a3b1980e3d4333617964b603a59796c0f38e524b91e0a54b6c6e1c6' },
  { doc: '013 - 1 Chronicles - World English Bible', title: '1 Chronicles', bytes: 107960, textLengthUtf16: 107252, sourceHash: 'f734cb8571285073798fca21a542aa16a32035bc3b2cc12969541657b0db1ac7', textHash: 'f734cb8571285073798fca21a542aa16a32035bc3b2cc12969541657b0db1ac7' },
  { doc: '014 - 2 Chronicles - World English Bible', title: '2 Chronicles', bytes: 135982, textLengthUtf16: 134596, sourceHash: '6258bebe44cecda1948fe4183a10b8c2dd3325ad1c0fb01c0cc7d00fe864a3d1', textHash: '6258bebe44cecda1948fe4183a10b8c2dd3325ad1c0fb01c0cc7d00fe864a3d1' },
  { doc: '015 - Ezra - World English Bible', title: 'Ezra', bytes: 39363, textLengthUtf16: 39163, sourceHash: 'a3fc48e454f2eb99da66b9f391b7e2c8aa8fb4c511f8474e969375d61970e732', textHash: 'a3fc48e454f2eb99da66b9f391b7e2c8aa8fb4c511f8474e969375d61970e732' },
  { doc: '016 - Nehemiah - World English Bible', title: 'Nehemiah', bytes: 55805, textLengthUtf16: 55387, sourceHash: '9870b868ddcb1e1fe683b4441014831949cbfbf1e49f0a2c1413e8e3470f8172', textHash: '9870b868ddcb1e1fe683b4441014831949cbfbf1e49f0a2c1413e8e3470f8172' },
  { doc: '017 - Esther - World English Bible', title: 'Esther', bytes: 29683, textLengthUtf16: 29283, sourceHash: '6579d7e12421ba17c17992bdffe8951bfec0a8f29137bae6585e6dc5c623ee3f', textHash: '6579d7e12421ba17c17992bdffe8951bfec0a8f29137bae6585e6dc5c623ee3f' },
  { doc: '018 - Job - World English Bible', title: 'Job', bytes: 92879, textLengthUtf16: 91879, sourceHash: 'c8a4598d64f578e759a1d60840e68c775a2c67aa0e05968d52b7276f5294fe7b', textHash: 'c8a4598d64f578e759a1d60840e68c775a2c67aa0e05968d52b7276f5294fe7b' },
  { doc: '019 - Psalms - World English Bible', title: 'Psalms', bytes: 225437, textLengthUtf16: 224017, sourceHash: 'd45559560177fd5eabc00ae70ce3528ad4703de11f1fd3dc2c6a354def6924ec', textHash: 'd45559560177fd5eabc00ae70ce3528ad4703de11f1fd3dc2c6a354def6924ec' },
  { doc: '020 - Proverbs - World English Bible', title: 'Proverbs', bytes: 78210, textLengthUtf16: 77586, sourceHash: '4750deaaaee147ed62950c7c83ae46372a275901ac8fe31cde0368972b1c8425', textHash: '4750deaaaee147ed62950c7c83ae46372a275901ac8fe31cde0368972b1c8425' },
  { doc: '021 - Ecclesiastes - World English Bible', title: 'Ecclesiastes', bytes: 28183, textLengthUtf16: 27967, sourceHash: '651eb2abe9343884073d4ae9890b60d512f938d1c0873712711237fe86f3d2e8', textHash: '651eb2abe9343884073d4ae9890b60d512f938d1c0873712711237fe86f3d2e8' },
  { doc: '022 - Song of Solomon - World English Bible', title: 'Song of Solomon', bytes: 13627, textLengthUtf16: 13555, sourceHash: 'eb05f00a8a33a68121af922f746c9eba2992bbf868b85a1ba9da69d20a7a68e2', textHash: 'eb05f00a8a33a68121af922f746c9eba2992bbf868b85a1ba9da69d20a7a68e2' },
  { doc: '023 - Isaiah - World English Bible', title: 'Isaiah', bytes: 190278, textLengthUtf16: 188200, sourceHash: 'df89fd505fb46b67cb6a95f5e38f0711321c384da2e51b370b3c31be4b6e7cf1', textHash: 'df89fd505fb46b67cb6a95f5e38f0711321c384da2e51b370b3c31be4b6e7cf1' },
  { doc: '024 - Jeremiah - World English Bible', title: 'Jeremiah', bytes: 221719, textLengthUtf16: 217811, sourceHash: '4af0be96060a8f44d9a4351be98a396c0765a19d1f42d0e46b8dd57e0366b842', textHash: '4af0be96060a8f44d9a4351be98a396c0765a19d1f42d0e46b8dd57e0366b842' },
  { doc: '025 - Lamentations - World English Bible', title: 'Lamentations', bytes: 18163, textLengthUtf16: 18021, sourceHash: 'ace4bafb11632e929cf695ac9d78bb0a8e90ae844c640a5c6d67a81c6e2b882b', textHash: 'ace4bafb11632e929cf695ac9d78bb0a8e90ae844c640a5c6d67a81c6e2b882b' },
  { doc: '026 - Ezekiel - World English Bible', title: 'Ezekiel', bytes: 200766, textLengthUtf16: 197692, sourceHash: 'd9f606418fa140a255d598a39bcb39257d0bf4c5e301b2a2ae7536ad35672ebb', textHash: 'd9f606418fa140a255d598a39bcb39257d0bf4c5e301b2a2ae7536ad35672ebb' },
  { doc: '027 - Daniel - World English Bible', title: 'Daniel', bytes: 60979, textLengthUtf16: 60407, sourceHash: 'aefcadeba15a3d8089e292f501a79099c9bd8307e75de97bf9e19304446a3a46', textHash: 'aefcadeba15a3d8089e292f501a79099c9bd8307e75de97bf9e19304446a3a46' },
  { doc: '028 - Hosea - World English Bible', title: 'Hosea', bytes: 27329, textLengthUtf16: 27065, sourceHash: '75a957e3ca7b5388a8fbd65d22e88cfa21b1f6f9129c7b559aee4805d636a2fb', textHash: '75a957e3ca7b5388a8fbd65d22e88cfa21b1f6f9129c7b559aee4805d636a2fb' },
  { doc: '029 - Joel - World English Bible', title: 'Joel', bytes: 10472, textLengthUtf16: 10398, sourceHash: '331bb0c6aec6da7329fbd08941015a53f2583ec0d4a3675e15d3a0582500bd84', textHash: '331bb0c6aec6da7329fbd08941015a53f2583ec0d4a3675e15d3a0582500bd84' },
  { doc: '030 - Amos - World English Bible', title: 'Amos', bytes: 21558, textLengthUtf16: 21192, sourceHash: 'a20855d725f316c40687f8c543070cb80afb09b1ebd29a5f73a76f500ded85de', textHash: 'a20855d725f316c40687f8c543070cb80afb09b1ebd29a5f73a76f500ded85de' },
  { doc: '031 - Obadiah - World English Bible', title: 'Obadiah', bytes: 3364, textLengthUtf16: 3316, sourceHash: 'e1c704487f1ca82c70fc3a8e1896f38af680bf4951a9fe348fee75ffac031b10', textHash: 'e1c704487f1ca82c70fc3a8e1896f38af680bf4951a9fe348fee75ffac031b10' },
  { doc: '032 - Jonah - World English Bible', title: 'Jonah', bytes: 6635, textLengthUtf16: 6521, sourceHash: 'e7bca30c2f5f784f7dc5778e77f44a67e7f3d724dd449b6b35412a7cb8e6d47b', textHash: 'e7bca30c2f5f784f7dc5778e77f44a67e7f3d724dd449b6b35412a7cb8e6d47b' },
  { doc: '033 - Micah - World English Bible', title: 'Micah', bytes: 15800, textLengthUtf16: 15638, sourceHash: 'd70a52f91d2075db94e917a9638b5fe5a60b76f786dbe85d5a8930518f86ed29', textHash: 'd70a52f91d2075db94e917a9638b5fe5a60b76f786dbe85d5a8930518f86ed29' },
  { doc: '034 - Nahum - World English Bible', title: 'Nahum', bytes: 6600, textLengthUtf16: 6560, sourceHash: '5ea31ed78d9ee00250c167ff0604d45c10ad4efb83b1834156aa186ee3347b86', textHash: '5ea31ed78d9ee00250c167ff0604d45c10ad4efb83b1834156aa186ee3347b86' },
  { doc: '035 - Habakkuk - World English Bible', title: 'Habakkuk', bytes: 7496, textLengthUtf16: 7440, sourceHash: '7cc1e165a32b7a0869deaf1a8f9bf4c700aa48273a6b86b4bdb39480617cfd9b', textHash: '7cc1e165a32b7a0869deaf1a8f9bf4c700aa48273a6b86b4bdb39480617cfd9b' },
  { doc: '036 - Zephaniah - World English Bible', title: 'Zephaniah', bytes: 8397, textLengthUtf16: 8329, sourceHash: '2bb4b510e569ae80f1d18c8a8a5363478dee1ed97c985d1f38f46735c0114dd4', textHash: '2bb4b510e569ae80f1d18c8a8a5363478dee1ed97c985d1f38f46735c0114dd4' },
  { doc: '037 - Haggai - World English Bible', title: 'Haggai', bytes: 5728, textLengthUtf16: 5580, sourceHash: 'd6f907d4c0f75278d8bce5dabc12027f0d73132898d0920544029d7e159e8202', textHash: 'd6f907d4c0f75278d8bce5dabc12027f0d73132898d0920544029d7e159e8202' },
  { doc: '038 - Zechariah - World English Bible', title: 'Zechariah', bytes: 32217, textLengthUtf16: 31627, sourceHash: '7151b8e4b237cb7dc9a549634873ec25bdb2142e2dd05c2203849320f3f308f1', textHash: '7151b8e4b237cb7dc9a549634873ec25bdb2142e2dd05c2203849320f3f308f1' },
  { doc: '039 - Malachi - World English Bible', title: 'Malachi', bytes: 9295, textLengthUtf16: 9061, sourceHash: '2b9793539448b30f182a964307b291f206144b130cb328c9fd19992620597890', textHash: '2b9793539448b30f182a964307b291f206144b130cb328c9fd19992620597890' },
  { doc: '040 - Matthew - World English Bible', title: 'Matthew', bytes: 123750, textLengthUtf16: 121324, sourceHash: '3e8e03b1e0b14f01371ae752df3b532f39bf616451eec209ec382be7439e992a', textHash: '3e8e03b1e0b14f01371ae752df3b532f39bf616451eec209ec382be7439e992a' },
  { doc: '041 - Mark - World English Bible', title: 'Mark', bytes: 77412, textLengthUtf16: 75886, sourceHash: '524f3e4b854e438b5352ebde0aac670e9e42426f9e63a0be227d528b461d25a7', textHash: '524f3e4b854e438b5352ebde0aac670e9e42426f9e63a0be227d528b461d25a7' },
  { doc: '042 - Luke - World English Bible', title: 'Luke', bytes: 131121, textLengthUtf16: 128505, sourceHash: '7b50a0c285e45ebd72bb2a811d694a27584eb90ae1a8d0b60bf123d1ccefe1d6', textHash: '7b50a0c285e45ebd72bb2a811d694a27584eb90ae1a8d0b60bf123d1ccefe1d6' },
  { doc: '043 - John - World English Bible', title: 'John', bytes: 99327, textLengthUtf16: 96984, sourceHash: '20344930f5d5dac6109edafcfe538e23d35d5fb8b084745f6806b222f38f8acd', textHash: '20344930f5d5dac6109edafcfe538e23d35d5fb8b084745f6806b222f38f8acd' },
  { doc: '044 - Acts - World English Bible', title: 'Acts', bytes: 126694, textLengthUtf16: 125272, sourceHash: '9c93f7750f444c198cf3e5a2106a44cd45f059e9bebadf0dc611c107af56c372', textHash: '9c93f7750f444c198cf3e5a2106a44cd45f059e9bebadf0dc611c107af56c372' },
  { doc: '045 - Romans - World English Bible', title: 'Romans', bytes: 51031, textLengthUtf16: 50481, sourceHash: '55338193ae1624abf99d4600c92a333bc13a45ff4f646aad55333c263feccce5', textHash: '55338193ae1624abf99d4600c92a333bc13a45ff4f646aad55333c263feccce5' },
  { doc: '046 - 1 Corinthians - World English Bible', title: '1 Corinthians', bytes: 49756, textLengthUtf16: 49186, sourceHash: '1a827513a6a876cf383ac40206070e46557aea0e3bc012cd9fee63e498191ffd', textHash: '1a827513a6a876cf383ac40206070e46557aea0e3bc012cd9fee63e498191ffd' },
  { doc: '047 - 2 Corinthians - World English Bible', title: '2 Corinthians', bytes: 32591, textLengthUtf16: 32385, sourceHash: 'f1c2219fbb97fe802b71882d8b553b98e0bfe6ceed8065b7650ef4ce7f4ecb7b', textHash: 'f1c2219fbb97fe802b71882d8b553b98e0bfe6ceed8065b7650ef4ce7f4ecb7b' },
  { doc: '048 - Galatians - World English Bible', title: 'Galatians', bytes: 16704, textLengthUtf16: 16538, sourceHash: '8723f08c5a72d121c6ce9c212b73a584de90a1b83247b13c5b760191c15b818b', textHash: '8723f08c5a72d121c6ce9c212b73a584de90a1b83247b13c5b760191c15b818b' },
  { doc: '049 - Ephesians - World English Bible', title: 'Ephesians', bytes: 16653, textLengthUtf16: 16583, sourceHash: '8d70f08f643ddcc0029627d78e5fd497f36f1a072541cc01b862cbf0e47bac57', textHash: '8d70f08f643ddcc0029627d78e5fd497f36f1a072541cc01b862cbf0e47bac57' },
  { doc: '050 - Philippians - World English Bible', title: 'Philippians', bytes: 11767, textLengthUtf16: 11747, sourceHash: 'cd55eea0e3bc243c2730fd91b415a7548ebd0ecd83325b6598ee47c9b9bbeff3', textHash: 'cd55eea0e3bc243c2730fd91b415a7548ebd0ecd83325b6598ee47c9b9bbeff3' },
  { doc: '051 - Colossians - World English Bible', title: 'Colossians', bytes: 10915, textLengthUtf16: 10871, sourceHash: '19791a0fd9b08e981d00f00d1e57b549c2325bb1486103273c12313acf27016c', textHash: '19791a0fd9b08e981d00f00d1e57b549c2325bb1486103273c12313acf27016c' },
  { doc: '052 - 1 Thessalonians - World English Bible', title: '1 Thessalonians', bytes: 9863, textLengthUtf16: 9809, sourceHash: '8b27ac94acabc2880b0bd711cca0df26decb42d0964766cf2c1fdb24fed40c0b', textHash: '8b27ac94acabc2880b0bd711cca0df26decb42d0964766cf2c1fdb24fed40c0b' },
  { doc: '053 - 2 Thessalonians - World English Bible', title: '2 Thessalonians', bytes: 5591, textLengthUtf16: 5555, sourceHash: '9db77420fc86dfdff74797e3c99d943f7df154237f8afa18c837208158de3381', textHash: '9db77420fc86dfdff74797e3c99d943f7df154237f8afa18c837208158de3381' },
  { doc: '054 - 1 Timothy - World English Bible', title: '1 Timothy', bytes: 12955, textLengthUtf16: 12901, sourceHash: 'd2e071ad7cde3c78001e597a1cda77c3a406f31c1183db4f425d3885ac07c14e', textHash: 'd2e071ad7cde3c78001e597a1cda77c3a406f31c1183db4f425d3885ac07c14e' },
  { doc: '055 - 2 Timothy - World English Bible', title: '2 Timothy', bytes: 9055, textLengthUtf16: 9009, sourceHash: 'f0483d3765a2d6224a3c86431486efe24453a6f3e17c231fdb81a69c7ce38d9a', textHash: 'f0483d3765a2d6224a3c86431486efe24453a6f3e17c231fdb81a69c7ce38d9a' },
  { doc: '056 - Titus - World English Bible', title: 'Titus', bytes: 5272, textLengthUtf16: 5252, sourceHash: '9fcbb1c44cc10124e8b8309723f7a826f0d5d561bb4e08bc4fe9c6a7fd691a89', textHash: '9fcbb1c44cc10124e8b8309723f7a826f0d5d561bb4e08bc4fe9c6a7fd691a89' },
  { doc: '057 - Philemon - World English Bible', title: 'Philemon', bytes: 2335, textLengthUtf16: 2329, sourceHash: 'e12bf2e9bf3b35186002ac4bd815daab9d77da844e355e8e34b0694b3fa82bb2', textHash: 'e12bf2e9bf3b35186002ac4bd815daab9d77da844e355e8e34b0694b3fa82bb2' },
  { doc: '058 - Hebrews - World English Bible', title: 'Hebrews', bytes: 37942, textLengthUtf16: 37586, sourceHash: '5c7a3441c1200e6976c07703e20351a7742dcf0c3a3499a745edcdcd75ce8a30', textHash: '5c7a3441c1200e6976c07703e20351a7742dcf0c3a3499a745edcdcd75ce8a30' },
  { doc: '059 - James - World English Bible', title: 'James', bytes: 12164, textLengthUtf16: 12018, sourceHash: '6652e9528ee3c6fa9dcc8de789f7f422287a641adc938279c9352d1fc68d5bfb', textHash: '6652e9528ee3c6fa9dcc8de789f7f422287a641adc938279c9352d1fc68d5bfb' },
  { doc: '060 - 1 Peter - World English Bible', title: '1 Peter', bytes: 13444, textLengthUtf16: 13350, sourceHash: 'fdef70301403e1eac1ba5284359145432ded4a832202ed77c1f11196cd5c0120', textHash: 'fdef70301403e1eac1ba5284359145432ded4a832202ed77c1f11196cd5c0120' },
  { doc: '061 - 2 Peter - World English Bible', title: '2 Peter', bytes: 8613, textLengthUtf16: 8579, sourceHash: '9d54cbdcb34d5d994e46af8924b2f3e31e1e3aed0186b37c28ce2e477b8fe815', textHash: '9d54cbdcb34d5d994e46af8924b2f3e31e1e3aed0186b37c28ce2e477b8fe815' },
  { doc: '062 - 1 John - World English Bible', title: '1 John', bytes: 12692, textLengthUtf16: 12576, sourceHash: 'febd77d6fad96541595a946b50d3c8d81008830bc939c4e31c6ecdb1d171282d', textHash: 'febd77d6fad96541595a946b50d3c8d81008830bc939c4e31c6ecdb1d171282d' },
  { doc: '063 - 2 John - World English Bible', title: '2 John', bytes: 1602, textLengthUtf16: 1582, sourceHash: 'f0c9992163a7016d17dbbf5ac3ac114494ef6ed1ed3f40f90d2b9e274cb70473', textHash: 'f0c9992163a7016d17dbbf5ac3ac114494ef6ed1ed3f40f90d2b9e274cb70473' },
  { doc: '064 - 3 John - World English Bible', title: '3 John', bytes: 1581, textLengthUtf16: 1571, sourceHash: '70cda3afafcf1d8907f613ce145bbaf014da612a6379df9b2ba5a9756c73d167', textHash: '70cda3afafcf1d8907f613ce145bbaf014da612a6379df9b2ba5a9756c73d167' },
  { doc: '065 - Jude - World English Bible', title: 'Jude', bytes: 3543, textLengthUtf16: 3517, sourceHash: 'c5f7da97fd1bcbeeabd7e1a772f480bad1eb12eb7f558fd8be23151b2ff0427f', textHash: 'c5f7da97fd1bcbeeabd7e1a772f480bad1eb12eb7f558fd8be23151b2ff0427f' },
  { doc: '066 - Revelation - World English Bible', title: 'Revelation', bytes: 60220, textLengthUtf16: 59644, sourceHash: '5c91dc032a907e2b6d105c37aff16d0206bf8fd6512fdd919d83192924cecdf1', textHash: '5c91dc032a907e2b6d105c37aff16d0206bf8fd6512fdd919d83192924cecdf1' },
];

export const QURAN: readonly BuiltinDocFixture[] = [
  { doc: '001 - Al-Fatiha (The Opening) - Pickthall', title: 'Al-Fatiha (The Opening)', bytes: 376, textLengthUtf16: 376, sourceHash: '880fd4c9a3a293f9cd3e388d50c79b81d63033436b4f478b1e3da6e8b60e2724', textHash: '880fd4c9a3a293f9cd3e388d50c79b81d63033436b4f478b1e3da6e8b60e2724' },
  { doc: '002 - Al-Baqara (The Cow) - Pickthall', title: 'Al-Baqara (The Cow)', bytes: 65665, textLengthUtf16: 65665, sourceHash: 'c248da4502111557710ec7968ff2689e4ccbf5c2010d60b16e986edccdb30329', textHash: 'c248da4502111557710ec7968ff2689e4ccbf5c2010d60b16e986edccdb30329' },
  { doc: '003 - Al-E-Imran (The Family Of \'Imran, The House Of \'Imran) - Pickthall', title: 'Al-E-Imran (The Family Of \'Imran, The House Of \'Imran)', bytes: 37995, textLengthUtf16: 37995, sourceHash: '22f0ba1a7c0a7265c344d91c152c944f91aed3b5ceb9fdb35f885d0252503454', textHash: '22f0ba1a7c0a7265c344d91c152c944f91aed3b5ceb9fdb35f885d0252503454' },
  { doc: '004 - An-Nisa (Women) - Pickthall', title: 'An-Nisa (Women)', bytes: 39369, textLengthUtf16: 39369, sourceHash: '060f5bf2d67d2295e373167a2ffdc69afd319f8497bb88cb1ed6fb1e2f6fa408', textHash: '060f5bf2d67d2295e373167a2ffdc69afd319f8497bb88cb1ed6fb1e2f6fa408' },
  { doc: '005 - Al-Maeda (The Table, The Table Spread) - Pickthall', title: 'Al-Maeda (The Table, The Table Spread)', bytes: 29726, textLengthUtf16: 29726, sourceHash: 'cfb9a571aa1105f15ed21c05cd3cf8697416d956d2824e99e981894c85e010ba', textHash: 'cfb9a571aa1105f15ed21c05cd3cf8697416d956d2824e99e981894c85e010ba' },
  { doc: '006 - Al-Anaam (Cattle, Livestock) - Pickthall', title: 'Al-Anaam (Cattle, Livestock)', bytes: 32268, textLengthUtf16: 32268, sourceHash: 'e92dfa246cc3df304aacc616370b85c8cdd31e159802e72b56a6fac938e15a96', textHash: 'e92dfa246cc3df304aacc616370b85c8cdd31e159802e72b56a6fac938e15a96' },
  { doc: '007 - Al-Araf (The Heights) - Pickthall', title: 'Al-Araf (The Heights)', bytes: 35956, textLengthUtf16: 35956, sourceHash: '58891f015a30fc38b5744214186e5c15ca6bbc861945482eaf07eefcf7d163cb', textHash: '58891f015a30fc38b5744214186e5c15ca6bbc861945482eaf07eefcf7d163cb' },
  { doc: '008 - Al-Anfal (Spoils Of War, Booty) - Pickthall', title: 'Al-Anfal (Spoils Of War, Booty)', bytes: 13396, textLengthUtf16: 13396, sourceHash: 'c044cdd3ae4ae2c7eeb8c21691513dddc9c70eefd27024a6b72fda81acc17bfc', textHash: 'c044cdd3ae4ae2c7eeb8c21691513dddc9c70eefd27024a6b72fda81acc17bfc' },
  { doc: '009 - Al-Tawba (Repentance, Dispensation) - Pickthall', title: 'Al-Tawba (Repentance, Dispensation)', bytes: 27380, textLengthUtf16: 27380, sourceHash: 'aa59e8f51c87556fa5f6a24e5473d6295cc2871ae2c27e94a446bd671ae79cbb', textHash: 'aa59e8f51c87556fa5f6a24e5473d6295cc2871ae2c27e94a446bd671ae79cbb' },
  { doc: '010 - Yunus (Jonah) - Pickthall', title: 'Yunus (Jonah)', bytes: 18890, textLengthUtf16: 18890, sourceHash: '25e2cd9f3b9b6c8b9b452241693af6db9c07edf345a512554cbe696a4a5776b4', textHash: '25e2cd9f3b9b6c8b9b452241693af6db9c07edf345a512554cbe696a4a5776b4' },
  { doc: '011 - Hud (Hud) - Pickthall', title: 'Hud (Hud)', bytes: 20156, textLengthUtf16: 20156, sourceHash: 'e8ab7faf42a510fe4b437200f831c4d2a1783be8f06388db3f39870c035c3387', textHash: 'e8ab7faf42a510fe4b437200f831c4d2a1783be8f06388db3f39870c035c3387' },
  { doc: '012 - Yusuf (Joseph) - Pickthall', title: 'Yusuf (Joseph)', bytes: 18124, textLengthUtf16: 18124, sourceHash: '900a9f3e10ac7d0025b78dcd50a24b1241ae1be72e8d28af058997e2536e7bfa', textHash: '900a9f3e10ac7d0025b78dcd50a24b1241ae1be72e8d28af058997e2536e7bfa' },
  { doc: '013 - Al-Rad (The Thunder) - Pickthall', title: 'Al-Rad (The Thunder)', bytes: 9128, textLengthUtf16: 9128, sourceHash: '215daf4489e127a8047fe3abcdd6f283c8b360430218ff9efee7878c2d4d49e5', textHash: '215daf4489e127a8047fe3abcdd6f283c8b360430218ff9efee7878c2d4d49e5' },
  { doc: '014 - Ibrahim (Abraham) - Pickthall', title: 'Ibrahim (Abraham)', bytes: 8600, textLengthUtf16: 8600, sourceHash: '24c89fa97344afbe92df74dfa9848aaec4344ed29647cb9a0f2ec846b45faff3', textHash: '24c89fa97344afbe92df74dfa9848aaec4344ed29647cb9a0f2ec846b45faff3' },
  { doc: '015 - Al-Hijr (Al-Hijr, Stoneland, Rock City) - Pickthall', title: 'Al-Hijr (Al-Hijr, Stoneland, Rock City)', bytes: 7294, textLengthUtf16: 7294, sourceHash: '7cb76341eac494be52175b8af48a8889517ba04f32f58b4dd48fe2c049804e29', textHash: '7cb76341eac494be52175b8af48a8889517ba04f32f58b4dd48fe2c049804e29' },
  { doc: '016 - An-Nahl (The Bee) - Pickthall', title: 'An-Nahl (The Bee)', bytes: 19681, textLengthUtf16: 19681, sourceHash: '3ef05de4734b515950dd55bb34e9fcb48225a035bae651b2c1e41e70a5732044', textHash: '3ef05de4734b515950dd55bb34e9fcb48225a035bae651b2c1e41e70a5732044' },
  { doc: '017 - Al-Isra (Isra\', The Night Journey, Children Of Israel) - Pickthall', title: 'Al-Isra (Isra\', The Night Journey, Children Of Israel)', bytes: 16707, textLengthUtf16: 16707, sourceHash: 'de6eb6903d1a877ba2173e3f93d008d50f0adde46f7161fcd613eeba87ea227d', textHash: 'de6eb6903d1a877ba2173e3f93d008d50f0adde46f7161fcd613eeba87ea227d' },
  { doc: '018 - Al-Kahf (The Cave) - Pickthall', title: 'Al-Kahf (The Cave)', bytes: 16906, textLengthUtf16: 16906, sourceHash: '2ac644f7366e6568638808cf42ea07616d452b09f98ca92c45277cb7e4fa49e2', textHash: '2ac644f7366e6568638808cf42ea07616d452b09f98ca92c45277cb7e4fa49e2' },
  { doc: '019 - Maryam (Mary) - Pickthall', title: 'Maryam (Mary)', bytes: 10459, textLengthUtf16: 10459, sourceHash: '24209fbfe024cc347483766c34a4d7a637bff487b4ce4cfac31921897c9def07', textHash: '24209fbfe024cc347483766c34a4d7a637bff487b4ce4cfac31921897c9def07' },
  { doc: '020 - Ta-Ha (Ta-Ha) - Pickthall', title: 'Ta-Ha (Ta-Ha)', bytes: 14645, textLengthUtf16: 14645, sourceHash: '14fe3c15628c35c793b2cb312bbf9151e17f3dba24209997fd4ede921d72db52', textHash: '14fe3c15628c35c793b2cb312bbf9151e17f3dba24209997fd4ede921d72db52' },
  { doc: '021 - Al-Anbiya (The Prophets) - Pickthall', title: 'Al-Anbiya (The Prophets)', bytes: 12499, textLengthUtf16: 12499, sourceHash: 'a501950c2cafa12404850d604367be612a5afad15e5a03c5de36b4bf71fd60cd', textHash: 'a501950c2cafa12404850d604367be612a5afad15e5a03c5de36b4bf71fd60cd' },
  { doc: '022 - Al-Hajj (The Pilgrimage) - Pickthall', title: 'Al-Hajj (The Pilgrimage)', bytes: 13539, textLengthUtf16: 13539, sourceHash: '5dd9be84edbe50c0a40f8a1a36655f8f75d8aef6eb20488e8d32cb6b63fcc419', textHash: '5dd9be84edbe50c0a40f8a1a36655f8f75d8aef6eb20488e8d32cb6b63fcc419' },
  { doc: '023 - Al-Mumenoon (The Believers) - Pickthall', title: 'Al-Mumenoon (The Believers)', bytes: 10910, textLengthUtf16: 10910, sourceHash: '8874e2e8260001b3df6c7bb0f631cebe08eac9c91b164c80d6e9849c5d064521', textHash: '8874e2e8260001b3df6c7bb0f631cebe08eac9c91b164c80d6e9849c5d064521' },
  { doc: '024 - Al-Noor (The Light) - Pickthall', title: 'Al-Noor (The Light)', bytes: 13235, textLengthUtf16: 13235, sourceHash: '71d7883827431fab768cc6c37aaffff1d72b9753116dc3cbe4b5ff2b872ee183', textHash: '71d7883827431fab768cc6c37aaffff1d72b9753116dc3cbe4b5ff2b872ee183' },
  { doc: '025 - Al-Furqan (The Criterion, The Standard) - Pickthall', title: 'Al-Furqan (The Criterion, The Standard)', bytes: 9720, textLengthUtf16: 9720, sourceHash: '7ecf0c075146681dd1d128c835ab678eb9de544e7fc99fb47cd78c284be3b02e', textHash: '7ecf0c075146681dd1d128c835ab678eb9de544e7fc99fb47cd78c284be3b02e' },
  { doc: '026 - Al-Shuara (The Poets) - Pickthall', title: 'Al-Shuara (The Poets)', bytes: 14145, textLengthUtf16: 14145, sourceHash: '1fee72f9e19acadf61382eef4fb225a2bb267d925bb475aee17d40bbe4843c5e', textHash: '1fee72f9e19acadf61382eef4fb225a2bb267d925bb475aee17d40bbe4843c5e' },
  { doc: '027 - Al-Naml (The Ant, The Ants) - Pickthall', title: 'Al-Naml (The Ant, The Ants)', bytes: 12451, textLengthUtf16: 12451, sourceHash: '4d8eabff9a7c04b620fb82dc02fad22e369cbd99e435e1baf3bfb8870b3ccb77', textHash: '4d8eabff9a7c04b620fb82dc02fad22e369cbd99e435e1baf3bfb8870b3ccb77' },
  { doc: '028 - Al-Qasas (The Story, Stories) - Pickthall', title: 'Al-Qasas (The Story, Stories)', bytes: 14975, textLengthUtf16: 14975, sourceHash: '70a7e689c5041774d380cb010090414b866a7f37f3082c16d91fcf4baf240f44', textHash: '70a7e689c5041774d380cb010090414b866a7f37f3082c16d91fcf4baf240f44' },
  { doc: '029 - Al-Ankaboot (The Spider) - Pickthall', title: 'Al-Ankaboot (The Spider)', bytes: 10442, textLengthUtf16: 10442, sourceHash: '3c653d83f31e933a3913d0e6028d7bb89ff30a3155be82c84d81dc00de8aee4f', textHash: '3c653d83f31e933a3913d0e6028d7bb89ff30a3155be82c84d81dc00de8aee4f' },
  { doc: '030 - Al-Room (The Romans, The Byzantines) - Pickthall', title: 'Al-Room (The Romans, The Byzantines)', bytes: 8798, textLengthUtf16: 8798, sourceHash: 'f3fd3732bcd9a5cd3e05061a6d5897b77000d14e177db05ad467d47c2b60dcc0', textHash: 'f3fd3732bcd9a5cd3e05061a6d5897b77000d14e177db05ad467d47c2b60dcc0' },
  { doc: '031 - Luqman (Luqman) - Pickthall', title: 'Luqman (Luqman)', bytes: 5473, textLengthUtf16: 5473, sourceHash: 'c513a47908826a412c017c11740f63135894a6eb38632aa41cec5408c388c54b', textHash: 'c513a47908826a412c017c11740f63135894a6eb38632aa41cec5408c388c54b' },
  { doc: '032 - As-Sajda (The Prostration, Worship, Adoration) - Pickthall', title: 'As-Sajda (The Prostration, Worship, Adoration)', bytes: 3904, textLengthUtf16: 3904, sourceHash: '1c2feee9f2fec35bfc6c06a06b3115878271b4fd3bd30a36a436a32d7635f19d', textHash: '1c2feee9f2fec35bfc6c06a06b3115878271b4fd3bd30a36a436a32d7635f19d' },
  { doc: '033 - Al-Ahzab (The Clans, The Coalition, The Combined Forces) - Pickthall', title: 'Al-Ahzab (The Clans, The Coalition, The Combined Forces)', bytes: 14003, textLengthUtf16: 14003, sourceHash: 'd1b0be0f7277991c2215dd0ef826f84265dbc5e0755687e1383e711471907716', textHash: 'd1b0be0f7277991c2215dd0ef826f84265dbc5e0755687e1383e711471907716' },
  { doc: '034 - Saba (Saba, Sheba) - Pickthall', title: 'Saba (Saba, Sheba)', bytes: 8883, textLengthUtf16: 8883, sourceHash: '9132c833f6428ea6fa1a5ef29026043bc4c6262774c31711fba975ec5f357ae8', textHash: '9132c833f6428ea6fa1a5ef29026043bc4c6262774c31711fba975ec5f357ae8' },
  { doc: '035 - Fatir (The Angels, Originator) - Pickthall', title: 'Fatir (The Angels, Originator)', bytes: 7990, textLengthUtf16: 7990, sourceHash: '7248d4e7055fa1e2429d37007ce141b0313bac06df989c9ac4740d118be9f928', textHash: '7248d4e7055fa1e2429d37007ce141b0313bac06df989c9ac4740d118be9f928' },
  { doc: '036 - Ya-Seen (Ya-Seen) - Pickthall', title: 'Ya-Seen (Ya-Seen)', bytes: 7532, textLengthUtf16: 7532, sourceHash: '70fad06122828bb8fdcc26aae22d2f4a70d47650cf5633843dfb0a01633d1037', textHash: '70fad06122828bb8fdcc26aae22d2f4a70d47650cf5633843dfb0a01633d1037' },
  { doc: '037 - As-Saaffat (Those Who Set The Ranks, Drawn Up In Ranks) - Pickthall', title: 'As-Saaffat (Those Who Set The Ranks, Drawn Up In Ranks)', bytes: 9664, textLengthUtf16: 9664, sourceHash: '209384f185a33a93e059783402a11a8bab3b854fb50bd62758cffc32825af320', textHash: '209384f185a33a93e059783402a11a8bab3b854fb50bd62758cffc32825af320' },
  { doc: '038 - Sad (The Letter Sad) - Pickthall', title: 'Sad (The Letter Sad)', bytes: 8184, textLengthUtf16: 8184, sourceHash: '6038ef1a7faa4af024d0ffb79ec47943131d6917d001d4649c57fb7891662e0d', textHash: '6038ef1a7faa4af024d0ffb79ec47943131d6917d001d4649c57fb7891662e0d' },
  { doc: '039 - Az-Zumar (The Troops, Throngs) - Pickthall', title: 'Az-Zumar (The Troops, Throngs)', bytes: 12398, textLengthUtf16: 12398, sourceHash: '51a3216330ee25f647d33bc5b02e8934d358cb86c01112d59f8e2f971722cb40', textHash: '51a3216330ee25f647d33bc5b02e8934d358cb86c01112d59f8e2f971722cb40' },
  { doc: '040 - Al-Ghafir (The Forgiver (God) ) - Pickthall', title: 'Al-Ghafir (The Forgiver (God) )', bytes: 12702, textLengthUtf16: 12702, sourceHash: '00599c673c10c08fb5a596d46448d4662e4b109432b61582750cb6027183f78d', textHash: '00599c673c10c08fb5a596d46448d4662e4b109432b61582750cb6027183f78d' },
  { doc: '041 - Fussilat (Explained In Detail) - Pickthall', title: 'Fussilat (Explained In Detail)', bytes: 8487, textLengthUtf16: 8487, sourceHash: 'b55df1dc7d0c2cd9f815b86344968f10033ec75d87d6a55eff6db436bebdf7fb', textHash: 'b55df1dc7d0c2cd9f815b86344968f10033ec75d87d6a55eff6db436bebdf7fb' },
  { doc: '042 - Ash-Shura (Council, Consultation) - Pickthall', title: 'Ash-Shura (Council, Consultation)', bytes: 8855, textLengthUtf16: 8855, sourceHash: 'ce5681e12f6b3466f59fa0d54af921ac316456a055a1bfe02cdfbd7d3cbfddb5', textHash: 'ce5681e12f6b3466f59fa0d54af921ac316456a055a1bfe02cdfbd7d3cbfddb5' },
  { doc: '043 - Az-Zukhruf (Ornaments Of Gold, Luxury) - Pickthall', title: 'Az-Zukhruf (Ornaments Of Gold, Luxury)', bytes: 9247, textLengthUtf16: 9247, sourceHash: '411664521003f89e08a8b94dd807667453866efe3a029ca8f3e5c22a45ce411e', textHash: '411664521003f89e08a8b94dd807667453866efe3a029ca8f3e5c22a45ce411e' },
  { doc: '044 - Ad-Dukhan (Smoke) - Pickthall', title: 'Ad-Dukhan (Smoke)', bytes: 3726, textLengthUtf16: 3726, sourceHash: '29b0321cc9660bf9e1d7fe21d29d3e1888d05c04974cd59904257be0e150e555', textHash: '29b0321cc9660bf9e1d7fe21d29d3e1888d05c04974cd59904257be0e150e555' },
  { doc: '045 - Al-Jathiya (Crouching) - Pickthall', title: 'Al-Jathiya (Crouching)', bytes: 5249, textLengthUtf16: 5249, sourceHash: 'f8e7999997762b3b8e74db6c1620741945eb45cbf08ee455ee6cacf8de7b1f38', textHash: 'f8e7999997762b3b8e74db6c1620741945eb45cbf08ee455ee6cacf8de7b1f38' },
  { doc: '046 - Al-Ahqaf (The Wind-Curved Sandhills, The Dunes) - Pickthall', title: 'Al-Ahqaf (The Wind-Curved Sandhills, The Dunes)', bytes: 6906, textLengthUtf16: 6906, sourceHash: 'ccd4048ac22a9240b2489f1abea12314693eb46d14961b06e1a1a827819ba5f9', textHash: 'ccd4048ac22a9240b2489f1abea12314693eb46d14961b06e1a1a827819ba5f9' },
  { doc: '047 - Muhammad (Muhammad) - Pickthall', title: 'Muhammad (Muhammad)', bytes: 6065, textLengthUtf16: 6065, sourceHash: '11ceb0ec9fc85b5880c346fdef34298e2281b70ac9e06d530724ff37413f0284', textHash: '11ceb0ec9fc85b5880c346fdef34298e2281b70ac9e06d530724ff37413f0284' },
  { doc: '048 - Al-Fath (Victory, Conquest) - Pickthall', title: 'Al-Fath (Victory, Conquest)', bytes: 6335, textLengthUtf16: 6335, sourceHash: 'f08d84f6ad34de3533fa1fc88e507730cd5460e65012feda25031e614e2b0965', textHash: 'f08d84f6ad34de3533fa1fc88e507730cd5460e65012feda25031e614e2b0965' },
  { doc: '049 - Al-Hujraat (The Private Apartments, The Inner Apartments) - Pickthall', title: 'Al-Hujraat (The Private Apartments, The Inner Apartments)', bytes: 3573, textLengthUtf16: 3573, sourceHash: '2f9d74cf88ea166e215f21c32b4fa35a790dbe0fdbc4c7d4cb4a1d1fcb63c4da', textHash: '2f9d74cf88ea166e215f21c32b4fa35a790dbe0fdbc4c7d4cb4a1d1fcb63c4da' },
  { doc: '050 - Qaf (The Letter Qaf) - Pickthall', title: 'Qaf (The Letter Qaf)', bytes: 4185, textLengthUtf16: 4185, sourceHash: '36e579e6b1958bcbfc4d2f6318aa061dfd74320a7531824023a0b2a51e601745', textHash: '36e579e6b1958bcbfc4d2f6318aa061dfd74320a7531824023a0b2a51e601745' },
  { doc: '051 - Adh-Dhariyat (The Winnowing Winds) - Pickthall', title: 'Adh-Dhariyat (The Winnowing Winds)', bytes: 4169, textLengthUtf16: 4169, sourceHash: '237f0bdf893d1fe6c0170b32bff0c038ef5ae5ac6d6dd756df3a4fa036e18523', textHash: '237f0bdf893d1fe6c0170b32bff0c038ef5ae5ac6d6dd756df3a4fa036e18523' },
  { doc: '052 - At-Tur (The Mount) - Pickthall', title: 'At-Tur (The Mount)', bytes: 3638, textLengthUtf16: 3638, sourceHash: 'ec70b64d0276541671e6a66c386e890a44b110c8a840b10592a4cbc0f8954e88', textHash: 'ec70b64d0276541671e6a66c386e890a44b110c8a840b10592a4cbc0f8954e88' },
  { doc: '053 - An-Najm (The Star) - Pickthall', title: 'An-Najm (The Star)', bytes: 3816, textLengthUtf16: 3816, sourceHash: 'c48ffc33f40fcc2fbc5e27057a6937501d1f2b59a31576310d8d9302154caa3b', textHash: 'c48ffc33f40fcc2fbc5e27057a6937501d1f2b59a31576310d8d9302154caa3b' },
  { doc: '054 - Al-Qamar (The Moon) - Pickthall', title: 'Al-Qamar (The Moon)', bytes: 4159, textLengthUtf16: 4159, sourceHash: 'cf07cbe24bd99612b3f75889733c464f22c4ce3be5c85279ccb9d1a38b20bf5f', textHash: 'cf07cbe24bd99612b3f75889733c464f22c4ce3be5c85279ccb9d1a38b20bf5f' },
  { doc: '055 - Ar-Rahman (The Beneficent, The Mercy Giving) - Pickthall', title: 'Ar-Rahman (The Beneficent, The Mercy Giving)', bytes: 4324, textLengthUtf16: 4324, sourceHash: '4e561ba0b76d54b1b380c6e9954af21d3fc6e1e3f02a571aed9a70b6cd271a4b', textHash: '4e561ba0b76d54b1b380c6e9954af21d3fc6e1e3f02a571aed9a70b6cd271a4b' },
  { doc: '056 - Al-Waqia (The Event, The Inevitable) - Pickthall', title: 'Al-Waqia (The Event, The Inevitable)', bytes: 4185, textLengthUtf16: 4185, sourceHash: '44894a15c9d40f5df7002c325aabbdc9df8c9f217271dccfa5add17d855077d8', textHash: '44894a15c9d40f5df7002c325aabbdc9df8c9f217271dccfa5add17d855077d8' },
  { doc: '057 - Al-Hadid (The Iron) - Pickthall', title: 'Al-Hadid (The Iron)', bytes: 6245, textLengthUtf16: 6245, sourceHash: '647c4ca6be22965b5755991d9983cb80c07206d8f613c54344a7921330c2d80a', textHash: '647c4ca6be22965b5755991d9983cb80c07206d8f613c54344a7921330c2d80a' },
  { doc: '058 - Al-Mujadila (She That Disputeth, The Pleading Woman) - Pickthall', title: 'Al-Mujadila (She That Disputeth, The Pleading Woman)', bytes: 4990, textLengthUtf16: 4990, sourceHash: '230e60c60bf298314f1b14b8041cf3c2e937fcd7f5cd310f7b6f2717022b3925', textHash: '230e60c60bf298314f1b14b8041cf3c2e937fcd7f5cd310f7b6f2717022b3925' },
  { doc: '059 - Al-Hashr (Exile, Banishment) - Pickthall', title: 'Al-Hashr (Exile, Banishment)', bytes: 4933, textLengthUtf16: 4933, sourceHash: '00fbf98b08376204bd070e8a4db860566a5c64a53da8f3ba8c731d0708997591', textHash: '00fbf98b08376204bd070e8a4db860566a5c64a53da8f3ba8c731d0708997591' },
  { doc: '060 - Al-Mumtahina (She That Is To Be Examined, Examining Her) - Pickthall', title: 'Al-Mumtahina (She That Is To Be Examined, Examining Her)', bytes: 3846, textLengthUtf16: 3846, sourceHash: 'b6f5df64301e3b136c81c31b0f3a840cc3194a9f721262bee3b81350fa3e2c11', textHash: 'b6f5df64301e3b136c81c31b0f3a840cc3194a9f721262bee3b81350fa3e2c11' },
  { doc: '061 - As-Saff (The Ranks, Battle Array) - Pickthall', title: 'As-Saff (The Ranks, Battle Array)', bytes: 2244, textLengthUtf16: 2244, sourceHash: '215575e82a3fd29933b56c6d8a819e8419ac87d25a32cddca56ccd243ed92b92', textHash: '215575e82a3fd29933b56c6d8a819e8419ac87d25a32cddca56ccd243ed92b92' },
  { doc: '062 - Al-Jumua (The Congregation, Friday) - Pickthall', title: 'Al-Jumua (The Congregation, Friday)', bytes: 1806, textLengthUtf16: 1806, sourceHash: '887a43227388224131cbd2a7de3cb8ad08678786edc01676e97ca99228c5c799', textHash: '887a43227388224131cbd2a7de3cb8ad08678786edc01676e97ca99228c5c799' },
  { doc: '063 - Al-Munafiqoon (The Hypocrites) - Pickthall', title: 'Al-Munafiqoon (The Hypocrites)', bytes: 1990, textLengthUtf16: 1990, sourceHash: '51acd4eda06fc5b5cce09fbc68352ff1a9955b45a1b0941e3baa040fa6021f1c', textHash: '51acd4eda06fc5b5cce09fbc68352ff1a9955b45a1b0941e3baa040fa6021f1c' },
  { doc: '064 - At-Taghabun (Mutual Disillusion, Haggling) - Pickthall', title: 'At-Taghabun (Mutual Disillusion, Haggling)', bytes: 2792, textLengthUtf16: 2792, sourceHash: '80e2497c770f22e7a07a70a9a318494776d46e58fb3b7a7362931d54d48a2db1', textHash: '80e2497c770f22e7a07a70a9a318494776d46e58fb3b7a7362931d54d48a2db1' },
  { doc: '065 - At-Talaq (Divorce) - Pickthall', title: 'At-Talaq (Divorce)', bytes: 3103, textLengthUtf16: 3103, sourceHash: '9f5ac2272201c74e66473a979df504b7cc3cb88a538a285040b5b7d8f63de8d3', textHash: '9f5ac2272201c74e66473a979df504b7cc3cb88a538a285040b5b7d8f63de8d3' },
  { doc: '066 - At-Tahrim (Banning, Prohibition) - Pickthall', title: 'At-Tahrim (Banning, Prohibition)', bytes: 2706, textLengthUtf16: 2706, sourceHash: '4f8eb7ead31b84704896664cb5d34ac5e65d913fedb811160d7e00edf97aa8a0', textHash: '4f8eb7ead31b84704896664cb5d34ac5e65d913fedb811160d7e00edf97aa8a0' },
  { doc: '067 - Al-Mulk (The Sovereignty, Control) - Pickthall', title: 'Al-Mulk (The Sovereignty, Control)', bytes: 3497, textLengthUtf16: 3497, sourceHash: '79e1a947403acb7bd7a93caa9b9638736e98514be7c4475a8e58ae76cebef7a1', textHash: '79e1a947403acb7bd7a93caa9b9638736e98514be7c4475a8e58ae76cebef7a1' },
  { doc: '068 - Al-Qalam (The Pen) - Pickthall', title: 'Al-Qalam (The Pen)', bytes: 3426, textLengthUtf16: 3426, sourceHash: '678dc6bae308d8fea9cc6d272320ae0e6f8aead1a0f0f1a48615aa275ea5f81c', textHash: '678dc6bae308d8fea9cc6d272320ae0e6f8aead1a0f0f1a48615aa275ea5f81c' },
  { doc: '069 - Al-Haaqqa (The Reality) - Pickthall', title: 'Al-Haaqqa (The Reality)', bytes: 2892, textLengthUtf16: 2892, sourceHash: '46b0d8890de504c186cc304dff35667843443feaf823ba24741f52ecdb437080', textHash: '46b0d8890de504c186cc304dff35667843443feaf823ba24741f52ecdb437080' },
  { doc: '070 - Al-Maarij (The Ascending Stairways) - Pickthall', title: 'Al-Maarij (The Ascending Stairways)', bytes: 2435, textLengthUtf16: 2435, sourceHash: 'cbea789d27a1e3c2518aa295b63091b5aba58b07378303a1c6043d7a5a45a479', textHash: 'cbea789d27a1e3c2518aa295b63091b5aba58b07378303a1c6043d7a5a45a479' },
  { doc: '071 - Nooh (Nooh) - Pickthall', title: 'Nooh (Nooh)', bytes: 2371, textLengthUtf16: 2371, sourceHash: '55d14b2f03c9e6146adbb7108b3cc88685979b9cb99b46bf8660f0cdfd1a2639', textHash: '55d14b2f03c9e6146adbb7108b3cc88685979b9cb99b46bf8660f0cdfd1a2639' },
  { doc: '072 - Al-Jinn (The Jinn) - Pickthall', title: 'Al-Jinn (The Jinn)', bytes: 3154, textLengthUtf16: 3154, sourceHash: '3180ff523bfd81b8055d1af69d58b69709116ad4269abf9efa38028bd909c2d5', textHash: '3180ff523bfd81b8055d1af69d58b69709116ad4269abf9efa38028bd909c2d5' },
  { doc: '073 - Al-Muzzammil (The Enshrouded One, Bundled Up) - Pickthall', title: 'Al-Muzzammil (The Enshrouded One, Bundled Up)', bytes: 2219, textLengthUtf16: 2219, sourceHash: '79e715f99faa03340e6a04617fe8828281d527d2f7142dea23d31a6e339b0388', textHash: '79e715f99faa03340e6a04617fe8828281d527d2f7142dea23d31a6e339b0388' },
  { doc: '074 - Al-Muddaththir (The Cloaked One, The Man Wearing A Cloak) - Pickthall', title: 'Al-Muddaththir (The Cloaked One, The Man Wearing A Cloak)', bytes: 2780, textLengthUtf16: 2780, sourceHash: '2fcc805b451282b040eaad9196ea9d102d6bbc90437aebd01eb6a7bf34ff8e43', textHash: '2fcc805b451282b040eaad9196ea9d102d6bbc90437aebd01eb6a7bf34ff8e43' },
  { doc: '075 - Al-Qiyama (The Rising Of The Dead, Resurrection) - Pickthall', title: 'Al-Qiyama (The Rising Of The Dead, Resurrection)', bytes: 1803, textLengthUtf16: 1803, sourceHash: '7ee9c716ae97daf53461affe5a2af122c59ffabc4c93d0c902442900b6a2a4d3', textHash: '7ee9c716ae97daf53461affe5a2af122c59ffabc4c93d0c902442900b6a2a4d3' },
  { doc: '076 - Al-Insan (Man) - Pickthall', title: 'Al-Insan (Man)', bytes: 2659, textLengthUtf16: 2659, sourceHash: '888215303ecff6902cd5dcbe0e86ea89bfbbdcdc5ab806532889cbcd5d5e8068', textHash: '888215303ecff6902cd5dcbe0e86ea89bfbbdcdc5ab806532889cbcd5d5e8068' },
  { doc: '077 - Al-Mursalat (The Emissaries, Winds Sent Forth) - Pickthall', title: 'Al-Mursalat (The Emissaries, Winds Sent Forth)', bytes: 2234, textLengthUtf16: 2234, sourceHash: '6027a563a9b3ba3d452733623a9a8fb6700804a3f5c2bd781de008585cd31dfd', textHash: '6027a563a9b3ba3d452733623a9a8fb6700804a3f5c2bd781de008585cd31dfd' },
  { doc: '078 - An-Naba (The Tidings, The Announcement) - Pickthall', title: 'An-Naba (The Tidings, The Announcement)', bytes: 2016, textLengthUtf16: 2016, sourceHash: '7e8eb91d686a21b02ba6a6209baf2c2caa64a7b59af9094134b0c0da9f63c114', textHash: '7e8eb91d686a21b02ba6a6209baf2c2caa64a7b59af9094134b0c0da9f63c114' },
  { doc: '079 - An-Naziat (Those Who Drag Forth, Soul-Snatchers) - Pickthall', title: 'An-Naziat (Those Who Drag Forth, Soul-Snatchers)', bytes: 2163, textLengthUtf16: 2163, sourceHash: 'd56645a1ad6449de34dade245cfb0f745f024fa2712c7750ff5f9c8b4b36bab7', textHash: 'd56645a1ad6449de34dade245cfb0f745f024fa2712c7750ff5f9c8b4b36bab7' },
  { doc: '080 - Abasa (He Frowned) - Pickthall', title: 'Abasa (He Frowned)', bytes: 1568, textLengthUtf16: 1568, sourceHash: '500f8e84ed1c45eca85d11c4e359e70e582d4a595c8c95f3a66e961306e24ba6', textHash: '500f8e84ed1c45eca85d11c4e359e70e582d4a595c8c95f3a66e961306e24ba6' },
  { doc: '081 - At-Takwir (The Overthrowing) - Pickthall', title: 'At-Takwir (The Overthrowing)', bytes: 1160, textLengthUtf16: 1160, sourceHash: '87ee5b3c014e6e17ad6d6fb8b95e28b1e1693dbdf2cf150316225f5ae00efa5b', textHash: '87ee5b3c014e6e17ad6d6fb8b95e28b1e1693dbdf2cf150316225f5ae00efa5b' },
  { doc: '082 - Al-Infitar (The Cleaving, Bursting Apart) - Pickthall', title: 'Al-Infitar (The Cleaving, Bursting Apart)', bytes: 938, textLengthUtf16: 938, sourceHash: '839eb9cb816870cbdd42716f3a7dc52f5cb5b2f208a7094b864cb765154bca06', textHash: '839eb9cb816870cbdd42716f3a7dc52f5cb5b2f208a7094b864cb765154bca06' },
  { doc: '083 - Al-Mutaffifin (Defrauding, The Cheats, Cheating) - Pickthall', title: 'Al-Mutaffifin (Defrauding, The Cheats, Cheating)', bytes: 1865, textLengthUtf16: 1865, sourceHash: 'aa5e5d989eeb0b1a137ef233fdca230c9c4ea1c2ad59f2cd3a80237fca5b04b1', textHash: 'aa5e5d989eeb0b1a137ef233fdca230c9c4ea1c2ad59f2cd3a80237fca5b04b1' },
  { doc: '084 - Al-Inshiqaq (The Sundering, Splitting Open) - Pickthall', title: 'Al-Inshiqaq (The Sundering, Splitting Open)', bytes: 1199, textLengthUtf16: 1199, sourceHash: '600bd662a4da3d174cfefe542f9a75a4d5d48ab403ae9dc1cd7969ee61f32330', textHash: '600bd662a4da3d174cfefe542f9a75a4d5d48ab403ae9dc1cd7969ee61f32330' },
  { doc: '085 - Al-Burooj (The Mansions Of The Stars, Constellations) - Pickthall', title: 'Al-Burooj (The Mansions Of The Stars, Constellations)', bytes: 1219, textLengthUtf16: 1219, sourceHash: 'e8eb8bb6bcb8175af8c9e819ab9b1cf18b436711e84a0d61c3102b7d5ca8837f', textHash: 'e8eb8bb6bcb8175af8c9e819ab9b1cf18b436711e84a0d61c3102b7d5ca8837f' },
  { doc: '086 - At-Tariq (The Morning Star, The Nightcomer) - Pickthall', title: 'At-Tariq (The Morning Star, The Nightcomer)', bytes: 804, textLengthUtf16: 804, sourceHash: '654a4fd8cb1e4dfa378c1530a5637683862c486c86697f70372d3d513d1987ea', textHash: '654a4fd8cb1e4dfa378c1530a5637683862c486c86697f70372d3d513d1987ea' },
  { doc: '087 - Al-Ala (The Most High, Glory To Your Lord In The Highest) - Pickthall', title: 'Al-Ala (The Most High, Glory To Your Lord In The Highest)', bytes: 863, textLengthUtf16: 863, sourceHash: '3c91e57bc0c6eb8d70a4f27cef468b9ac6d43293885b1deeb233df3bb328a6f3', textHash: '3c91e57bc0c6eb8d70a4f27cef468b9ac6d43293885b1deeb233df3bb328a6f3' },
  { doc: '088 - Al-Ghashiya (The Overwhelming, The Pall) - Pickthall', title: 'Al-Ghashiya (The Overwhelming, The Pall)', bytes: 926, textLengthUtf16: 926, sourceHash: '128e1be05b670daa445196aea329206dc570bbe4356a991ce6325816328f49ba', textHash: '128e1be05b670daa445196aea329206dc570bbe4356a991ce6325816328f49ba' },
  { doc: '089 - Al-Fajr (The Dawn, Daybreak) - Pickthall', title: 'Al-Fajr (The Dawn, Daybreak)', bytes: 1486, textLengthUtf16: 1486, sourceHash: '9d10311510a8c7fae1dea82b16aee94a70ddb9db5cf0bead953480da4440aa47', textHash: '9d10311510a8c7fae1dea82b16aee94a70ddb9db5cf0bead953480da4440aa47' },
  { doc: '090 - Al-Balad (The City, This Countryside) - Pickthall', title: 'Al-Balad (The City, This Countryside)', bytes: 893, textLengthUtf16: 893, sourceHash: '49f2d827ad237f6d792760eb4a7529c6dc8b6b34502951a7654cd4880533593c', textHash: '49f2d827ad237f6d792760eb4a7529c6dc8b6b34502951a7654cd4880533593c' },
  { doc: '091 - Ash-Shams (The Sun) - Pickthall', title: 'Ash-Shams (The Sun)', bytes: 785, textLengthUtf16: 785, sourceHash: 'a88612b0bc501bd86a94500088c9af0ee8e2cd5c4690eb53e9c6e9cb0927d0b4', textHash: 'a88612b0bc501bd86a94500088c9af0ee8e2cd5c4690eb53e9c6e9cb0927d0b4' },
  { doc: '092 - Al-Lail (The Night) - Pickthall', title: 'Al-Lail (The Night)', bytes: 929, textLengthUtf16: 929, sourceHash: '6d5431481aed1326a9de689d7c55be279ad5ae458a5727a5eacfb44c922a2d9c', textHash: '6d5431481aed1326a9de689d7c55be279ad5ae458a5727a5eacfb44c922a2d9c' },
  { doc: '093 - Ad-Dhuha (The Morning Hours, Morning Bright) - Pickthall', title: 'Ad-Dhuha (The Morning Hours, Morning Bright)', bytes: 574, textLengthUtf16: 574, sourceHash: '20960ac2fc7e674a2544d6ff87e5a2dbea3811a49af0c89ad8303ba349bd5f25', textHash: '20960ac2fc7e674a2544d6ff87e5a2dbea3811a49af0c89ad8303ba349bd5f25' },
  { doc: '094 - Al-Inshirah (Solace, Consolation, Relief) - Pickthall', title: 'Al-Inshirah (Solace, Consolation, Relief)', bytes: 296, textLengthUtf16: 296, sourceHash: '203e3681df23b75cf45ac0f2f27a3cad2c6974cdbfd5a3d0d9470a3cf38c22cb', textHash: '203e3681df23b75cf45ac0f2f27a3cad2c6974cdbfd5a3d0d9470a3cf38c22cb' },
  { doc: '095 - At-Tin (The Fig, The Figtree) - Pickthall', title: 'At-Tin (The Fig, The Figtree)', bytes: 377, textLengthUtf16: 377, sourceHash: '2d9fa6a83a7a4ba7f0eac91d598d7e8a283718e31e92d42369bde82c437ae2fd', textHash: '2d9fa6a83a7a4ba7f0eac91d598d7e8a283718e31e92d42369bde82c437ae2fd' },
  { doc: '096 - Al-Alaq (The Clot, Read) - Pickthall', title: 'Al-Alaq (The Clot, Read)', bytes: 776, textLengthUtf16: 776, sourceHash: '44de34be1661af86d4da4da313cd151e6581f4d1806e3287617dee0af31bb4ff', textHash: '44de34be1661af86d4da4da313cd151e6581f4d1806e3287617dee0af31bb4ff' },
  { doc: '097 - Al-Qadr (Power, Fate) - Pickthall', title: 'Al-Qadr (Power, Fate)', bytes: 331, textLengthUtf16: 331, sourceHash: '3a2ec12557ba181de6775cf000231ecd651c810ea26ad1e29d67d6f5320e8f32', textHash: '3a2ec12557ba181de6775cf000231ecd651c810ea26ad1e29d67d6f5320e8f32' },
  { doc: '098 - Al-Bayyina (The Clear Proof, Evidence) - Pickthall', title: 'Al-Bayyina (The Clear Proof, Evidence)', bytes: 973, textLengthUtf16: 973, sourceHash: '36a57ab33801d93ba0579456505a63c037d3c851cafd690818829eb5c0e735af', textHash: '36a57ab33801d93ba0579456505a63c037d3c851cafd690818829eb5c0e735af' },
  { doc: '099 - Al-Zalzala (The Earthquake) - Pickthall', title: 'Al-Zalzala (The Earthquake)', bytes: 408, textLengthUtf16: 408, sourceHash: '792994b3b90f220e8f30677f3696c4b953d2d3337826a8113230649c842267b8', textHash: '792994b3b90f220e8f30677f3696c4b953d2d3337826a8113230649c842267b8' },
  { doc: '100 - Al-Adiyat (The Courser, The Chargers) - Pickthall', title: 'Al-Adiyat (The Courser, The Chargers)', bytes: 508, textLengthUtf16: 508, sourceHash: '5b186f7eec9a2ae7b058d18ff9de3b108b0861f77587098ee971a696341f8c3a', textHash: '5b186f7eec9a2ae7b058d18ff9de3b108b0861f77587098ee971a696341f8c3a' },
  { doc: '101 - Al-Qaria (The Calamity, The Stunning Blow, The Disaster) - Pickthall', title: 'Al-Qaria (The Calamity, The Stunning Blow, The Disaster)', bytes: 481, textLengthUtf16: 481, sourceHash: '35944e1b9bc1a96c469f5ae2dbf760ea508fb65183a77fb9c155c3b4b2b8114f', textHash: '35944e1b9bc1a96c469f5ae2dbf760ea508fb65183a77fb9c155c3b4b2b8114f' },
  { doc: '102 - At-Takathur (Rivalry In World Increase, Competition) - Pickthall', title: 'At-Takathur (Rivalry In World Increase, Competition)', bytes: 370, textLengthUtf16: 370, sourceHash: 'dcdaee577bd813578eeccf4c1f0a5844d7fb9c6d2172f6f502baf29baba002bb', textHash: 'dcdaee577bd813578eeccf4c1f0a5844d7fb9c6d2172f6f502baf29baba002bb' },
  { doc: '103 - Al-Asr (The Declining Day, Eventide, The Epoch) - Pickthall', title: 'Al-Asr (The Declining Day, Eventide, The Epoch)', bytes: 210, textLengthUtf16: 210, sourceHash: '9389d579469a40a6de004809842461d4585fbc78b661ceae68aabea45b254cdd', textHash: '9389d579469a40a6de004809842461d4585fbc78b661ceae68aabea45b254cdd' },
  { doc: '104 - Al-Humaza (The Traducer, The Gossipmonger) - Pickthall', title: 'Al-Humaza (The Traducer, The Gossipmonger)', bytes: 437, textLengthUtf16: 437, sourceHash: 'ea1893dad56aa49903692cd91135a5d5f618f07834667115205a6424a3dbb3a7', textHash: 'ea1893dad56aa49903692cd91135a5d5f618f07834667115205a6424a3dbb3a7' },
  { doc: '105 - Al-Fil (The Elephant) - Pickthall', title: 'Al-Fil (The Elephant)', bytes: 286, textLengthUtf16: 286, sourceHash: '8a2518cc2e3f64f92af59ccf723d3cea44f63ca329cb8b39e7f52059ec4d35dd', textHash: '8a2518cc2e3f64f92af59ccf723d3cea44f63ca329cb8b39e7f52059ec4d35dd' },
  { doc: '106 - Quraish (Winter, Quraysh) - Pickthall', title: 'Quraish (Winter, Quraysh)', bytes: 242, textLengthUtf16: 242, sourceHash: 'fb7c991f128b25f73ca20973b7a3c2a00b172b6b4fb0b2b18bdf8aaa56e74bf7', textHash: 'fb7c991f128b25f73ca20973b7a3c2a00b172b6b4fb0b2b18bdf8aaa56e74bf7' },
  { doc: '107 - Al-Maun (Small Kindnesses, Almsgiving, Have You Seen) - Pickthall', title: 'Al-Maun (Small Kindnesses, Almsgiving, Have You Seen)', bytes: 297, textLengthUtf16: 297, sourceHash: '39dd9cfbf2de57519af2816ac28a3f1c1633e4d2c1293c2067f3897d466b219f', textHash: '39dd9cfbf2de57519af2816ac28a3f1c1633e4d2c1293c2067f3897d466b219f' },
  { doc: '108 - Al-Kauther (Abundance, Plenty) - Pickthall', title: 'Al-Kauther (Abundance, Plenty)', bytes: 168, textLengthUtf16: 168, sourceHash: '32a698135ba936d673ae8f6346f9b95bbddc1063b95952e4edcb5c680ea98019', textHash: '32a698135ba936d673ae8f6346f9b95bbddc1063b95952e4edcb5c680ea98019' },
  { doc: '109 - Al-Kafiroon (The Disbelievers, Atheists) - Pickthall', title: 'Al-Kafiroon (The Disbelievers, Atheists)', bytes: 275, textLengthUtf16: 275, sourceHash: 'f3e4f663ceadc6eb7df3afd314fa4804e96e69d5f9076e1b681e31c53cbb15e0', textHash: 'f3e4f663ceadc6eb7df3afd314fa4804e96e69d5f9076e1b681e31c53cbb15e0' },
  { doc: '110 - An-Nasr (Succour, Divine Support) - Pickthall', title: 'An-Nasr (Succour, Divine Support)', bytes: 244, textLengthUtf16: 244, sourceHash: '5d549e87ca60c0b62dd4f94ea4d85a9138c1bc12abb68672e9bfb0e8b38cbef8', textHash: '5d549e87ca60c0b62dd4f94ea4d85a9138c1bc12abb68672e9bfb0e8b38cbef8' },
  { doc: '111 - Al-Masadd (Palm Fibre, The Flame) - Pickthall', title: 'Al-Masadd (Palm Fibre, The Flame)', bytes: 249, textLengthUtf16: 249, sourceHash: '4fe551b71249844910c6cac0bc64a08ea5a2c50e79bf6b13ddb6a58d1e2638ff', textHash: '4fe551b71249844910c6cac0bc64a08ea5a2c50e79bf6b13ddb6a58d1e2638ff' },
  { doc: '112 - Al-Ikhlas (Sincerity) - Pickthall', title: 'Al-Ikhlas (Sincerity)', bytes: 162, textLengthUtf16: 162, sourceHash: '9ac81a161377e4b91db6b28c73f5b068c9ab533b7130bbe743367c9b52a62ed9', textHash: '9ac81a161377e4b91db6b28c73f5b068c9ab533b7130bbe743367c9b52a62ed9' },
  { doc: '113 - Al-Falaq (The Daybreak, Dawn) - Pickthall', title: 'Al-Falaq (The Daybreak, Dawn)', bytes: 260, textLengthUtf16: 260, sourceHash: 'cfa7f094c4efbe352348a31dcad45f64dd7df0d063c72e4a1d0db1b68f6ed75c', textHash: 'cfa7f094c4efbe352348a31dcad45f64dd7df0d063c72e4a1d0db1b68f6ed75c' },
  { doc: '114 - An-Nas (Mankind) - Pickthall', title: 'An-Nas (Mankind)', bytes: 212, textLengthUtf16: 212, sourceHash: 'f7a7d5737e0ee6d6ea48ba553fec9f012883a1da2baa60be62311162f85ae5dc', textHash: 'f7a7d5737e0ee6d6ea48ba553fec9f012883a1da2baa60be62311162f85ae5dc' },
];

export const POLITICAL_ARGUMENTS: readonly BuiltinDocFixture[] = [
  { doc: '001 - The Prince - 1532 - Niccolò Machiavelli', title: 'The Prince', bytes: 171375, textLengthUtf16: 171226, sourceHash: 'f4bf7b26a97e219be864a978585c9ab42f4357a2a334b03b06e62d7ad23f0946', textHash: 'f4bf7b26a97e219be864a978585c9ab42f4357a2a334b03b06e62d7ad23f0946' },
  { doc: '002 - The Wealth of Nations - 1776 - Adam Smith', title: 'The Wealth of Nations', bytes: 2192734, textLengthUtf16: 2190531, sourceHash: '47d09dc7fd639cc52bcddc98b2c1801bef9ac1e69e781e8953ba1fc8cd9284ec', textHash: '47d09dc7fd639cc52bcddc98b2c1801bef9ac1e69e781e8953ba1fc8cd9284ec' },
  { doc: '003 - The Federalist Papers - 1788 - Hamilton, Madison, and Jay', title: 'The Federalist Papers', bytes: 1132741, textLengthUtf16: 1131575, sourceHash: 'dbb2435e24406503bd7f61627d86aa2a1a770a653209e9595caa33d1d592e535', textHash: 'dbb2435e24406503bd7f61627d86aa2a1a770a653209e9595caa33d1d592e535' },
  { doc: '004 - A Vindication of the Rights of Woman - 1792 - Mary Wollstonecraft', title: 'A Vindication of the Rights of Woman', bytes: 467537, textLengthUtf16: 465982, sourceHash: '261d576a30cfc238bbb08b85b392ad472e5649d33c44804cdbc618c9ec165565', textHash: '261d576a30cfc238bbb08b85b392ad472e5649d33c44804cdbc618c9ec165565' },
  { doc: '005 - The Communist Manifesto - 1848 - Karl Marx and Friedrich Engels', title: 'The Communist Manifesto', bytes: 71369, textLengthUtf16: 71162, sourceHash: '027729a6e616ea154dac469e108971c29b3726c077213d06817b562dc1da09ec', textHash: '027729a6e616ea154dac469e108971c29b3726c077213d06817b562dc1da09ec' },
  { doc: '006 - On Liberty - 1859 - John Stuart Mill', title: 'On Liberty', bytes: 274600, textLengthUtf16: 273964, sourceHash: 'e6b7db2ade18a3f29442de20042a5b313f864b37ec73829f6dc082c8ea220ea4', textHash: 'e6b7db2ade18a3f29442de20042a5b313f864b37ec73829f6dc082c8ea220ea4' },
  { doc: '007 - The Souls of Black Folk - 1903 - W. E. B. Du Bois', title: 'The Souls of Black Folk', bytes: 400781, textLengthUtf16: 396387, sourceHash: '3684477ac460083c894408ba79bb1ec30dd31f9aa7c7490175064239fbaee4a2', textHash: '3684477ac460083c894408ba79bb1ec30dd31f9aa7c7490175064239fbaee4a2' },
];

export const SHAKESPEARE: readonly BuiltinDocFixture[] = [
  { doc: '001 - The Two Gentlemen of Verona - William Shakespeare', title: 'The Two Gentlemen of Verona', bytes: 100014, textLengthUtf16: 98804, sourceHash: '282fda52a2f8efea5a83c6a2a51aa363694b0b74fa9ea3c5baa9813a7cd14156', textHash: '282fda52a2f8efea5a83c6a2a51aa363694b0b74fa9ea3c5baa9813a7cd14156' },
  { doc: '002 - The Taming of the Shrew - William Shakespeare', title: 'The Taming of the Shrew', bytes: 122022, textLengthUtf16: 120616, sourceHash: 'af417e2526f93842d0781a3028d2d997fcc5db56914967c2b5941b82fc6a8206', textHash: 'af417e2526f93842d0781a3028d2d997fcc5db56914967c2b5941b82fc6a8206' },
  { doc: '003 - Henry VI, Part II - William Shakespeare', title: 'Henry VI, Part II', bytes: 147788, textLengthUtf16: 146199, sourceHash: 'c6cb95e4ff1d302d7a4365d243ac0b653032c67a5f0690814f5beb9b03087271', textHash: 'c6cb95e4ff1d302d7a4365d243ac0b653032c67a5f0690814f5beb9b03087271' },
  { doc: '004 - Henry VI, Part III - William Shakespeare', title: 'Henry VI, Part III', bytes: 144311, textLengthUtf16: 142661, sourceHash: 'd9504d6163371d2affb6eda4158bb0801f140360628a0d2b76496540d93f8c91', textHash: 'd9504d6163371d2affb6eda4158bb0801f140360628a0d2b76496540d93f8c91' },
  { doc: '005 - Henry VI, Part I - William Shakespeare', title: 'Henry VI, Part I', bytes: 128613, textLengthUtf16: 127344, sourceHash: 'be484b4280bb5d12920ece0ad63e2b1203edc92612bb1cf5622e1c373e50cb19', textHash: 'be484b4280bb5d12920ece0ad63e2b1203edc92612bb1cf5622e1c373e50cb19' },
  { doc: '006 - Titus Andronicus - William Shakespeare', title: 'Titus Andronicus', bytes: 119653, textLengthUtf16: 118347, sourceHash: 'f222ef8a4a75f13fab970ad2c2d1310f50951b973ec5421c40608e0b8f846e57', textHash: 'f222ef8a4a75f13fab970ad2c2d1310f50951b973ec5421c40608e0b8f846e57' },
  { doc: '007 - Richard III - William Shakespeare', title: 'Richard III', bytes: 174374, textLengthUtf16: 172616, sourceHash: 'c5a56f72deecf8dacd818f7d18832aba22adbc87eacdb9ad424335b0fed4f26b', textHash: 'c5a56f72deecf8dacd818f7d18832aba22adbc87eacdb9ad424335b0fed4f26b' },
  { doc: '008 - Edward III - William Shakespeare', title: 'Edward III', bytes: 118322, textLengthUtf16: 116548, sourceHash: 'ff7fd762576016c3da7b3f9247b3548c0949865ee043664a85889742c1d1c79d', textHash: 'ff7fd762576016c3da7b3f9247b3548c0949865ee043664a85889742c1d1c79d' },
  { doc: '009 - The Comedy of Errors - William Shakespeare', title: 'The Comedy of Errors', bytes: 87851, textLengthUtf16: 86983, sourceHash: '9371b1d922f52668bb50061b72bfaa7d671372c8288527e866ae7571a15a277b', textHash: '9371b1d922f52668bb50061b72bfaa7d671372c8288527e866ae7571a15a277b' },
  { doc: '010 - Love’s Labour’s Lost - William Shakespeare', title: 'Love’s Labour’s Lost', bytes: 126407, textLengthUtf16: 124940, sourceHash: '2b4e6cae8aa904bbfafb59eff5908ce0520585cc6103cd5f79dcef24eb1e4b34', textHash: '2b4e6cae8aa904bbfafb59eff5908ce0520585cc6103cd5f79dcef24eb1e4b34' },
  { doc: '011 - Romeo and Juliet - William Shakespeare', title: 'Romeo and Juliet', bytes: 141750, textLengthUtf16: 139744, sourceHash: 'cc0f0fc9ac3bf8c754a335885dafc804f5a7d88d55a12325647f16160f2489ff', textHash: 'cc0f0fc9ac3bf8c754a335885dafc804f5a7d88d55a12325647f16160f2489ff' },
  { doc: '012 - Richard II - William Shakespeare', title: 'Richard II', bytes: 129128, textLengthUtf16: 127766, sourceHash: '81e62cad9437f77840661602ee53460ddb4ee0aea8e91ace87a9262512d90926', textHash: '81e62cad9437f77840661602ee53460ddb4ee0aea8e91ace87a9262512d90926' },
  { doc: '013 - A Midsummer Night’s Dream - William Shakespeare', title: 'A Midsummer Night’s Dream', bytes: 94265, textLengthUtf16: 93349, sourceHash: 'd1c1439acd8bd4a2cc6444aaed4a1a96c85de09bef334b319f2265009131a70d', textHash: 'd1c1439acd8bd4a2cc6444aaed4a1a96c85de09bef334b319f2265009131a70d' },
  { doc: '014 - King John - William Shakespeare', title: 'King John', bytes: 119385, textLengthUtf16: 118303, sourceHash: '9f511fcfb9da7fea3049219c818c336587c4385b65e2f66ebb85981b14464e9f', textHash: '9f511fcfb9da7fea3049219c818c336587c4385b65e2f66ebb85981b14464e9f' },
  { doc: '015 - The Merchant of Venice - William Shakespeare', title: 'The Merchant of Venice', bytes: 119681, textLengthUtf16: 118543, sourceHash: 'd467597556db4834150890ec17310b3882e929a85d12888696cb9b7cea0bc162', textHash: 'd467597556db4834150890ec17310b3882e929a85d12888696cb9b7cea0bc162' },
  { doc: '016 - Henry IV, Part I - William Shakespeare', title: 'Henry IV, Part I', bytes: 140060, textLengthUtf16: 138648, sourceHash: '92ad82f3f1f96fca386f3e47bb172bb5ae4cab13b4e3c36f0c4d156b0abf4fb3', textHash: '92ad82f3f1f96fca386f3e47bb172bb5ae4cab13b4e3c36f0c4d156b0abf4fb3' },
  { doc: '017 - The Merry Wives of Windsor - William Shakespeare', title: 'The Merry Wives of Windsor', bytes: 135454, textLengthUtf16: 133886, sourceHash: '8703bd810c7985aeec118d71b75a792e6df4c86bcf75f5e6a45ea156f9af0fcd', textHash: '8703bd810c7985aeec118d71b75a792e6df4c86bcf75f5e6a45ea156f9af0fcd' },
  { doc: '018 - Henry IV, Part II - William Shakespeare', title: 'Henry IV, Part II', bytes: 152016, textLengthUtf16: 150576, sourceHash: '98d15950cb4b8ea0e2836ccd05503f180f28980b567477df1ff763ff43218fb3', textHash: '98d15950cb4b8ea0e2836ccd05503f180f28980b567477df1ff763ff43218fb3' },
  { doc: '019 - Much Ado About Nothing - William Shakespeare', title: 'Much Ado About Nothing', bytes: 121006, textLengthUtf16: 119942, sourceHash: '3921f16076aeba1393a3f7eae561744ac65a608954a939bccae12b0cfa95ff66', textHash: '3921f16076aeba1393a3f7eae561744ac65a608954a939bccae12b0cfa95ff66' },
  { doc: '020 - Henry V - William Shakespeare', title: 'Henry V', bytes: 151166, textLengthUtf16: 149758, sourceHash: '90cab8f81dab9d359da336867060dee82e1258b0143e2d68cadf6b6b5d0822c7', textHash: '90cab8f81dab9d359da336867060dee82e1258b0143e2d68cadf6b6b5d0822c7' },
  { doc: '021 - Julius Caesar - William Shakespeare', title: 'Julius Caesar', bytes: 114536, textLengthUtf16: 113480, sourceHash: '9ee3a0bb45dfa695abb5577b633fccda1f8dae37093b7a7555b7ab3afd0ed176', textHash: '9ee3a0bb45dfa695abb5577b633fccda1f8dae37093b7a7555b7ab3afd0ed176' },
  { doc: '022 - As You Like It - William Shakespeare', title: 'As You Like It', bytes: 122852, textLengthUtf16: 121736, sourceHash: '1e4bb4215c511c056a9f95e4c90a537fe36b6e93e9a8ee86d0f216c9118a74e0', textHash: '1e4bb4215c511c056a9f95e4c90a537fe36b6e93e9a8ee86d0f216c9118a74e0' },
  { doc: '023 - Hamlet - William Shakespeare', title: 'Hamlet', bytes: 177114, textLengthUtf16: 174632, sourceHash: '05deaf30289fedc22cbe610b93aaa5e2f4fb96e4dacc65620ec8af857b9a5884', textHash: '05deaf30289fedc22cbe610b93aaa5e2f4fb96e4dacc65620ec8af857b9a5884' },
  { doc: '024 - Twelfth Night - William Shakespeare', title: 'Twelfth Night', bytes: 113619, textLengthUtf16: 112089, sourceHash: 'c6abb99827e18467522359ffa789e4b8de6c3b2698ef0ea4efe734fb65e5262e', textHash: 'c6abb99827e18467522359ffa789e4b8de6c3b2698ef0ea4efe734fb65e5262e' },
  { doc: '025 - Troilus and Cressida - William Shakespeare', title: 'Troilus and Cressida', bytes: 156153, textLengthUtf16: 153977, sourceHash: '3a069b4f00facfe92ed751173e80caf73232a8dae4d0601fa5a481e193949a03', textHash: '3a069b4f00facfe92ed751173e80caf73232a8dae4d0601fa5a481e193949a03' },
  { doc: '026 - Measure for Measure - William Shakespeare', title: 'Measure for Measure', bytes: 125635, textLengthUtf16: 124366, sourceHash: '45fb9cc09175b88b3338fd5300f02068f82bb34805008acf1747b517404e4d06', textHash: '45fb9cc09175b88b3338fd5300f02068f82bb34805008acf1747b517404e4d06' },
  { doc: '027 - Othello - William Shakespeare', title: 'Othello', bytes: 153786, textLengthUtf16: 151524, sourceHash: '0947c34eb2715e15d84e52a11b6abaa28c5b861fa88f353191cc5aebd2113a61', textHash: '0947c34eb2715e15d84e52a11b6abaa28c5b861fa88f353191cc5aebd2113a61' },
  { doc: '028 - All’s Well That Ends Well - William Shakespeare', title: 'All’s Well That Ends Well', bytes: 132710, textLengthUtf16: 131094, sourceHash: '787363e88adf8445bdabbe6a31932bc97f7e0cd092bfd12058c92f17faeefd87', textHash: '787363e88adf8445bdabbe6a31932bc97f7e0cd092bfd12058c92f17faeefd87' },
  { doc: '029 - King Lear - William Shakespeare', title: 'King Lear', bytes: 154710, textLengthUtf16: 152564, sourceHash: '664e0326f38a62415e595e653dc4772bd4e216fb0cffbd3a2dcbc0d2334ca02c', textHash: '664e0326f38a62415e595e653dc4772bd4e216fb0cffbd3a2dcbc0d2334ca02c' },
  { doc: '030 - Macbeth - William Shakespeare', title: 'Macbeth', bytes: 102704, textLengthUtf16: 101230, sourceHash: '842ebd9fe7c01be66913b16ef826542fe2bd6c70f2108a7521f10b33803faa04', textHash: '842ebd9fe7c01be66913b16ef826542fe2bd6c70f2108a7521f10b33803faa04' },
  { doc: '031 - Antony and Cleopatra - William Shakespeare', title: 'Antony and Cleopatra', bytes: 150487, textLengthUtf16: 148315, sourceHash: 'dae0879181de8669f56f33ff82d270b6ae33f2a5d4f10f11006de9a23c42555a', textHash: 'dae0879181de8669f56f33ff82d270b6ae33f2a5d4f10f11006de9a23c42555a' },
  { doc: '032 - Timon of Athens - William Shakespeare', title: 'Timon of Athens', bytes: 110934, textLengthUtf16: 109156, sourceHash: '012960b0659caadf2fe24a74498c72b682653c6d47ebdcb5f74291f7ed105805', textHash: '012960b0659caadf2fe24a74498c72b682653c6d47ebdcb5f74291f7ed105805' },
  { doc: '033 - Coriolanus - William Shakespeare', title: 'Coriolanus', bytes: 165078, textLengthUtf16: 162574, sourceHash: '2bf9477bc5d0e21d4c321f42093294f4dc1ee3edcdfdcb5be277f1d902a822c8', textHash: '2bf9477bc5d0e21d4c321f42093294f4dc1ee3edcdfdcb5be277f1d902a822c8' },
  { doc: '034 - Pericles - William Shakespeare', title: 'Pericles', bytes: 108688, textLengthUtf16: 107228, sourceHash: '944a2affa661042ca7be361c3281512934665468d8d3d24d4f8247029491d2c7', textHash: '944a2affa661042ca7be361c3281512934665468d8d3d24d4f8247029491d2c7' },
  { doc: '035 - Cymbeline - William Shakespeare', title: 'Cymbeline', bytes: 160852, textLengthUtf16: 157998, sourceHash: 'd2ec90f36eff3175daa6940de8a89af32f303d1a54312017d512801d82c67a9e', textHash: 'd2ec90f36eff3175daa6940de8a89af32f303d1a54312017d512801d82c67a9e' },
  { doc: '036 - The Winter’s Tale - William Shakespeare', title: 'The Winter’s Tale', bytes: 142937, textLengthUtf16: 140789, sourceHash: 'c43e4004233ac84cde30154ca01d03e7b063c3031195f147881dd15573362e2b', textHash: 'c43e4004233ac84cde30154ca01d03e7b063c3031195f147881dd15573362e2b' },
  { doc: '037 - The Tempest - William Shakespeare', title: 'The Tempest', bytes: 97739, textLengthUtf16: 96261, sourceHash: '0974082bc84d4b961833ca4232c1a07dfd4f9922c656143ed1472720fba3bea9', textHash: '0974082bc84d4b961833ca4232c1a07dfd4f9922c656143ed1472720fba3bea9' },
  { doc: '038 - Henry VIII - William Shakespeare', title: 'Henry VIII', bytes: 143353, textLengthUtf16: 141371, sourceHash: '86ae28875c0c88e9a7811dad596bfc56ce6c15a53180cac0f6e674c275421f75', textHash: '86ae28875c0c88e9a7811dad596bfc56ce6c15a53180cac0f6e674c275421f75' },
  { doc: '039 - The Two Noble Kinsmen - William Shakespeare', title: 'The Two Noble Kinsmen', bytes: 142253, textLengthUtf16: 138969, sourceHash: 'ed690a7519b17c4b66a30bb2716888d5188ca129a31d7ead45dd899a036d2657', textHash: 'ed690a7519b17c4b66a30bb2716888d5188ca129a31d7ead45dd899a036d2657' },
];

export const INAUGURALS: readonly BuiltinDocFixture[] = [
  { doc: '001 - George Washington — First Inaugural Address (1789)', title: 'George Washington — First Inaugural Address (1789)', bytes: 8616, textLengthUtf16: 8616, sourceHash: '4f7cffd314a605c2f2afa53fbaa3bd1a18312d403aba6611a7e314224bf282f8', textHash: '4f7cffd314a605c2f2afa53fbaa3bd1a18312d403aba6611a7e314224bf282f8' },
  { doc: '002 - George Washington — Second Inaugural Address (1793)', title: 'George Washington — Second Inaugural Address (1793)', bytes: 789, textLengthUtf16: 789, sourceHash: '8bf1661135ac7f1c47e55c02ebb9d6901665a29be7731d1d781770b239f815e6', textHash: '8bf1661135ac7f1c47e55c02ebb9d6901665a29be7731d1d781770b239f815e6' },
  { doc: '003 - John Adams — Inaugural Address (1797)', title: 'John Adams — Inaugural Address (1797)', bytes: 13875, textLengthUtf16: 13875, sourceHash: 'a54a7d72606ab07ae29b840ae622b112632b801a7c7449325cbb95e04651f9e1', textHash: 'a54a7d72606ab07ae29b840ae622b112632b801a7c7449325cbb95e04651f9e1' },
  { doc: '004 - Thomas Jefferson — First Inaugural Address (1801)', title: 'Thomas Jefferson — First Inaugural Address (1801)', bytes: 10126, textLengthUtf16: 10126, sourceHash: 'dfb9345c499df3b471a4acaa602dceb0ff92ec323ddc5a3aecafdbf159433e3e', textHash: 'dfb9345c499df3b471a4acaa602dceb0ff92ec323ddc5a3aecafdbf159433e3e' },
  { doc: '005 - Thomas Jefferson — Second Inaugural Address (1805)', title: 'Thomas Jefferson — Second Inaugural Address (1805)', bytes: 12906, textLengthUtf16: 12906, sourceHash: '7327d51209c53fff0d271013554252f0274f56898cade6e4c195d727d4d715b6', textHash: '7327d51209c53fff0d271013554252f0274f56898cade6e4c195d727d4d715b6' },
  { doc: '006 - James Madison — First Inaugural Address (1809)', title: 'James Madison — First Inaugural Address (1809)', bytes: 6997, textLengthUtf16: 6997, sourceHash: '2d899ab20e5d38456cb82d9226bdbe77bfc9ba3fb357d8480d62bb156a9b65d7', textHash: '2d899ab20e5d38456cb82d9226bdbe77bfc9ba3fb357d8480d62bb156a9b65d7' },
  { doc: '007 - James Madison — Second Inaugural Address (1813)', title: 'James Madison — Second Inaugural Address (1813)', bytes: 7157, textLengthUtf16: 7157, sourceHash: 'c1df097b4e0a129ca35f93f434e40dd4e7a2d4be50b93fa209fafcfa75907aec', textHash: 'c1df097b4e0a129ca35f93f434e40dd4e7a2d4be50b93fa209fafcfa75907aec' },
  { doc: '008 - James Monroe — First Inaugural Address (1817)', title: 'James Monroe — First Inaugural Address (1817)', bytes: 19886, textLengthUtf16: 19886, sourceHash: '148fd9d83ed229faaa4b4c374528d5656284d585f4b951a128e725464694a2bc', textHash: '148fd9d83ed229faaa4b4c374528d5656284d585f4b951a128e725464694a2bc' },
  { doc: '009 - James Monroe — Second Inaugural Address (1821)', title: 'James Monroe — Second Inaugural Address (1821)', bytes: 26332, textLengthUtf16: 26332, sourceHash: '0ee42fae12e273db33768abe706bcef8de74015c89f97d68c5ed915399d3dc63', textHash: '0ee42fae12e273db33768abe706bcef8de74015c89f97d68c5ed915399d3dc63' },
  { doc: '010 - John Quincy Adams — Inaugural Address (1825)', title: 'John Quincy Adams — Inaugural Address (1825)', bytes: 17733, textLengthUtf16: 17733, sourceHash: '2c407e94525e8a6e2c78cb762063bf2f3782bc88cd602bf530de69bcd7f34ebf', textHash: '2c407e94525e8a6e2c78cb762063bf2f3782bc88cd602bf530de69bcd7f34ebf' },
  { doc: '011 - Andrew Jackson — First Inaugural Address (1829)', title: 'Andrew Jackson — First Inaugural Address (1829)', bytes: 6816, textLengthUtf16: 6816, sourceHash: 'e8705b874699836c1c74111d5e775dcd0062cf1259271da15c8f89f6a1d42c5b', textHash: 'e8705b874699836c1c74111d5e775dcd0062cf1259271da15c8f89f6a1d42c5b' },
  { doc: '012 - Andrew Jackson — Second Inaugural Address (1833)', title: 'Andrew Jackson — Second Inaugural Address (1833)', bytes: 7058, textLengthUtf16: 7058, sourceHash: '79a867824500a8a5804525b53e404f6834c45b14e223680f96bded8cfbe1d9d1', textHash: '79a867824500a8a5804525b53e404f6834c45b14e223680f96bded8cfbe1d9d1' },
  { doc: '013 - Martin Van Buren — Inaugural Address (1837)', title: 'Martin Van Buren — Inaugural Address (1837)', bytes: 23413, textLengthUtf16: 23413, sourceHash: 'fb5bbbbce4291e3a16829da6a85404f1393bdce1b6897b6d1c5bd0bd6e9b63f7', textHash: 'fb5bbbbce4291e3a16829da6a85404f1393bdce1b6897b6d1c5bd0bd6e9b63f7' },
  { doc: '014 - William Henry Harrison — Inaugural Address (1841)', title: 'William Henry Harrison — Inaugural Address (1841)', bytes: 49701, textLengthUtf16: 49701, sourceHash: '8051a37e890d14599050f4b8b06c3f645d8ff6412c7f11752a9706a2e8334257', textHash: '8051a37e890d14599050f4b8b06c3f645d8ff6412c7f11752a9706a2e8334257' },
  { doc: '015 - James Knox Polk — Inaugural Address (1845)', title: 'James Knox Polk — Inaugural Address (1845)', bytes: 28707, textLengthUtf16: 28707, sourceHash: '0adff1f07df8acb3b10088d17120b6bda5e2736c5e032b747933d2efdcd03a9d', textHash: '0adff1f07df8acb3b10088d17120b6bda5e2736c5e032b747933d2efdcd03a9d' },
  { doc: '016 - Zachary Taylor — Inaugural Address (1849)', title: 'Zachary Taylor — Inaugural Address (1849)', bytes: 6603, textLengthUtf16: 6603, sourceHash: '830a09d7eff4e16ce2b11a6f57dd1562d4043694fb7b904bad9fcce9eb3a3b15', textHash: '830a09d7eff4e16ce2b11a6f57dd1562d4043694fb7b904bad9fcce9eb3a3b15' },
  { doc: '017 - Franklin Pierce — Inaugural Address (1853)', title: 'Franklin Pierce — Inaugural Address (1853)', bytes: 20072, textLengthUtf16: 20072, sourceHash: '6cdcb6f071f40eafba567a6aed45a1f94150b2351e9d42ddabc6cb8e5287b2fe', textHash: '6cdcb6f071f40eafba567a6aed45a1f94150b2351e9d42ddabc6cb8e5287b2fe' },
  { doc: '018 - James Buchanan — Inaugural Address (1857)', title: 'James Buchanan — Inaugural Address (1857)', bytes: 16812, textLengthUtf16: 16812, sourceHash: '9017a18d1305b95fe4d02b52f119215647f01661662f736096a169b4206693b3', textHash: '9017a18d1305b95fe4d02b52f119215647f01661662f736096a169b4206693b3' },
  { doc: '019 - Abraham Lincoln — First Inaugural Address (1861)', title: 'Abraham Lincoln — First Inaugural Address (1861)', bytes: 21006, textLengthUtf16: 21006, sourceHash: '78a72288a468338dfdfef460a030f38b05a371b5b897d4da5540975051a86ef2', textHash: '78a72288a468338dfdfef460a030f38b05a371b5b897d4da5540975051a86ef2' },
  { doc: '020 - Abraham Lincoln — Second Inaugural Address (1865)', title: 'Abraham Lincoln — Second Inaugural Address (1865)', bytes: 3926, textLengthUtf16: 3926, sourceHash: 'cec4aef80f2e7a0d58a5ac5ffca9365682901537d606b8543a187464923b042b', textHash: 'cec4aef80f2e7a0d58a5ac5ffca9365682901537d606b8543a187464923b042b' },
  { doc: '021 - Ulysses S. Grant — First Inaugural Address (1869)', title: 'Ulysses S. Grant — First Inaugural Address (1869)', bytes: 6495, textLengthUtf16: 6495, sourceHash: '6824c44d7c742cc61fac92e2295fadaaf72d92d101ae1996d7bed1892ce11a2a', textHash: '6824c44d7c742cc61fac92e2295fadaaf72d92d101ae1996d7bed1892ce11a2a' },
  { doc: '022 - Ulysses S. Grant — Second Inaugural Address (1873)', title: 'Ulysses S. Grant — Second Inaugural Address (1873)', bytes: 7728, textLengthUtf16: 7728, sourceHash: '14f7e238a03691bcf7d42eba3f83247051a1792e677e5e8d63e5058118b75bc0', textHash: '14f7e238a03691bcf7d42eba3f83247051a1792e677e5e8d63e5058118b75bc0' },
  { doc: '023 - Rutherford B. Hayes — Inaugural Address (1877)', title: 'Rutherford B. Hayes — Inaugural Address (1877)', bytes: 14925, textLengthUtf16: 14925, sourceHash: '05c91112ed4f9d5a8fc3bdeb0d0b4f47e106c7de0cedf5b20c9600f406957558', textHash: '05c91112ed4f9d5a8fc3bdeb0d0b4f47e106c7de0cedf5b20c9600f406957558' },
  { doc: '024 - James A. Garfield — Inaugural Address (1881)', title: 'James A. Garfield — Inaugural Address (1881)', bytes: 17766, textLengthUtf16: 17766, sourceHash: 'df7077394692ef11aa38211708c17b0509d9f9eeb0f19ceb13130b25c8507e10', textHash: 'df7077394692ef11aa38211708c17b0509d9f9eeb0f19ceb13130b25c8507e10' },
  { doc: '025 - Grover Cleveland — First Inaugural Address (1885)', title: 'Grover Cleveland — First Inaugural Address (1885)', bytes: 10142, textLengthUtf16: 10142, sourceHash: '4b03b6b94ac43f8850972dc67deae7e5850e5adc431cce492fa03fffd0925f3c', textHash: '4b03b6b94ac43f8850972dc67deae7e5850e5adc431cce492fa03fffd0925f3c' },
  { doc: '026 - Benjamin Harrison — Inaugural Address (1889)', title: 'Benjamin Harrison — Inaugural Address (1889)', bytes: 26179, textLengthUtf16: 26179, sourceHash: 'fe50362079a0d2c94d405431d835691ba893d57c338d9babbde408143aa3bac0', textHash: 'fe50362079a0d2c94d405431d835691ba893d57c338d9babbde408143aa3bac0' },
  { doc: '027 - Grover Cleveland — Second Inaugural Address (1893)', title: 'Grover Cleveland — Second Inaugural Address (1893)', bytes: 12350, textLengthUtf16: 12350, sourceHash: 'a28c5a87af9aeb2673f9add85997c4437b64721692793011b98582e484de9a1d', textHash: 'a28c5a87af9aeb2673f9add85997c4437b64721692793011b98582e484de9a1d' },
  { doc: '028 - William McKinley — First Inaugural Address (1897)', title: 'William McKinley — First Inaugural Address (1897)', bytes: 23654, textLengthUtf16: 23654, sourceHash: '391c14bfc9ef8a53b387173df783b70cc0657f98e3a16bc2c86b42b92522cdab', textHash: '391c14bfc9ef8a53b387173df783b70cc0657f98e3a16bc2c86b42b92522cdab' },
  { doc: '029 - William McKinley — Second Inaugural Address (1901)', title: 'William McKinley — Second Inaugural Address (1901)', bytes: 13430, textLengthUtf16: 13430, sourceHash: '7f2645f43b7e2e12bffd7e176ae6b329c89108fb32ed56450f0175a86c69963b', textHash: '7f2645f43b7e2e12bffd7e176ae6b329c89108fb32ed56450f0175a86c69963b' },
  { doc: '030 - Theodore Roosevelt — Inaugural Address (1905)', title: 'Theodore Roosevelt — Inaugural Address (1905)', bytes: 5569, textLengthUtf16: 5569, sourceHash: 'a311af11ce09d6efe95c0aa7af54aa9d2e1c21479bbdc317b24eb62795f3df21', textHash: 'a311af11ce09d6efe95c0aa7af54aa9d2e1c21479bbdc317b24eb62795f3df21' },
  { doc: '031 - William Howard Taft — Inaugural Address (1909)', title: 'William Howard Taft — Inaugural Address (1909)', bytes: 32164, textLengthUtf16: 32164, sourceHash: 'b3d391669620bf1201544b5ffedaf413887cc50df746aab3fd5f7ca72def3a13', textHash: 'b3d391669620bf1201544b5ffedaf413887cc50df746aab3fd5f7ca72def3a13' },
  { doc: '032 - Woodrow Wilson — First Inaugural Address (1913)', title: 'Woodrow Wilson — First Inaugural Address (1913)', bytes: 9564, textLengthUtf16: 9564, sourceHash: '4168e3153466afe37cb59c5ad00e48e446f8fc4ce2e71334421dc25415b3e0ed', textHash: '4168e3153466afe37cb59c5ad00e48e446f8fc4ce2e71334421dc25415b3e0ed' },
  { doc: '033 - Woodrow Wilson — Second Inaugural Address (1917)', title: 'Woodrow Wilson — Second Inaugural Address (1917)', bytes: 8388, textLengthUtf16: 8388, sourceHash: '675dcc6ac9083d9ca2002b096b8cfd555057b56dee32486bc6e8047e0586a0c1', textHash: '675dcc6ac9083d9ca2002b096b8cfd555057b56dee32486bc6e8047e0586a0c1' },
  { doc: '034 - Warren G. Harding — Inaugural Address (1921)', title: 'Warren G. Harding — Inaugural Address (1921)', bytes: 20292, textLengthUtf16: 20292, sourceHash: 'ab9c57f850bfe128f91052a11ad3a28f9aff2265ade44b61f76294d94d82115d', textHash: 'ab9c57f850bfe128f91052a11ad3a28f9aff2265ade44b61f76294d94d82115d' },
  { doc: '035 - Calvin Coolidge — Inaugural Address (1925)', title: 'Calvin Coolidge — Inaugural Address (1925)', bytes: 23948, textLengthUtf16: 23948, sourceHash: '14ce080c5b9235519eb0e82b2769f551541c1a7bbf2f67187635fee5531d7846', textHash: '14ce080c5b9235519eb0e82b2769f551541c1a7bbf2f67187635fee5531d7846' },
  { doc: '036 - Herbert Hoover — Inaugural Address (1929)', title: 'Herbert Hoover — Inaugural Address (1929)', bytes: 22954, textLengthUtf16: 22954, sourceHash: 'f1f7af1373d04c24cd4b77461711f6c9a568e6151957b05f8d34d634c9d8d9cb', textHash: 'f1f7af1373d04c24cd4b77461711f6c9a568e6151957b05f8d34d634c9d8d9cb' },
  { doc: '037 - Franklin D. Roosevelt — First Inaugural Address (1933)', title: 'Franklin D. Roosevelt — First Inaugural Address (1933)', bytes: 10890, textLengthUtf16: 10890, sourceHash: '6eaf49a0e7c61d44c18e8fc70272621f469f7e3139a7299eeed84ed9091255db', textHash: '6eaf49a0e7c61d44c18e8fc70272621f469f7e3139a7299eeed84ed9091255db' },
  { doc: '038 - Franklin D. Roosevelt — Second Inaugural Address (1937)', title: 'Franklin D. Roosevelt — Second Inaugural Address (1937)', bytes: 10591, textLengthUtf16: 10591, sourceHash: '633a508962dced869c124710398a71748aa43b3e1b9afa55f51df0ebc59c5ec8', textHash: '633a508962dced869c124710398a71748aa43b3e1b9afa55f51df0ebc59c5ec8' },
  { doc: '039 - Franklin D. Roosevelt — Third Inaugural Address (1941)', title: 'Franklin D. Roosevelt — Third Inaugural Address (1941)', bytes: 7532, textLengthUtf16: 7532, sourceHash: '9bd9c3a33abb6511247e40a8d63a1aa2e30c6a48bbfabf88d1bdf639a4f5cbc2', textHash: '9bd9c3a33abb6511247e40a8d63a1aa2e30c6a48bbfabf88d1bdf639a4f5cbc2' },
  { doc: '040 - Franklin D. Roosevelt — Fourth Inaugural Address (1945)', title: 'Franklin D. Roosevelt — Fourth Inaugural Address (1945)', bytes: 3012, textLengthUtf16: 3012, sourceHash: 'dcde79c6802ac3d7fd28feaab589dddaca0765282f5f2f2188852f2e0d48d36c', textHash: 'dcde79c6802ac3d7fd28feaab589dddaca0765282f5f2f2188852f2e0d48d36c' },
  { doc: '041 - Harry S. Truman — Inaugural Address (1949)', title: 'Harry S. Truman — Inaugural Address (1949)', bytes: 13663, textLengthUtf16: 13663, sourceHash: 'd46ac00347681594ad973ffc4c3f2d7b43a2029fee305b3f2c638260595d1f78', textHash: 'd46ac00347681594ad973ffc4c3f2d7b43a2029fee305b3f2c638260595d1f78' },
  { doc: '042 - Dwight D. Eisenhower — First Inaugural Address (1953)', title: 'Dwight D. Eisenhower — First Inaugural Address (1953)', bytes: 13929, textLengthUtf16: 13929, sourceHash: '76bf928b09019f7cfb3258510951fb13e0901c3af2ca676132c11e54dc67181a', textHash: '76bf928b09019f7cfb3258510951fb13e0901c3af2ca676132c11e54dc67181a' },
  { doc: '043 - Dwight D. Eisenhower — Second Inaugural Address (1957)', title: 'Dwight D. Eisenhower — Second Inaugural Address (1957)', bytes: 9124, textLengthUtf16: 9124, sourceHash: '351ae6ad10da3c01d730705690082a1ede623758ef29303ae53fbb994ff5f5f9', textHash: '351ae6ad10da3c01d730705690082a1ede623758ef29303ae53fbb994ff5f5f9' },
  { doc: '044 - John F. Kennedy — Inaugural Address (1961)', title: 'John F. Kennedy — Inaugural Address (1961)', bytes: 7564, textLengthUtf16: 7564, sourceHash: 'e6d57789051d08b58b5b4ce846cd588fa6392ac1bd4bc7af77a584ee2741514b', textHash: 'e6d57789051d08b58b5b4ce846cd588fa6392ac1bd4bc7af77a584ee2741514b' },
  { doc: '045 - Lyndon Baines Johnson — Inaugural Address (1965)', title: 'Lyndon Baines Johnson — Inaugural Address (1965)', bytes: 8178, textLengthUtf16: 8178, sourceHash: '09ab320d0af959e388e3d6568584efb0f713fd0f17c4e6eba522007f3a26c754', textHash: '09ab320d0af959e388e3d6568584efb0f713fd0f17c4e6eba522007f3a26c754' },
  { doc: '046 - Richard Milhous Nixon — First Inaugural Address (1969)', title: 'Richard Milhous Nixon — First Inaugural Address (1969)', bytes: 11587, textLengthUtf16: 11587, sourceHash: '204894fddb3d3d63a2f8955acd07a7fb54a13d8c20a064c401ce67ec610ee3c5', textHash: '204894fddb3d3d63a2f8955acd07a7fb54a13d8c20a064c401ce67ec610ee3c5' },
  { doc: '047 - Richard Milhous Nixon — Second Inaugural Address (1973)', title: 'Richard Milhous Nixon — Second Inaugural Address (1973)', bytes: 9958, textLengthUtf16: 9958, sourceHash: 'b02d1c7b82410847f05121af0e3980b5584379bc543dbc38ecb2d5ac5c01bc3a', textHash: 'b02d1c7b82410847f05121af0e3980b5584379bc543dbc38ecb2d5ac5c01bc3a' },
  { doc: '048 - Jimmy Carter — Inaugural Address (1977)', title: 'Jimmy Carter — Inaugural Address (1977)', bytes: 6872, textLengthUtf16: 6872, sourceHash: '727b02a0e2d50210dbbb733c650d0df2f7026663cbf96cdd44f73e0598f97a0b', textHash: '727b02a0e2d50210dbbb733c650d0df2f7026663cbf96cdd44f73e0598f97a0b' },
  { doc: '049 - Ronald Reagan — First Inaugural Address (1981)', title: 'Ronald Reagan — First Inaugural Address (1981)', bytes: 13731, textLengthUtf16: 13731, sourceHash: '9ee27934a85a08c5afe38c3b6074640ca99f40cb38918a0540afcac58cdece78', textHash: '9ee27934a85a08c5afe38c3b6074640ca99f40cb38918a0540afcac58cdece78' },
  { doc: '050 - Ronald Reagan — Second Inaugural Address (1985)', title: 'Ronald Reagan — Second Inaugural Address (1985)', bytes: 14545, textLengthUtf16: 14545, sourceHash: '5ac245ac99c55577767062480a979a2933dc8dc817e0eec57b8b48e624dab006', textHash: '5ac245ac99c55577767062480a979a2933dc8dc817e0eec57b8b48e624dab006' },
  { doc: '051 - George Bush — Inaugural Address (1989)', title: 'George Bush — Inaugural Address (1989)', bytes: 12505, textLengthUtf16: 12505, sourceHash: 'd3db26f28f9440f6e7a36b7dcf706ce04ce3e9a1fd0146e0feb0af8b93871c4e', textHash: 'd3db26f28f9440f6e7a36b7dcf706ce04ce3e9a1fd0146e0feb0af8b93871c4e' },
  { doc: '052 - Bill Clinton — First Inaugural Address (1993)', title: 'Bill Clinton — First Inaugural Address (1993)', bytes: 9149, textLengthUtf16: 9149, sourceHash: '53b7dda25ffd647c7ca49786a61c7401856d1d641d1a0f348ffce8dac99dc8d4', textHash: '53b7dda25ffd647c7ca49786a61c7401856d1d641d1a0f348ffce8dac99dc8d4' },
  { doc: '053 - Bill Clinton — Second Inaugural Address (1997)', title: 'Bill Clinton — Second Inaugural Address (1997)', bytes: 12190, textLengthUtf16: 12190, sourceHash: '429a3edd910fa780fe4683015706eb53aececcf42be6653433b76fc2b4396eec', textHash: '429a3edd910fa780fe4683015706eb53aececcf42be6653433b76fc2b4396eec' },
  { doc: '054 - George W. Bush — First Inaugural Address (2001)', title: 'George W. Bush — First Inaugural Address (2001)', bytes: 9005, textLengthUtf16: 9005, sourceHash: 'e716653a7aeeecfca63d62ece2da28b3032405606ae4f09cb3e36c371aa347d7', textHash: 'e716653a7aeeecfca63d62ece2da28b3032405606ae4f09cb3e36c371aa347d7' },
  { doc: '055 - George W. Bush — Second Inaugural Address (2005)', title: 'George W. Bush — Second Inaugural Address (2005)', bytes: 11929, textLengthUtf16: 11929, sourceHash: 'be54aae4be2cde2d9e1d61888abbbbed6fd1f11678d545856afbfc23ba7d9b9e', textHash: 'be54aae4be2cde2d9e1d61888abbbbed6fd1f11678d545856afbfc23ba7d9b9e' },
  { doc: '056 - Barack Hussein Obama — Inaugural Address (2009)', title: 'Barack Hussein Obama — Inaugural Address (2009)', bytes: 13368, textLengthUtf16: 13368, sourceHash: 'd18ab34f7319c6d86796a205d46620198c5cebe13066412a6a4a436b14a0eff9', textHash: 'd18ab34f7319c6d86796a205d46620198c5cebe13066412a6a4a436b14a0eff9' },
  { doc: '057 - Barack Hussein Obama — Inaugural Address (2013)', title: 'Barack Hussein Obama — Inaugural Address (2013)', bytes: 12073, textLengthUtf16: 12032, sourceHash: '3c165c1c82dae94d1540266abaecd0f577f4b59381a13f40223a0f3c82910f6f', textHash: '3c165c1c82dae94d1540266abaecd0f577f4b59381a13f40223a0f3c82910f6f' },
];

export const DARWIN_ORIGIN: readonly BuiltinDocFixture[] = [
  { doc: '001 - First Edition (1859) - Charles Darwin', title: 'First Edition (1859)', bytes: 895155, textLengthUtf16: 893719, sourceHash: 'da05aed47f41f069e3d8fcabce6948313404aa1b7deaccea89d17a81206be8b9', textHash: 'da05aed47f41f069e3d8fcabce6948313404aa1b7deaccea89d17a81206be8b9' },
  { doc: '002 - Second Edition (1860) - Charles Darwin', title: 'Second Edition (1860)', bytes: 900677, textLengthUtf16: 900467, sourceHash: '8f1966869f05a8457567bb04bee45c136f56ed1b97a345faaed672f13fda4737', textHash: '8f1966869f05a8457567bb04bee45c136f56ed1b97a345faaed672f13fda4737' },
  { doc: '003 - Third Edition (1861) - Charles Darwin', title: 'Third Edition (1861)', bytes: 978830, textLengthUtf16: 976795, sourceHash: 'c35ee631638a37efb4726b738bd6223ae25f136e0e662b04babfdb8dcab1eb4c', textHash: 'c35ee631638a37efb4726b738bd6223ae25f136e0e662b04babfdb8dcab1eb4c' },
  { doc: '004 - Fourth Edition (1866) - Charles Darwin', title: 'Fourth Edition (1866)', bytes: 1083897, textLengthUtf16: 1081862, sourceHash: 'c7aa683eab4023185267596988dea69131c5b19173f14f028c792d0a00ae7d26', textHash: 'c7aa683eab4023185267596988dea69131c5b19173f14f028c792d0a00ae7d26' },
  { doc: '005 - Fifth Edition (1869) - Charles Darwin', title: 'Fifth Edition (1869)', bytes: 1085126, textLengthUtf16: 1083891, sourceHash: '5a364545bb901e11844590265e65f9b5b589a715c73c06bdf5f27858771f86c2', textHash: '5a364545bb901e11844590265e65f9b5b589a715c73c06bdf5f27858771f86c2' },
  { doc: '006 - Sixth Edition (1872) - Charles Darwin', title: 'Sixth Edition (1872)', bytes: 1161137, textLengthUtf16: 1158738, sourceHash: 'b4d010706c93e24201e6090815880a0fc2e36926cc93682488f6ff03084459cc', textHash: 'b4d010706c93e24201e6090815880a0fc2e36926cc93682488f6ff03084459cc' },
];

export const CLASSIC_NOVELS: readonly BuiltinDocFixture[] = [
  { doc: '01 - Frankenstein - Mary Shelley', title: 'Frankenstein', bytes: 423188, textLengthUtf16: 420381, sourceHash: '31e33180cf8741439008ac25ce6653ea8e669c3a10452e78d6e6651a6d76d714', textHash: '31e33180cf8741439008ac25ce6653ea8e669c3a10452e78d6e6651a6d76d714' },
  { doc: '02 - Dracula - Bram Stoker', title: 'Dracula', bytes: 850186, textLengthUtf16: 834291, sourceHash: '6bf7465f6db728928dbd77e3c0e9a2b59bf1a215d98b30ada39757466e083746', textHash: '6bf7465f6db728928dbd77e3c0e9a2b59bf1a215d98b30ada39757466e083746' },
  { doc: '03 - Moby Dick - Herman Melville', title: 'Moby Dick', bytes: 1196000, textLengthUtf16: 1177684, sourceHash: '5ff2f2dc31aeceb8cce366b955c32252b5a1cd28935b6f8f4e0df315146ca40a', textHash: '5ff2f2dc31aeceb8cce366b955c32252b5a1cd28935b6f8f4e0df315146ca40a' },
  { doc: '04 - The Picture of Dorian Gray - Oscar Wilde', title: 'The Picture of Dorian Gray', bytes: 435499, textLengthUtf16: 426485, sourceHash: '5496572c419a3019f3c49cefaba36122b97dbdbbcc7c8653ccbfe073bfed0cca', textHash: '5496572c419a3019f3c49cefaba36122b97dbdbbcc7c8653ccbfe073bfed0cca' },
  { doc: '05 - Jane Eyre - Charlotte Brontë', title: 'Jane Eyre', bytes: 1043419, textLengthUtf16: 1016796, sourceHash: 'e141313f30142b62fc7a9bb94e2832ca08449d1604c14ea66d693476bb1a5041', textHash: 'e141313f30142b62fc7a9bb94e2832ca08449d1604c14ea66d693476bb1a5041' },
  { doc: '06 - Wuthering Heights - Emily Brontë', title: 'Wuthering Heights', bytes: 662970, textLengthUtf16: 644898, sourceHash: 'cfc70b9c345b6da97f21d38d60a375a12407b5c6ee5524b021f4e6e02128e379', textHash: 'cfc70b9c345b6da97f21d38d60a375a12407b5c6ee5524b021f4e6e02128e379' },
  { doc: '07 - Great Expectations - Charles Dickens', title: 'Great Expectations', bytes: 1018751, textLengthUtf16: 992141, sourceHash: 'fb0bb67b3fcc336723bfce5b7a83d574c63a1c92eb12d4bd3a5f5176d4f91e2a', textHash: 'fb0bb67b3fcc336723bfce5b7a83d574c63a1c92eb12d4bd3a5f5176d4f91e2a' },
  { doc: '08 - The Adventures of Huckleberry Finn - Mark Twain', title: 'The Adventures of Huckleberry Finn', bytes: 582079, textLengthUtf16: 560892, sourceHash: 'a6f62bbaf62ee41178da1bfe10b2c822110015707ce5b05c0d380362bc898868', textHash: 'a6f62bbaf62ee41178da1bfe10b2c822110015707ce5b05c0d380362bc898868' },
  { doc: '09 - Little Women - Louisa May Alcott', title: 'Little Women', bytes: 1038102, textLengthUtf16: 1010535, sourceHash: 'f9d1dfca084399822fa6d070be76f44881932133fb5e1f6a2711331da5c0e9fe', textHash: 'f9d1dfca084399822fa6d070be76f44881932133fb5e1f6a2711331da5c0e9fe' },
  { doc: '10 - Anne of Green Gables - L. M. Montgomery', title: 'Anne of Green Gables', bytes: 576456, textLengthUtf16: 558304, sourceHash: '8e6239e75c98b1a77fa18981f668037f337bece95ce3c9d48889f71e02dc4e63', textHash: '8e6239e75c98b1a77fa18981f668037f337bece95ce3c9d48889f71e02dc4e63' },
];

/** Bundled corpora as read-only `ProjectDataV1` values, each built ONCE (the
 *  recipe and empty-candidate hashes are corpus-wide constants). One project
 *  abstraction drives every origin; Sherlock is simply the initial selection.
 *  The composition root (`store-instance.ts`) awaits the registry to construct
 *  the session's initial `CurrentProject`. Lives HERE with the rest of the
 *  built-in vocabulary — the state container is not the authority for assets. */
const FIXTURES: Readonly<Record<BuiltinCorpusId, readonly BuiltinDocFixture[]>> = {
  [BUILTIN_SHERLOCK_ID]: SHERLOCK,
  [BUILTIN_AUSTEN_ID]: AUSTEN,
  [BUILTIN_BIBLE_ID]: BIBLE,
  [BUILTIN_QURAN_ID]: QURAN,
  [BUILTIN_POLITICAL_ARGUMENTS_ID]: POLITICAL_ARGUMENTS,
  [BUILTIN_SHAKESPEARE_ID]: SHAKESPEARE,
  [BUILTIN_INAUGURALS_ID]: INAUGURALS,
  [BUILTIN_DARWIN_ORIGIN_ID]: DARWIN_ORIGIN,
  [BUILTIN_CLASSIC_NOVELS_ID]: CLASSIC_NOVELS,
  [BUILTIN_ASOIF_ID]: ASOIF,
  [BUILTIN_LOTR_ID]: LOTR,
};

/** Integrity manifest for acquiring a demo as local text files. */
export function demoCorpusFixtures(id: BuiltinCorpusId): readonly BuiltinDocFixture[] {
  return FIXTURES[id];
}

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
