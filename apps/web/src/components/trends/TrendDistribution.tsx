import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import {
  selectedTrendsPending,
  trendRangeCompare,
} from '../../lib/trend-range-compare.ts';
import { TrendRangeCompare } from './TrendRangeCompare.tsx';
import { TrendOverview } from './TrendOverview.tsx';

/**
 * The second Trends organ. It intentionally does not subscribe to scrub or
 * interaction state: pointer motion must not rebuild overview projections.
 */
export function TrendDistribution() {
  const focusRangeWhenReady = useRef(false);
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const series = useApp((state) => state.series);
  const trends = useApp((state) => state.trends);
  const ranged = useApp((state) => state.selectedTrends);
  const selection = useApp((state) => state.linkedSelection);
  const company = useApp((state) => state.company);
  const destinations = useApp((state) => state.destinations);
  const destinationFocus = useApp((state) => state.destinationFocus);
  const setDestinationFocus = useApp((state) => state.setDestinationFocus);
  const setLinkedSelection = useApp((state) => state.setLinkedSelection);
  const openReader = useApp((state) => state.openReader);
  const docs = snapshot?.readyDocs ?? [];
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const rangePending = selection !== null && selectedTrendsPending(series, ranged);
  const comparison = useMemo(
    () => trendRangeCompare({ series, baseline: trends, ranged }),
    [ranged, series, trends],
  );
  const compare = useCallback((
    snapshotId: string,
    doc: string,
    tokens: { readonly start: number; readonly end: number },
  ) => {
    if (snapshot?.snapshot !== snapshotId) return;
    focusRangeWhenReady.current = true;
    setLinkedSelection({
      snapshot: snapshotId,
      ranges: [{ doc, tokens: { ...tokens } }],
    });
  }, [setLinkedSelection, snapshot]);

  useEffect(() => {
    if (selection === null) {
      focusRangeWhenReady.current = false;
      return;
    }
    if (rangePending || !focusRangeWhenReady.current) return;
    focusRangeWhenReady.current = false;
    document.getElementById('trend-range-heading')?.focus({ preventScroll: true });
  }, [rangePending, selection]);

  if (series.length === 0 || docs.length === 0) return null;
  if (selection !== null && !rangePending) {
    return <TrendRangeCompare vm={comparison} />;
  }
  return (
    <TrendOverview
      company={company}
      destinations={destinations}
      series={series}
      titleByDoc={titleByDoc}
      focus={destinationFocus}
      pendingRange={rangePending}
      setFocus={setDestinationFocus}
      openReader={openReader}
      compare={compare}
    />
  );
}
