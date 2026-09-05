/**
 * Global corpus-order reading instrument. Passage (when present), sparkline,
 * progress, and barcode share one declared-sequence token axis. Reader keeps
 * the analytical lanes but gives its source-text lane to the fitted page.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from 'react';
import type { NumericTrend, SeriesStyleV1 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { findScope } from '../lib/interaction.ts';
import { sequenceLayoutFor, type FooterGeometry } from '../lib/footer-view.ts';
import { trendDisplayValues } from '../lib/trend-display.ts';
import {
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  seriesXFromTokenEdge,
  trendBinSpan,
  type SequenceLayout,
} from '../lib/trend-geometry.ts';
import { projectedBarcodeTracks } from '../lib/trend-stage.ts';
import {
  DEFAULT_SERIES_STYLE,
  findSeriesHaloStrokeWidth,
  findSeriesStrokeWidth,
  GHOST_SERIES_OPACITY,
  ghostSeriesStrokeWidth,
  seriesColor,
  seriesDash,
  seriesLinecap,
} from '../lib/series-style.ts';
import { trendSeriesGate } from '../lib/trend-series-gate.ts';
import { guideAnchorProps } from '../lib/guide/anchors.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { BarcodeBand } from './BarcodeStrip.tsx';
import { FooterInteractive } from './footer/FooterInteractive.tsx';

const BOUNDARY_GAP = 1;

interface FooterSeries {
  readonly id: string;
  readonly style: SeriesStyleV1;
  readonly trend: NumericTrend;
  readonly values: Float64Array;
  readonly ghost?: boolean;
}

function FooterCommitProbe() {
  useEffect(() => {
    const target = window as unknown as { __ttFooterCommits?: number };
    target.__ttFooterCommits = (target.__ttFooterCommits ?? 0) + 1;
  });
  return null;
}

const FooterSparkline = memo(function FooterSparkline({
  series,
  docs,
  layout,
  width,
  geometry,
}: {
  readonly series: readonly FooterSeries[];
  readonly docs: readonly string[];
  readonly layout: SequenceLayout;
  readonly width: number;
  readonly geometry: FooterGeometry;
}) {
  let maxValue = 0;
  for (const item of series) {
    for (const value of item.values) {
      if (Number.isFinite(value)) maxValue = Math.max(maxValue, value);
    }
  }
  const y = linearMap(0, maxValue, geometry.seriesHeight, geometry.topPad);
  const hasGhostContext = series.some((item) => item.ghost);
  return (
    <svg
      className="footer-sparkline"
      width={width}
      height={geometry.seriesHeight}
      aria-hidden="true"
    >
      {__TT_E2E__ && <FooterCommitProbe />}
      {series.flatMap((item) => docs.flatMap((doc, d) => {
        const x0 = seriesXFromTokenEdge(d, 0, width, layout);
        const x1 = seriesXFromTokenEdge(
          d,
          layout.tokenCounts[d] ?? 0,
          width,
          layout,
        );
        return selectedTrendPathData(
          item.trend,
          doc,
          item.values,
          (bin) => {
            const span = trendBinSpan(item.trend, d, bin);
            const center = (span.start + span.end) / 2;
            return clampToSpan(
              seriesXFromTokenEdge(d, center, width, layout),
              x0,
              x1,
              d > 0 ? BOUNDARY_GAP : 0,
              BOUNDARY_GAP,
            );
          },
          y,
        ).map((path, index) => (
          <g key={`${item.id}:${doc}:${index}`}>
            {!item.ghost && hasGhostContext && (
              <path
                data-footer-series-find-halo={item.id}
                d={path}
                fill="none"
                stroke="var(--bg)"
                strokeWidth={findSeriesHaloStrokeWidth(geometry.strokeWidth)}
                strokeDasharray={seriesDash(item.style)}
                strokeLinecap={seriesLinecap(item.style)}
                opacity={0.92}
                pointerEvents="none"
              />
            )}
            <path
              data-footer-series-path={item.id}
              data-footer-series-ghost={item.ghost || undefined}
              data-footer-series-find-foreground={!item.ghost && hasGhostContext || undefined}
              d={path}
              fill="none"
              stroke={seriesColor(item.style)}
              strokeWidth={item.ghost
                ? ghostSeriesStrokeWidth(geometry.strokeWidth)
                : hasGhostContext
                  ? findSeriesStrokeWidth(geometry.strokeWidth)
                  : geometry.strokeWidth}
              strokeDasharray={seriesDash(item.style)}
              strokeLinecap={seriesLinecap(item.style)}
              opacity={item.ghost ? GHOST_SERIES_OPACITY : 1}
              pointerEvents={item.ghost ? 'none' : undefined}
            />
          </g>
        ));
      }))}
    </svg>
  );
});

export function WorkbenchFooter({
  globalShortcuts = false,
  geometry,
  blockSize,
  trackCount,
  showStatus,
  showBarcode,
  showPassage = true,
}: {
  readonly globalShortcuts?: boolean;
  readonly geometry: FooterGeometry;
  readonly blockSize: number;
  readonly trackCount: number;
  readonly showStatus: boolean;
  readonly showBarcode: boolean;
  readonly showPassage?: boolean;
}) {
  const presentation = usePresentation();
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const series = useApp((state) => state.series);
  const interaction = useApp((state) => state.interaction);
  const trends = useApp((state) => state.trends);
  const dispersion = useApp((state) => state.dispersion);
  const selectedDispersion = useApp((state) => state.selectedDispersion);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const measure = useApp((state) => state.trendMeasure);
  const coarse = presentation.coarseAvailable;
  const docs = snapshot?.readyDocs ?? [];
  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const find = scopedFind?.find ?? null;
  const displayedSeries = useMemo<readonly {
    readonly id: string;
    readonly label: string;
    readonly style: SeriesStyleV1;
  }[]>(() => findMode
    ? find === null
      ? []
      : [{ id: find.query.seriesId, label: find.query.label, style: find.query.style }]
    : series,
  [find, findMode, series]);
  const firstReady = findMode
    ? find?.trend.status === 'ready' ? find.trend : null
    : [...trends.values()].find((state) => state.status === 'ready') ?? null;
  const referenceTrend = firstReady?.status === 'ready' ? firstReady.trend : null;
  const layout = useMemo(() => referenceTrend?.sequenceBases
    ? {
        bases: referenceTrend.sequenceBases,
        tokenCounts: referenceTrend.docTokenCount,
        totalTokens: referenceTrend.order.length === 0
          ? 0
          : (referenceTrend.sequenceBases.at(-1) ?? 0)
            + (referenceTrend.docTokenCount.at(-1) ?? 0),
      }
    : sequenceLayoutFor(docs, (doc) => corpusTokenCounts.get(doc)),
  [corpusTokenCounts, docs, referenceTrend]);
  const seriesOrder = useMemo(
    () => displayedSeries.map((item) => item.id),
    [displayedSeries],
  );
  const tracks = projectedBarcodeTracks(
    findMode
      ? find?.dispersion.status === 'ready' ? find.dispersion.result : null
      : dispersion?.state.status === 'ready' ? dispersion.state.result : null,
    docs,
    seriesOrder,
  );
  const selectedDocs = findMode ? [] : linkedSelection?.ranges.map((range) => range.doc) ?? [];
  const selectedTracks = projectedBarcodeTracks(
    !findMode && selectedDispersion?.state.status === 'ready'
      ? selectedDispersion.state.result
      : null,
    selectedDocs,
    seriesOrder,
  );
  const reservedTrackCount = Math.max(0, Math.floor(trackCount));
  const barcodeHeight = reservedTrackCount
    * (geometry.barcodeTrackHeight + geometry.barcodeTrackGap);
  const visible = snapshot !== null && docs.length > 0 && layout.totalTokens > 0;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1);
  useLayoutEffect(() => {
    if (!container) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(1, Math.round(entry?.contentRect.width ?? 0));
      setWidth((current) => current === next ? current : next);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);
  const edgeX = useCallback(
    (docOrdinal: number, token: number) =>
      seriesXFromTokenEdge(docOrdinal, token, width, layout),
    [layout, width],
  );
  const stateFor = (id: string) => findMode && find?.query.seriesId === id
    ? find.trend
    : trends.get(id);
  const durableStates = findMode ? series.map((item) => trends.get(item.id)) : [];
  const graphGate = findMode && find === null
    ? trendSeriesGate(durableStates, [])
    : trendSeriesGate(
        displayedSeries.map((item) => stateFor(item.id)),
        durableStates,
      );
  const readySeries = useMemo<FooterSeries[]>(() => {
    if (graphGate !== 'ready') return [];
    const activeReady = displayedSeries.flatMap((item) => {
      const state = findMode && find?.query.seriesId === item.id
        ? find.trend
        : trends.get(item.id);
      return state?.status === 'ready'
        ? [{
            id: item.id,
            style: item.style,
            trend: state.trend,
            values: trendDisplayValues(state.trend, measure),
        }]
        : [];
    });
    const ghostReady = findMode
      ? series.flatMap((item) => {
          const state = trends.get(item.id);
          return state?.status === 'ready'
            ? [{
                id: item.id,
                style: item.style,
                trend: state.trend,
                values: trendDisplayValues(state.trend, measure),
                ghost: true,
              }]
            : [];
        })
      : [];
    return [...ghostReady, ...activeReady];
  }, [displayedSeries, find, findMode, graphGate, measure, series, trends]);
  const pending = graphGate === 'pending';
  const failed = displayedSeries.filter((item) =>
    (findMode && find?.query.seriesId === item.id ? find.trend : trends.get(item.id))?.status === 'error')
    .length;
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const backgroundTracks = projectedBarcodeTracks(
    findMode && dispersion?.state.status === 'ready' ? dispersion.state.result : null,
    docs,
    series.map((item) => item.id),
  );
  if (!visible) return null;
  const range = linkedSelection && linkedSelection.ranges.length > 0
    ? {
        first: linkedSelection.ranges[0]!,
        last: linkedSelection.ranges.at(-1)!,
      }
    : null;
  const firstOrdinal = range ? docs.indexOf(range.first.doc) : -1;
  const lastOrdinal = range ? docs.indexOf(range.last.doc) : -1;
  const rangeLeft = range && firstOrdinal >= 0
    ? edgeX(firstOrdinal, range.first.tokens.start)
    : null;
  const rangeRight = range && lastOrdinal >= 0
    ? edgeX(lastOrdinal, range.last.tokens.end)
    : null;
  const strip = (
    <div
      className="footer-strip-static"
      style={{
        top: 'auto',
        bottom: 0,
        height: geometry.seriesHeight
          + (showBarcode && reservedTrackCount > 0
            ? geometry.barcodeBandGap + barcodeHeight
            : 0),
      }}
    >
      <FooterSparkline
        series={readySeries}
        docs={docs}
        layout={layout}
        width={width}
        geometry={geometry}
      />
      {showBarcode && (tracks.length > 0 || backgroundTracks.length > 0) && (
        <BarcodeBand
          view="series"
          docs={docs}
          tracks={tracks}
          backgroundTracks={backgroundTracks}
          selectedTracks={selectedTracks}
          linkedSelection={!findMode && linkedSelection !== null}
          edgeX={edgeX}
          width={width}
          plotHeight={geometry.seriesHeight}
          rowPitch={0}
          bandGap={geometry.barcodeBandGap}
          trackHeight={geometry.barcodeTrackHeight}
          trackGap={geometry.barcodeTrackGap}
          styleOf={(id) => displayedSeries.find((item) => item.id === id)?.style
            ?? series.find((item) => item.id === id)?.style
            ?? DEFAULT_SERIES_STYLE}
          coarse={coarse}
          foregroundOverlay={findMode && find !== null}
          reservedTrackCount={findMode ? Math.max(series.length, displayedSeries.length) : 0}
        />
      )}
      {docs.slice(1).map((doc, index) => {
        const x = edgeX(index + 1, 0);
        return <span key={doc} className="footer-book-boundary" style={{ transform: `translateX(${x}px)` }} />;
      })}
      {rangeLeft !== null && rangeRight !== null && (
        <span
          className="footer-range"
          style={{ left: rangeLeft, width: Math.max(1, rangeRight - rangeLeft) }}
        />
      )}
    </div>
  );

  return (
    <aside
      className="workbench-footer"
      aria-label="Reading position"
      {...guideAnchorProps('reading-footer')}
      style={{
        '--footer-local-block-size': `${blockSize}px`,
        '--footer-passage-height': `${geometry.passageHeight}px`,
        '--footer-status-height': `${geometry.statusHeight}px`,
        '--footer-lane-gap': `${geometry.laneGap}px`,
        '--footer-pad-block': `${geometry.padBlock}px`,
      } as CSSProperties}
    >
      <FooterInteractive
        docs={docs}
        titles={titleByDoc}
        layout={layout}
        width={width}
        geometry={geometry}
        tracks={showBarcode ? tracks : []}
        trackCount={showBarcode ? reservedTrackCount : 0}
        pending={pending}
        failed={failed}
        partial={(snapshot?.missingDocs.length ?? 0) > 0}
        strip={strip}
        containerRef={setContainer}
        globalShortcuts={globalShortcuts}
        showStatus={showStatus}
        showPassage={showPassage}
        foregroundBarcodeOverlay={findMode && find !== null}
      />
    </aside>
  );
}
