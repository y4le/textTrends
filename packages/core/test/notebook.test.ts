import { describe, expect, it } from 'vitest';
import {
  parseQueryNotebook,
  type QueryNotebookV1,
} from '../src/project/notebook.ts';

const NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/1',
  groups: [{
    id: 'g1',
    name: 'Holmes',
    members: [{
      id: 'm1',
      kind: 'token',
      surface: 'Holmes',
      match: { case: 'sensitive', diacritics: 'sensitive' },
    }],
    countOverlaps: false,
  }],
};

describe('query notebook admission', () => {
  it('admits authored notebooks and rejects sparse or extra records', () => {
    expect(parseQueryNotebook(NOTEBOOK)).toBe(NOTEBOOK);
    expect(() => parseQueryNotebook({ ...NOTEBOOK, extra: true })).toThrow(RangeError);
    const sparse = [...NOTEBOOK.groups];
    sparse.length = 2;
    expect(() => parseQueryNotebook({ ...NOTEBOOK, groups: sparse })).toThrow(/dense/);
  });

  it('admits phrase elements and rejects malformed element records', () => {
    const phraseNotebookWith = (elements: readonly unknown[]) => ({
      ...NOTEBOOK,
      groups: [{
        ...NOTEBOOK.groups[0]!,
        members: [{
          id: 'm1', kind: 'phrase',
          elements,
          match: { case: 'folded', diacritics: 'folded' }, crossSentence: false,
        }],
      }],
    });
    const phraseNotebook = phraseNotebookWith([
      { kind: 'token', surface: 'New' }, { kind: 'prefix', stem: 'Yo' },
    ]);
    expect(parseQueryNotebook(phraseNotebook)).toBe(phraseNotebook);
    const inheritedSurface = Object.create({ kind: 'token', surface: 'New' });
    expect(() => parseQueryNotebook(phraseNotebookWith([
      { kind: 'token', surface: 'New' }, { kind: 'middle', stem: 'Yo' },
    ]))).toThrow(/malformed/);
    expect(() => parseQueryNotebook(phraseNotebookWith([
      { kind: 'token', surface: 'New', extra: true },
    ]))).toThrow(/malformed/);
    expect(() => parseQueryNotebook(phraseNotebookWith([inheritedSurface]))).toThrow(/malformed/);
  });

  it('lifts legacy v1 phrase surfaces instead of classifying the saved notebook as corrupt', () => {
    const legacy = {
      ...NOTEBOOK,
      groups: [{
        ...NOTEBOOK.groups[0]!,
        members: [{
          id: 'm1', kind: 'phrase', surfaces: ['New', 'York'],
          match: { case: 'folded', diacritics: 'folded' }, crossSentence: false,
        }],
      }],
    };
    expect(parseQueryNotebook(legacy).groups[0]!.members).toEqual([{
      id: 'm1', kind: 'phrase',
      elements: [{ kind: 'token', surface: 'New' }, { kind: 'token', surface: 'York' }],
      match: { case: 'folded', diacritics: 'folded' }, crossSentence: false,
    }]);
  });
});
