import { describe, expect, it } from 'vitest';
import { EMPTY_NOTEBOOK } from '../src/project/notebook.ts';
import {
  parseWorkspace,
  reconcileWorkspaceDocuments,
  type WorkspaceV1,
} from '../src/project/workspace.ts';

const HASH = 'a'.repeat(64);

function validWorkspace(): WorkspaceV1 {
  return {
    schema: 'texttrends/workspace/1',
    corpus: {
      kind: 'library',
      order: ['one'],
      docs: [{
        doc: 'one',
        library: `txt:${HASH}`,
        meta: { title: 'One', language: 'en', tags: ['fiction'] },
        warm: { textHash: HASH, textLengthUtf16: 10 },
      }],
    },
    notebook: EMPTY_NOTEBOOK,
    active: [],
    kwicEnabled: [],
    views: {
      trend: {
        mode: 'by-book',
        focusedDoc: 'one',
        bins: { mode: 'per-doc', count: 40 },
        measure: { kind: 'count' },
      },
      frequency: {
        minCount: 2,
        minDocFreq: 1,
        classes: ['lexical', 'numeral'],
        prefixNfc: 'é',
        sort: { by: 'count', dir: -1 },
        pageSize: 100,
      },
      compare: {
        mode: 'documents',
        documentA: 'one',
        documentB: 'missing',
        restOn: 'b',
        minCountTotal: 2,
        minDocFreqTotal: 1,
        classes: ['lexical'],
        sort: { by: 'g2', dirA: -1, dirB: 1 },
        pageSize: 50,
      },
    },
  };
}

describe('workspace admission', () => {
  it('admits an exact library-backed workspace', () => {
    expect(parseWorkspace(validWorkspace())).toEqual(validWorkspace());
  });

  it('rejects dangling or malformed durable identities', () => {
    const value = validWorkspace();
    if (value.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
    const corpus = value.corpus;
    expect(() => parseWorkspace({
      ...value,
      corpus: { ...value.corpus, order: ['different'] },
    })).toThrow(/order and documents/);
    expect(() => parseWorkspace({
      ...value,
      corpus: {
        kind: 'library',
        order: ['one'],
        docs: [{ ...corpus.docs[0], library: `source/txt:${HASH}` }],
      },
    })).toThrow(/library identity/);
  });

  it('treats warm text identity as a bounded cache hint', () => {
    const value = validWorkspace();
    if (value.corpus.kind !== 'library') throw new Error('fixture must be library-backed');
    const corpus = value.corpus;
    expect(() => parseWorkspace({
      ...value,
      corpus: {
        kind: 'library',
        order: ['one'],
        docs: [{
          ...corpus.docs[0],
          warm: { textHash: 'not-a-hash', textLengthUtf16: 10 },
        }],
      },
    })).toThrow(/warm text hint/);
  });

  it('reconciles presentation references against the opened corpus', () => {
    const reconciled = reconcileWorkspaceDocuments(validWorkspace(), new Set(['one']));
    expect(reconciled.views.trend.focusedDoc).toBe('one');
    expect(reconciled.views.compare.documentA).toBe('one');
    expect(reconciled.views.compare.documentB).toBeNull();
  });
});
