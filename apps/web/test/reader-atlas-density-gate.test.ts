import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DISPERSION_BUCKET_BUDGET,
  planDispersionGeometry,
  type CorpusSnapshotV1,
  type ResolvedSelection,
} from '@texttrends/core';
import { atlasDensitySummary } from '../src/lib/reader-atlas.ts';

const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
type ProjectDocId = CorpusSnapshotV1['docs'][number]['doc'];
type CorpusExtent = readonly [ProjectDocId, number];

function wordCount(text: string): number {
  let count = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

async function corpusExtents(directory: 'bible' | 'quran'): Promise<readonly CorpusExtent[]> {
  const root = fileURLToPath(new URL(`../../../text/${directory}/`, import.meta.url));
  const names = (await readdir(root)).filter((name) => name.endsWith('.txt')).sort();
  return Promise.all(names.map(async (name, ordinal) => [
    `${directory}-${String(ordinal + 1).padStart(3, '0')}` as ProjectDocId,
    wordCount(await readFile(new URL(name, new URL(`../../../text/${directory}/`, import.meta.url)), 'utf8')),
  ] as const));
}

function allocatedBands(extents: readonly CorpusExtent[]): readonly number[] {
  const docs = extents.map(([doc, tokenCount]) => ({ doc, tokenCount }));
  const snapshot = { docs } as unknown as CorpusSnapshotV1;
  const selection = {
    spec: { docs: docs.map(({ doc }) => doc) },
  } as unknown as ResolvedSelection;
  const geometry = planDispersionGeometry(snapshot, selection);
  return geometry.order.map((_, ordinal) =>
    geometry.bucketOffsets[ordinal + 1]! - geometry.bucketOffsets[ordinal]!);
}

describe('Atlas density feasibility gate', () => {
  it('keeps similar-size corpora above the coarse disclosure thresholds', () => {
    for (const documentCount of [2, 20, 66, 256]) {
      const extents = Array.from({ length: documentCount }, (_, ordinal) => [
        `same-${ordinal}` as ProjectDocId,
        10_000,
      ] as const);
      const summary = atlasDensitySummary(allocatedBands(extents));
      expect(summary?.documents).toBe(documentCount);
      expect(summary?.min).toBeGreaterThan(12);
    }
  });

  it('proves shipped uneven corpora fit the existing budget with honest disclosures', async () => {
    const bible = await corpusExtents('bible');
    const quran = await corpusExtents('quran');
    const cases = [
      {
        name: 'Bible', extents: bible, documents: 66,
        median: [30, 36], max: [200, 230], veryCoarse: [8, 12],
      },
      {
        name: 'Quran', extents: quran, documents: 114,
        median: [18, 22], max: [300, 320], veryCoarse: [30, 36],
      },
      {
        name: 'combined', extents: [...bible, ...quran], documents: 180,
        median: [7, 10], max: [175, 190], veryCoarse: [85, 92],
      },
    ] as const;

    for (const fixture of cases) {
      const bands = allocatedBands(fixture.extents);
      const summary = atlasDensitySummary(bands);
      expect(summary, fixture.name).not.toBeNull();
      expect(summary!.documents, fixture.name).toBe(fixture.documents);
      expect(bands.reduce((sum, count) => sum + count, 0), fixture.name)
        .toBe(DISPERSION_BUCKET_BUDGET);
      expect(summary!.min, fixture.name).toBeLessThan(8);
      expect(summary!.median, fixture.name)
        .toBeGreaterThanOrEqual(fixture.median[0]);
      expect(summary!.median, fixture.name)
        .toBeLessThanOrEqual(fixture.median[1]);
      expect(summary!.max, fixture.name)
        .toBeGreaterThanOrEqual(fixture.max[0]);
      expect(summary!.max, fixture.name)
        .toBeLessThanOrEqual(fixture.max[1]);
      expect(summary!.veryCoarse, fixture.name)
        .toBeGreaterThanOrEqual(fixture.veryCoarse[0]);
      expect(summary!.veryCoarse, fixture.name)
        .toBeLessThanOrEqual(fixture.veryCoarse[1]);
    }
  });
});
