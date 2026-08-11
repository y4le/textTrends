import { describe, expect, it } from 'vitest';
import {
  coreGroupOf,
  isSeriesColor,
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

  it('retags query-notebook/2 losslessly and never admits custom colors under the old tag', () => {
    const legacyV2 = { ...NOTEBOOK, schema: 'texttrends/query-notebook/2' };
    expect(parseQueryNotebook(legacyV2)).toEqual(NOTEBOOK);
    expect(() => parseQueryNotebook({
      ...legacyV2,
      groups: [{ ...NOTEBOOK.groups[0]!, style: { color: '#a1b2c3', line: 'solid' } }],
    })).toThrow(/query-notebook\/2/);
  });

  it('lifts legacy v1 phrase surfaces instead of classifying the saved notebook as corrupt', () => {
    const legacy = {
      schema: 'texttrends/query-notebook/1',
      groups: [{
        id: 'g1', name: 'New York', countOverlaps: false,
        members: [{
          id: 'm1', kind: 'phrase', surfaces: ['New', 'York'],
          match: { case: 'folded', diacritics: 'folded' }, crossSentence: false,
        }],
      }],
    };
    expect(parseQueryNotebook(legacy)).toEqual({
      schema: 'texttrends/query-notebook/3',
      groups: [{
        id: 'g1', aliases: ['New York'], exactMatch: false, countOverlaps: false,
        style: { color: 'blue', line: 'solid' },
      }],
    });
  });

  it('collapses mixed legacy modes conservatively and deduplicates aliases after the collapse', () => {
    const parsed = parseQueryNotebook({
      schema: 'texttrends/query-notebook/1',
      groups: [{
        id: 'g1', name: 'Mixed', countOverlaps: false,
        members: [
          { id: 'm1', kind: 'token', surface: 'wolf', match: { case: 'folded', diacritics: 'folded' } },
          { id: 'm2', kind: 'token', surface: 'bear', match: { case: 'sensitive', diacritics: 'folded' } },
          { id: 'm3', kind: 'token', surface: 'wolf', match: { case: 'sensitive', diacritics: 'sensitive' } },
        ],
      }],
    });
    expect(parsed.groups[0]).toMatchObject({
      aliases: ['wolf', 'bear'],
      displayName: 'Mixed',
      exactMatch: true,
    });
    expect(coreGroupOf(parsed.groups[0]!).members.every((member) =>
      member.match.case === 'sensitive' && member.match.diacritics === 'sensitive')).toBe(true);
  });

  it('pins the deliberate v1 collapse of phrase boundaries and literal stars', () => {
    const parsed = parseQueryNotebook({
      schema: 'texttrends/query-notebook/1',
      groups: [{
        id: 'g1', name: 'Legacy', countOverlaps: false,
        members: [
          {
            id: 'm1', kind: 'phrase', surfaces: ['New', 'York'],
            match: { case: 'folded', diacritics: 'folded' }, crossSentence: true,
          },
          {
            id: 'm2', kind: 'token', surface: 'wolf*',
            match: { case: 'folded', diacritics: 'folded' },
          },
        ],
      }],
    });
    expect(parsed.groups[0]!.aliases).toEqual(['New York', 'wolf*']);
    expect(coreGroupOf(parsed.groups[0]!).members).toMatchObject([
      { kind: 'phrase', crossSentence: false },
      { kind: 'prefix', stem: 'wolf' },
    ]);
  });

  it('admits a maximum legacy affix stem and omits only unusable punctuation groups', () => {
    const stem = 'x'.repeat(256);
    const parsed = parseQueryNotebook({
      schema: 'texttrends/query-notebook/1',
      groups: [
        {
          id: 'affix', name: 'Affix', countOverlaps: false,
          members: [{
            id: 'm1', kind: 'prefix', stem,
            match: { case: 'folded', diacritics: 'folded' },
          }],
        },
        {
          id: 'punct', name: 'Punctuation', countOverlaps: false,
          members: [{
            id: 'm2', kind: 'token', surface: '★',
            match: { case: 'folded', diacritics: 'folded' },
          }],
        },
      ],
    });
    expect(parsed.groups.map((group) => group.id)).toEqual(['affix']);
    expect(parsed.groups[0]!.aliases).toEqual([`${stem}*`]);
  });
});
