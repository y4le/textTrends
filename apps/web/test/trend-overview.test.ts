import { describe, expect, it } from 'vitest';
import type {
  CompanyResultV1,
  DestinationsResultV1,
} from '../src/shared/analysis-contract.ts';
import type { SeriesIntent } from '../src/lib/store.ts';
import {
  companyPairs,
  destinationCards,
  formatCompanyCoverage,
} from '../src/lib/trend-overview.ts';

const wolf: SeriesIntent = {
  id: 'wolf',
  label: 'wolves',
  style: { color: 'blue', line: 'solid' },
};
const fox: SeriesIntent = {
  id: 'fox',
  label: 'foxes',
  style: { color: 'orange', line: 'dash' },
};
const moon: SeriesIntent = {
  id: 'moon',
  label: 'moon',
  style: { color: 'violet', line: 'dot' },
};

const edges = [0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100, 200];

describe('Company overview projection', () => {
  it('keeps directional coverage separate, ranks by the weaker side, and retains focus by series id', () => {
    const result: CompanyResultV1 = {
      method: 'company/1',
      gapEdges: edges,
      tracks: [
        { seriesId: 'wolf', groupId: 'g-wolf', total: 10, docCount: 2 },
        { seriesId: 'fox', groupId: 'g-fox', total: 4, docCount: 2 },
        { seriesId: 'moon', groupId: 'g-moon', total: 2, docCount: 1 },
      ],
      corpusTokens: 1_000,
      pairs: [
        {
          a: 0, b: 1,
          fromA: [1, 1, 0, 0, 0, 1, 0, 1, 0, 5, 0, 0, 0],
          fromB: [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
          noneA: 1, noneB: 0,
          forwardA: 0, backwardA: 0, tiedA: 0, overlapA: 1,
          forwardB: 0, backwardB: 0, tiedB: 0, overlapB: 1,
          docsWithBoth: 2,
        },
        {
          a: 1, b: 2,
          fromA: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          fromB: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          noneA: 3, noneB: 1,
          forwardA: 0, backwardA: 0, tiedA: 0, overlapA: 1,
          forwardB: 0, backwardB: 0, tiedB: 0, overlapB: 1,
          docsWithBoth: 1,
        },
      ],
    };
    const rows = companyPairs(result, [moon, wolf, fox], { seriesIds: ['fox', 'wolf'] });
    expect(rows.map((row) => row.seriesIds)).toEqual([
      ['wolf', 'fox'],
      ['fox', 'moon'],
    ]);
    expect(rows[0]).toMatchObject({
      selected: true,
      docsWithBoth: 2,
      left: { nearby: 4, total: 10, coverage: 0.4, withoutPeerInDocument: 1 },
      right: { nearby: 3, total: 4, coverage: 0.75, withoutPeerInDocument: 0 },
      mutualCoverage: 0.4,
    });
    expect(rows[1]?.mutualCoverage).toBe(0.25);
  });

  it('reports null rather than a fabricated zero rate for an absent track', () => {
    const result: CompanyResultV1 = {
      method: 'company/1',
      gapEdges: edges,
      tracks: [
        { seriesId: 'wolf', groupId: 'g-wolf', total: 0, docCount: 0 },
        { seriesId: 'fox', groupId: 'g-fox', total: 1, docCount: 1 },
      ],
      corpusTokens: 20,
      pairs: [{
        a: 0, b: 1,
        fromA: edges.map(() => 0), fromB: edges.map(() => 0),
        noneA: 0, noneB: 1,
        forwardA: 0, backwardA: 0, tiedA: 0, overlapA: 0,
        forwardB: 0, backwardB: 0, tiedB: 0, overlapB: 0,
        docsWithBoth: 0,
      }],
    };
    expect(companyPairs(result, [wolf, fox], null)[0]).toMatchObject({
      left: { coverage: null },
      right: { coverage: 0 },
      mutualCoverage: null,
    });
  });

  it('keeps real near-zero and near-total coverage distinct from exact endpoints', () => {
    expect(formatCompanyCoverage(null)).toBe('no occurrences');
    expect(formatCompanyCoverage(0)).toBe('0%');
    expect(formatCompanyCoverage(0.000_1)).toBe('<0.1%');
    expect(formatCompanyCoverage(0.999_5)).toBe('>99.9%');
    expect(formatCompanyCoverage(0.999_9)).toBe('>99.9%');
    expect(formatCompanyCoverage(1)).toBe('100%');
  });

  it('refuses a histogram whose published threshold edge has drifted', () => {
    const result: CompanyResultV1 = {
      method: 'company/1',
      gapEdges: [0, 10, 50],
      tracks: [
        { seriesId: 'wolf', groupId: 'g-wolf', total: 1, docCount: 1 },
        { seriesId: 'fox', groupId: 'g-fox', total: 1, docCount: 1 },
      ],
      corpusTokens: 20,
      pairs: [{
        a: 0, b: 1,
        fromA: [1, 0, 0], fromB: [1, 0, 0],
        noneA: 0, noneB: 0,
        forwardA: 0, backwardA: 0, tiedA: 0, overlapA: 1,
        forwardB: 0, backwardB: 0, tiedB: 0, overlapB: 1,
        docsWithBoth: 1,
      }],
    };
    expect(() => companyPairs(result, [wolf, fox], null))
      .toThrow('pinned 25-token histogram edge');
  });
});

describe('Reading Destinations projection', () => {
  it('collapses excerpt whitespace while preserving UTF-16 highlight ownership and evidence counts', () => {
    const result: DestinationsResultV1 = {
      method: 'destinations/1',
      windowTokens: 400,
      focus: null,
      tracks: [
        { seriesId: 'wolf', groupId: 'g-wolf', total: 8, weight: 65_536 },
        { seriesId: 'fox', groupId: 'g-fox', total: 3, weight: 131_072 },
      ],
      destinations: [{
        doc: 'a',
        tokens: { start: 20, end: 420 },
        score: 10,
        presentTracks: 2,
        counts: [2, 1],
        anchor: { seriesId: 'fox', groupId: 'g-fox', token: 31 },
        snippet: {
          tokens: { start: 25, end: 40 },
          docCharsUtf16: { start: 100, end: 118 },
          text: '  wolf\nmeets fox  ',
          marks: [
            { trackOrdinal: 0, tokens: { start: 26, end: 27 }, charsUtf16: { start: 2, end: 6 } },
            { trackOrdinal: 1, tokens: { start: 31, end: 32 }, charsUtf16: { start: 13, end: 16 } },
          ],
          marksTruncated: true,
        },
      }],
    };
    const [card] = destinationCards(result, [fox, wolf], new Map([['a', 'A Study in Scarlet']]));
    expect(card).toMatchObject({
      rank: 1,
      doc: 'a',
      title: 'A Study in Scarlet',
      tokens: { start: 20, end: 420 },
      anchorToken: 31,
      anchorSeries: { id: 'fox' },
      counts: [
        { series: { id: 'wolf' }, count: 2 },
        { series: { id: 'fox' }, count: 1 },
      ],
      marksTruncated: true,
    });
    expect(card?.segments.map((segment) => ({
      text: segment.text,
      ids: segment.series.map((item) => item.id),
    }))).toEqual([
      { text: 'wolf', ids: ['wolf'] },
      { text: ' meets ', ids: [] },
      { text: 'fox', ids: ['fox'] },
    ]);
  });
});
