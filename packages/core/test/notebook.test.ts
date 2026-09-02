import { describe, expect, it } from 'vitest';
import {
  isSeriesColor,
  NOTEBOOK_LIMITS_V1,
  parseQueryNotebook,
  type QueryNotebookV1,
} from '../src/project/notebook.ts';

const NOTEBOOK: QueryNotebookV1 = {
  schema: 'texttrends/query-notebook/3',
  groups: [{
    id: 'g1',
    aliases: ['Holmes'],
    exactMatch: true,
    countOverlaps: false,
    style: { color: 'blue', line: 'solid' },
  }],
};

describe('query notebook admission', () => {
  it('admits authored notebooks and rejects sparse or extra records', () => {
    expect(parseQueryNotebook(NOTEBOOK)).toBe(NOTEBOOK);
    expect(() => parseQueryNotebook({ ...NOTEBOOK, extra: true })).toThrow(RangeError);
    const sparse = [...NOTEBOOK.groups];
    sparse.length = 2;
    expect(() => parseQueryNotebook({ ...NOTEBOOK, groups: sparse })).toThrow(/dense/);
    expect(() => parseQueryNotebook({ ...NOTEBOOK, groups: [NOTEBOOK.groups[0]!, NOTEBOOK.groups[0]!] }))
      .toThrow(RangeError);
    expect(() => parseQueryNotebook({
      ...NOTEBOOK,
      groups: Array.from(
        { length: NOTEBOOK_LIMITS_V1.maxGroups + 1 },
        (_, index) => ({ ...NOTEBOOK.groups[0]!, id: `g${index}` }),
      ),
    })).toThrow(RangeError);
  });

  it('admits natural multiword/wildcard aliases and rejects unsupported styles', () => {
    const aliases = {
      ...NOTEBOOK,
      groups: [{ ...NOTEBOOK.groups[0]!, aliases: ['NYC', 'New York', 'New Yo*'] }],
    };
    expect(parseQueryNotebook(aliases)).toBe(aliases);
    expect(() => parseQueryNotebook({
      ...aliases,
      groups: [{ ...aliases.groups[0]!, style: { color: 'red', line: 'solid' } }],
    })).toThrow(/style/);
  });

  it('admits canonical custom colors and rejects noncanonical CSS spellings', () => {
    expect(isSeriesColor('#a1b2c3')).toBe(true);
    for (const color of ['#abc', '#ABCDEF', '#abcdef0', 'red', 'rgb(0,0,0)', '']) {
      expect(isSeriesColor(color)).toBe(false);
      expect(() => parseQueryNotebook({
        ...NOTEBOOK,
        groups: [{ ...NOTEBOOK.groups[0]!, style: { color, line: 'solid' } }],
      })).toThrow(/style/);
    }
    const custom = {
      ...NOTEBOOK,
      groups: [{ ...NOTEBOOK.groups[0]!, style: { color: '#a1b2c3', line: 'dash' } }],
    };
    expect(parseQueryNotebook(custom)).toBe(custom);
  });

  it.each([
    'texttrends/query-notebook/1',
    'texttrends/query-notebook/2',
  ])('rejects obsolete schema %s', (schema) => {
    expect(() => parseQueryNotebook({ ...NOTEBOOK, schema })).toThrow(RangeError);
  });

});
