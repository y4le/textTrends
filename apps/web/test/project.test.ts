import { describe, expect, it } from 'vitest';
import { workspaceState } from './support/workspace-fixtures.ts';
import {
  BUILTIN_AUSTEN_ID,
  BUILTIN_BIBLE_ID,
  BUILTIN_CLASSIC_NOVELS_ID,
  BUILTIN_CORPORA,
  BUILTIN_DARWIN_ORIGIN_ID,
  BUILTIN_INAUGURALS_ID,
  BUILTIN_POLITICAL_ARGUMENTS_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_SHAKESPEARE_ID,
  BUILTIN_SHERLOCK_ID,
  FEATURED_DEMO_IDS,
  SHERLOCK,
  builtinProjectData,
  demoCorpusFixtures,
  generationSpecsFromProject,
  libraryProject,
  reconcileLibraryWorkspace,
  sherlockProjectData,
  type BuiltinCorpusId,
  type ProjectDataV1,
} from '../src/lib/project.ts';

const builtin = () => sherlockProjectData();

describe('bundled corpora', () => {
  it('ships the complete public demo shelf at the intended document granularity', () => {
    const counts = new Map<BuiltinCorpusId, number>([
      [BUILTIN_SHERLOCK_ID, 9],
      [BUILTIN_AUSTEN_ID, 6],
      [BUILTIN_BIBLE_ID, 66],
      [BUILTIN_QURAN_ID, 114],
      [BUILTIN_POLITICAL_ARGUMENTS_ID, 7],
      [BUILTIN_SHAKESPEARE_ID, 39],
      [BUILTIN_INAUGURALS_ID, 57],
      [BUILTIN_DARWIN_ORIGIN_ID, 6],
      [BUILTIN_CLASSIC_NOVELS_ID, 10],
    ]);

    expect(FEATURED_DEMO_IDS).toEqual([...counts.keys()]);
    for (const [id, count] of counts) expect(demoCorpusFixtures(id)).toHaveLength(count);
  });

  it('starts Sherlock with a three-term comparison', () => {
    const sherlock = BUILTIN_CORPORA.find((corpus) => corpus.id === BUILTIN_SHERLOCK_ID);
    expect(sherlock?.defaultTerms).toBe('Holmes, Watson, Moriarty');
  });

  it('starts Austen with the cross-novel terms selected from corpus evidence', () => {
    const austen = BUILTIN_CORPORA.find((corpus) => corpus.id === BUILTIN_AUSTEN_ID);
    expect(austen?.defaultTerms).toBe('family, friend, heart');
  });

  it('builds every demo in declared order with bundled TXT sources', async () => {
    for (const corpus of BUILTIN_CORPORA) {
      const fixtures = demoCorpusFixtures(corpus.id);
      const data = await builtinProjectData(corpus.id);
      expect(data.id).toBe(corpus.id);
      expect(data.order).toEqual(fixtures.map((entry) => entry.doc));
      expect(data.docs.every((doc) => doc.sourceAvailability === 'bundled' && doc.source.format === 'txt')).toBe(true);
      expect(data.docs.map((doc) => doc.sourceName)).toEqual(
        fixtures.map((entry) => `${corpus.sourceDirectory}/${entry.doc}`),
      );
    }
  });

  it('matches every shipped source byte-for-byte', async () => {
    const { readFile } = await import('node:fs/promises');
    const { hashSourceBytes, hashText } = await import('@texttrends/core');
    for (const corpus of BUILTIN_CORPORA) {
      const data = await builtinProjectData(corpus.id);
      for (const doc of data.docs) {
        const bytes = await readFile(new URL(`../public/corpora/${doc.sourceName}.txt`, import.meta.url));
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        expect(bytes.byteLength, doc.doc).toBe(doc.source.byteLength);
        expect(decoded.length, doc.doc).toBe(doc.extraction.textLengthUtf16);
        expect(await hashSourceBytes(new Uint8Array(bytes)), doc.doc).toBe(doc.source.hash);
        expect(await hashText(decoded), doc.doc).toBe(doc.extraction.text);
      }
    }
  });
});

describe('generation specs', () => {
  it('maps the runtime corpus in declared order with verified warm identities', async () => {
    const data = await builtin();
    const specs = generationSpecsFromProject(data);
    expect(specs.map((spec) => spec.doc)).toEqual(SHERLOCK.map((entry) => entry.doc));
    expect(specs[0]!.source).toMatchObject({
      expectedHash: SHERLOCK[0]!.sourceHash,
      byteLength: SHERLOCK[0]!.bytes,
      format: 'txt',
    });
    expect(specs[0]!.extraction).toMatchObject({
      expectedText: SHERLOCK[0]!.textHash,
      expectedTextLengthUtf16: SHERLOCK[0]!.textLengthUtf16,
    });
  });

  it('respects reorder and refuses an order entry without a document', async () => {
    const base = await builtin();
    const reordered: ProjectDataV1 = { ...base, order: [...base.order].reverse() };
    expect(generationSpecsFromProject(reordered).map((spec) => spec.doc)).toEqual(reordered.order);
    expect(() => generationSpecsFromProject({ ...base, order: [...base.order, 'ghost'] })).toThrow(/not in docs/);
  });
});

describe('library workspace runtime', () => {
  it('drops missing library references and clears departed Compare selections', () => {
    const workspace = workspaceState({
      corpus: {
        kind: 'library',
        order: ['a', 'b'],
        docs: [
          { doc: 'a', library: `txt:${'a'.repeat(64)}`, meta: { title: 'A', language: 'en', tags: [] } },
          { doc: 'b', library: `txt:${'b'.repeat(64)}`, meta: { title: 'B', language: 'en', tags: [] } },
        ],
      },
      views: {
        ...workspaceState().views,
        compare: { ...workspaceState().views.compare, documentA: 'a', documentB: 'b' },
      },
    });
    const result = reconcileLibraryWorkspace(workspace, new Set([`txt:${'a'.repeat(64)}`]));
    expect(result.removedDocuments).toEqual(['b']);
    expect(result.workspace.corpus).toMatchObject({ kind: 'library', order: ['a'] });
    expect(result.workspace.views.compare).toMatchObject({ documentA: 'a', documentB: null });
  });

  it('derives library worker inputs and treats warm text as optional', async () => {
    const id = `txt:${'c'.repeat(64)}`;
    const workspace = workspaceState({
      corpus: {
        kind: 'library',
        order: ['doc'],
        docs: [{ doc: 'doc', library: id, meta: { title: 'Book', language: 'en', tags: [] } }],
      },
    });
    const project = await libraryProject(workspace, new Map([[id, {
      id,
      name: 'book.txt',
      size: 12,
      format: 'txt' as const,
      contentHash: 'c'.repeat(64),
    }]]));
    expect(project.kind).toBe('library');
    expect(project.data.docs[0]).toMatchObject({
      doc: 'doc',
      library: id,
      sourceName: 'book.txt',
      source: { hash: 'c'.repeat(64), byteLength: 12, format: 'txt' },
      sourceAvailability: 'library',
    });
    expect(project.data.docs[0]!.extraction.text).toBeUndefined();
  });
});
