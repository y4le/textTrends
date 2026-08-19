import { useMemo } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import { trendMatrix } from '../../lib/trend-matrix.ts';
import {
  selectedTrendsPending,
  trendRangeCompare,
} from '../../lib/trend-range-compare.ts';
import { TrendMatrix } from './TrendMatrix.tsx';
import { TrendRangeCompare } from './TrendRangeCompare.tsx';

/**
 * The second Trends organ. It intentionally does not subscribe to scrub or
 * interaction state: pointer motion must not rebuild a term × book matrix.
 */
export function TrendDistribution() {
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const series = useApp((state) => state.series);
  const trends = useApp((state) => state.trends);
  const ranged = useApp((state) => state.selectedTrends);
  const selection = useApp((state) => state.linkedSelection);
  const measure = useApp((state) => state.trendMeasure);
  const docs = snapshot?.readyDocs ?? [];
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const matrix = useMemo(
    () => trendMatrix({ docs, series, trends }),
    [docs, series, trends],
  );
  const rangePending = selection !== null && selectedTrendsPending(series, ranged);
  const comparison = useMemo(
    () => trendRangeCompare({ series, baseline: trends, ranged }),
    [ranged, series, trends],
  );

  if (series.length === 0 || docs.length === 0) return null;
  if (selection !== null && !rangePending) {
    return <TrendRangeCompare vm={comparison} />;
  }
  return (
    <TrendMatrix
      vm={matrix}
      titleByDoc={titleByDoc}
      graphShowsCounts={measure.kind === 'count'}
      pendingRange={rangePending}
    />
  );
}
