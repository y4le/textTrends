import type {
  CompanyResultV1,
  DestinationsResultV1,
} from '../shared/analysis-contract.ts';
import {
  collapseTextWithMarks,
  segmentMarks,
} from './marks-view.ts';
import type {
  DestinationFocusIntent,
  SeriesIntent,
} from './store.ts';

/** A presentation threshold derived exactly from the published Company
 * histogram. Buckets whose lower edge is below 25 represent gaps <25 tokens. */
export const COMPANY_NEARBY_GAP_EXCLUSIVE = 25;

const roundedPercent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** Keep small but real coverage distinct from zero, and near-total coverage
 * distinct from complete coverage. */
export function formatCompanyCoverage(value: number | null): string {
  if (value === null) return 'no occurrences';
  if (value === 0 || value === 1) return roundedPercent.format(value);
  if (value < 0.0005) return '<0.1%';
  if (value >= 0.9995) return '>99.9%';
  return roundedPercent.format(value);
}

export interface CompanyCoverageVM {
  readonly series: SeriesIntent;
  readonly total: number;
  readonly nearby: number;
  readonly withoutPeerInDocument: number;
  readonly coverage: number | null;
}

export interface CompanyPairVM {
  readonly key: string;
  readonly seriesIds: readonly [string, string];
  readonly left: CompanyCoverageVM;
  readonly right: CompanyCoverageVM;
  readonly mutualCoverage: number | null;
  readonly docsWithBoth: number;
  readonly selected: boolean;
}

function nearbyCount(
  histogram: readonly number[],
  edges: readonly number[],
): number {
  const cutoff = edges.indexOf(COMPANY_NEARBY_GAP_EXCLUSIVE);
  if (cutoff < 0 || histogram.length !== edges.length) {
    throw new RangeError('company/1 result does not contain the pinned 25-token histogram edge');
  }
  let total = 0;
  for (let index = 0; index < cutoff; index++) {
    total += histogram[index]!;
  }
  return total;
}

function samePair(
  focus: DestinationFocusIntent | null,
  left: string,
  right: string,
): boolean {
  if (focus === null) return false;
  return focus.seriesIds.includes(left) && focus.seriesIds.includes(right);
}

/** Project the bounded worker evidence into symmetric, explicitly directional
 * pair rows. Ranking uses the smaller directional coverage so one very common
 * term cannot make a pair look mutually close by itself. */
export function companyPairs(
  result: CompanyResultV1,
  series: readonly SeriesIntent[],
  focus: DestinationFocusIntent | null,
): CompanyPairVM[] {
  const seriesById = new Map(series.map((item) => [item.id, item]));
  const out: CompanyPairVM[] = [];
  for (const pair of result.pairs) {
    const leftTrack = result.tracks[pair.a];
    const rightTrack = result.tracks[pair.b];
    const leftSeries = leftTrack && seriesById.get(leftTrack.seriesId);
    const rightSeries = rightTrack && seriesById.get(rightTrack.seriesId);
    if (!leftTrack || !rightTrack || !leftSeries || !rightSeries) continue;
    const leftNearby = nearbyCount(pair.fromA, result.gapEdges);
    const rightNearby = nearbyCount(pair.fromB, result.gapEdges);
    const leftCoverage = leftTrack.total === 0 ? null : leftNearby / leftTrack.total;
    const rightCoverage = rightTrack.total === 0 ? null : rightNearby / rightTrack.total;
    const ids = [leftTrack.seriesId, rightTrack.seriesId] as const;
    out.push({
      key: JSON.stringify(ids),
      seriesIds: ids,
      left: {
        series: leftSeries,
        total: leftTrack.total,
        nearby: leftNearby,
        withoutPeerInDocument: pair.noneA,
        coverage: leftCoverage,
      },
      right: {
        series: rightSeries,
        total: rightTrack.total,
        nearby: rightNearby,
        withoutPeerInDocument: pair.noneB,
        coverage: rightCoverage,
      },
      mutualCoverage: leftCoverage === null || rightCoverage === null
        ? null
        : Math.min(leftCoverage, rightCoverage),
      docsWithBoth: pair.docsWithBoth,
      selected: samePair(focus, leftTrack.seriesId, rightTrack.seriesId),
    });
  }
  return out.sort((left, right) =>
    (right.mutualCoverage ?? -1) - (left.mutualCoverage ?? -1)
    || right.docsWithBoth - left.docsWithBoth
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export interface DestinationCountVM {
  readonly series: SeriesIntent;
  readonly count: number;
}

export interface DestinationTextSegmentVM {
  readonly text: string;
  readonly series: readonly SeriesIntent[];
}

export interface DestinationCardVM {
  readonly key: string;
  readonly rank: number;
  readonly doc: string;
  readonly title: string;
  readonly tokens: { readonly start: number; readonly end: number };
  readonly anchorToken: number;
  readonly anchorSeries: SeriesIntent | null;
  readonly counts: readonly DestinationCountVM[];
  readonly segments: readonly DestinationTextSegmentVM[];
  readonly marksTruncated: boolean;
}

/** Collapse display-breaking whitespace while remapping the worker's UTF-16
 * mark offsets, then split overlapping highlights into safe React text spans. */
export function destinationCards(
  result: DestinationsResultV1,
  series: readonly SeriesIntent[],
  titleByDoc: ReadonlyMap<string, string>,
): DestinationCardVM[] {
  const seriesById = new Map(series.map((item) => [item.id, item]));
  const trackSeries = result.tracks.map((track) => seriesById.get(track.seriesId) ?? null);
  return result.destinations.map((destination, rank) => {
    const collapsed = collapseTextWithMarks(
      destination.snippet.text,
      destination.snippet.marks.map((mark) => ({
        value: mark.trackOrdinal,
        start: mark.charsUtf16.start,
        end: mark.charsUtf16.end,
      })),
    );
    const segments = segmentMarks(collapsed.text.length, collapsed.marks).map((segment) => ({
      text: collapsed.text.slice(segment.start, segment.end),
      series: [...new Set(segment.values)]
        .map((ordinal) => trackSeries[ordinal])
        .filter((item): item is SeriesIntent => item !== null && item !== undefined),
    }));
    return {
      key: JSON.stringify([destination.doc, destination.tokens.start, destination.anchor.token]),
      rank: rank + 1,
      doc: destination.doc,
      title: titleByDoc.get(destination.doc) ?? destination.doc,
      tokens: { ...destination.tokens },
      anchorToken: destination.anchor.token,
      anchorSeries: seriesById.get(destination.anchor.seriesId) ?? null,
      counts: destination.counts.flatMap((count, ordinal): DestinationCountVM[] => {
        const item = trackSeries[ordinal];
        return item === null || item === undefined ? [] : [{ series: item, count }];
      }),
      segments,
      marksTruncated: destination.snippet.marksTruncated,
    };
  });
}
