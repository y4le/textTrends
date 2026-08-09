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
});
