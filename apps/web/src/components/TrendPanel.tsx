/**
 * Trend comparison — three views over the same declared-sequence results:
 *
 * - 'series' (primary): one axis, books concatenated in declared reading
 *   order with token-proportional widths (sequenceBases + docTokenCount).
 *   One line per term. Paths BREAK at every book boundary — a slope from the
 *   last bin of one book into the first bin of the next would fabricate a
 *   trend across a structural discontinuity.
 * - 'by-book': one equal-width row per book on a normalized 0–100% axis.
 * - 'by-book-scaled': one row per book on a shared token-count axis, so short
 *   books end before the longest book's right edge.
 *
 * All views share one y-scale across every term and book so magnitude
 * comparison stays honest. Optional within-book smoothing is a presentation
 * setting; count is a separate unsmoothed view. Series identity
 * is color + dash in the Terms footer — never color alone. The plot holds
 * until every non-failed series resolves so the shared scale never jumps.
 * Exact per-book values live in Inputs; this surface stays focused on shape,
 * distribution, and reading-position interaction.
 *
 * The chart spans its container's full width (the app gives it the viewport)
 * via a measured ResizeObserver width; the axis position under the pointer /
 * keyboard scrubber drives the shared reading cursor and matches center.
 * Pointer motion is rAF-coalesced and deduplicated.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { findScope } from '../lib/interaction.ts';
import { BarcodeBand, BarcodeLegend } from './BarcodeStrip.tsx';
import {
  barcodeReaderActivation,
  captureBarcodePointerTarget,
  type BarcodeActivation,
  type BarcodeTrackVM,
} from '../lib/barcode-view.ts';
import { DEFAULT_SERIES_STYLE } from '../lib/series-style.ts';
import { trendSeriesGate } from '../lib/trend-series-gate.ts';
import type { SeriesIntent } from '../lib/app-state.ts';
import {
  TREND_VIEW_ORDER,
  trendViewAccessibleName,
  trendViewLabel,
  type TrendView,
} from '../lib/trend-view.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { trendGeometryFor } from '../lib/trend-compact.ts';
import { TREND_BARCODE_INTERACTIVE_STRIDE, trendRowSizing } from '../lib/trend-row-size.ts';
import {
  loadTrendRowPitch,
  resolveTrendRowPitch,
  saveTrendRowPitch,
  trendRowPitchPreference,
} from '../lib/trend-row-storage.ts';
import { browserStorage } from '../lib/preference-store.ts';
import { trendDisplayValues, trendRawValues } from '../lib/trend-display.ts';
import {
  projectedBarcodeTracks,
  trendStageGeometry,
  trendStageProjection,
  trendStageSnapIndexes,
} from '../lib/trend-stage.ts';
import { useOpenSettings } from './SettingsEntryContext.tsx';
import { contextualSettingsEntry } from '../lib/settings-entry.ts';
import { guideAnchorProps } from '../lib/guide/anchors.ts';
import { ScrubSurface } from './trends/ScrubSurface.tsx';
import type { CaptureBarcodePointer } from '../lib/trend-surface.ts';
import { SeriesView, ByBookView } from './trends/TrendCharts.tsx';
import type { DisplayedSeries, ReadySeries } from '../lib/trend-chart-view.ts';
import { TrendRowResizeHandle } from './trends/TrendRowResizeHandle.tsx';

const trendRowStorage = typeof window === 'undefined'
  ? null
  : browserStorage(window, 'local');

export function TrendPanel() {
  // Deliberately NO `scrub` subscription here: it updates once per
  // pointer animation frame, and this component's render rebuilds every path,
  // hover rect, and totals row. The ScrubSurface child owns the
  // per-frame state; this panel re-renders on data/view/resize changes and
  // bounded Find-mode transitions, never on ambient cursor motion.
  const series = useApp((s) => s.series);
  const interaction = useApp((s) => s.interaction);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const trends = useApp((s) => s.trends);
  const selectedTrends = useApp((s) => s.selectedTrends);
  const dispersion = useApp((s) => s.dispersion);
  const selectedDispersion = useApp((s) => s.selectedDispersion);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const trendView = useApp((s) => s.trendView);
  const setTrendView = useApp((s) => s.setTrendView);
  const trendMeasure = useApp((s) => s.trendMeasure);
  const centerKwicAt = useApp((s) => s.centerKwicAt);
  const openReader = useApp((s) => s.openReader);
  const presentation = usePresentation();
  const baseGeometry = trendGeometryFor(presentation.width);
  const [rowPitchPreference, setRowPitchPreference] = useState(() =>
    loadTrendRowPitch(trendRowStorage));
  const committedRowPitchPreference = useRef(rowPitchPreference);
  const activeTextCount = project?.data.order.length ?? 0;
  const viewSwitcher = activeTextCount > 1 ? (
    <TrendViewSwitcher
      view={trendView}
      compact={presentation.width === 'compact'}
      onChange={setTrendView}
    />
  ) : null;

  // Callback ref, not a RefObject: the container mounts only after the trend
  // results settle, so a mount-time effect would observe nothing. The ref is
  // handed to ScrubSurface's stage div; the width state stays here because
  // all chart geometry derives from it.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [plotW, setPlotW] = useState(720);
  useLayoutEffect(() => {
    if (!containerEl) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width) return; // ignore zero/unavailable observations
      const next = Math.max(1, Math.round(width));
      setPlotW((prev) => (prev === next ? prev : next));
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  const scopedFind = findScope(interaction);
  const findMode = scopedFind !== null;
  const find = scopedFind?.find ?? null;
  const activeSeries = useMemo<readonly SeriesIntent[]>(
    () => findMode
      ? find === null
        ? []
        : [{ id: find.query.seriesId, label: find.query.label, style: find.query.style }]
      : series,
    [find, findMode, series],
  );
  const displayedDispersion = findMode
    ? find?.dispersion.status === 'ready' ? find.dispersion.result : null
    : dispersion?.state.status === 'ready' ? dispersion.state.result : null;
  const displayedSelection = findMode ? null : linkedSelection;
  const barcodeSnapshot = findMode ? find?.snapshot ?? null : dispersion?.snapshot ?? null;
  const states = findMode
    ? activeSeries.map((intent) => ({ intent, state: find?.trend }))
    : activeSeries.map((intent) => ({ intent, state: trends.get(intent.id) }));
  const ghostStates = findMode
    ? series.map((intent) => ({ intent, state: trends.get(intent.id) }))
    : [];
  const graphGate = findMode && find === null
    ? trendSeriesGate(ghostStates.map(({ state }) => state), [])
    : trendSeriesGate(
        states.map(({ state }) => state),
        ghostStates.map(({ state }) => state),
      );
  const failed = states.filter((s) => s.state?.status === 'error');
  const failureText = (failure: (typeof failed)[number]) =>
    `${failure.intent.label}: ${failure.state?.status === 'error' ? failure.state.message : 'query failed'}`;
  const activeReady: ReadySeries[] = states.flatMap(({ intent, state }) =>
    state?.status === 'ready' ? [{ intent, trend: state.trend }] : [],
  );
  const ghostReady: ReadySeries[] = findMode
    ? ghostStates.flatMap(({ intent, state }) => {
        return state?.status === 'ready'
          ? [{ intent, trend: state.trend, ghost: true }]
          : [];
      })
    : [];
  // Ghosts render first so the active Find line is always the visual foreground.
  const graphReady = findMode ? [...ghostReady, ...activeReady] : activeReady;
  const selectedReady: ReadySeries[] = (findMode ? [] : activeSeries).flatMap((intent) => {
    const state = selectedTrends.get(intent.id);
    return state?.status === 'ready' ? [{ intent, trend: state.trend }] : [];
  });
  const readyGeo = activeReady[0]?.trend ?? ghostReady[0]?.trend ?? null;
  const reservedTrackCount = findMode ? Math.max(series.length, activeSeries.length) : 0;
  const sizingTrackCount = useMemo(() => {
    if (graphGate !== 'ready' || !readyGeo) return reservedTrackCount;
    return Math.max(
      projectedBarcodeTracks(
        displayedDispersion,
        readyGeo.order,
        activeSeries.map((item) => item.id),
      ).length,
      reservedTrackCount,
    );
  }, [activeSeries, displayedDispersion, graphGate, readyGeo, reservedTrackCount]);
  const rowPitchContext = {
    width: presentation.width,
    coarse: presentation.coarseAvailable,
    tracks: sizingTrackCount,
  } as const;
  const rowPitchTarget = resolveTrendRowPitch(rowPitchPreference, rowPitchContext);
  const rowSizing = useMemo(() => trendRowSizing({
    width: presentation.width,
    coarse: presentation.coarseAvailable,
    trackCount: sizingTrackCount,
    targetPitch: rowPitchTarget,
    barcodeRequired: findMode && find !== null,
  }), [
    find,
    findMode,
    presentation.coarseAvailable,
    presentation.width,
    rowPitchTarget,
    sizingTrackCount,
  ]);
  const geometry = trendView === 'series' ? baseGeometry : rowSizing.geometry;
  const stageProjection = useMemo(() => {
    if (
      graphGate !== 'ready'
      || !readyGeo
      || !readyGeo.sequenceBases
    ) return null;
    return trendStageProjection({
      trend: readyGeo,
      seriesOrder: activeSeries.map((item) => item.id),
      dispersion: displayedDispersion,
      selectedDispersion: !findMode && selectedDispersion?.state.status === 'ready'
        ? selectedDispersion.state.result
        : null,
      selectedDocs: displayedSelection?.ranges.map((range) => range.doc) ?? [],
      geometry,
      reservedTrackCount,
      foregroundBarcodeOverlay: findMode && find !== null,
    });
  }, [activeSeries, displayedDispersion, displayedSelection, find, findMode, geometry, graphGate, readyGeo, reservedTrackCount, selectedDispersion]);
  const occurrenceInteractive = trendView === 'series'
    || rowSizing.barcodeInteractive
    || (findMode
      && find !== null
      && (stageProjection?.barcodeHeight ?? 0) >= TREND_BARCODE_INTERACTIVE_STRIDE);
  const stageGeometry = useMemo(() => stageProjection
    ? trendStageGeometry(stageProjection, {
        plotWidth: plotW,
        view: trendView,
        titlesPainted: trendView === 'series' || rowSizing.titlesPainted,
        barcodeInteractive: occurrenceInteractive,
      })
    : null,
  [occurrenceInteractive, plotW, rowSizing.titlesPainted, stageProjection, trendView]);
  const snapIndexCache = useRef<{
    readonly tracks: readonly BarcodeTrackVM[];
    readonly indexes: ReturnType<typeof trendStageSnapIndexes>;
  } | null>(null);
  const styleBySeries = useMemo(
    () => new Map((findMode ? [...series, ...activeSeries] : activeSeries)
      .map((item) => [item.id, item.style])),
    [activeSeries, findMode, series],
  );
  const labelBySeries = useMemo(
    () => new Map(activeSeries.map((item) => [item.id, item.label])),
    [activeSeries],
  );
  const styleOf = useCallback(
    (id: string) => styleBySeries.get(id) ?? DEFAULT_SERIES_STYLE,
    [styleBySeries],
  );
  const labelOf = useCallback((id: string) => labelBySeries.get(id) ?? id, [labelBySeries]);

  if (activeSeries.length === 0 && ghostStates.length === 0) return null;

  // Hold the comparison until the current set settles: a shared y-scale that
  // re-fits as each line lands reads as data changing when it isn't.
  if (graphGate === 'pending') {
    return (
      <section {...guideAnchorProps('trend-plate')}>
        <TrendPanelHeader>{viewSwitcher}</TrendPanelHeader>
        <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>computing trends…</p>
      </section>
    );
  }
  if ((!findMode || find !== null) && activeReady.length === 0) {
    return failed.length > 0 ? (
      <section {...guideAnchorProps('trend-plate')}>
        <TrendPanelHeader>{viewSwitcher}</TrendPanelHeader>
        <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {failed.map(failureText).join(' · ')}
        </p>
      </section>
    ) : null;
  }

  if (graphReady.length === 0) return null;

  // Geometry is identical across series (same snapshot, selection, bins) —
  // prefer Find, then use the resident context while its composer is empty.
  const geo = readyGeo!;
  if (!stageProjection || !stageGeometry) {
    throw new Error('trend stage projection missing for ready geometry');
  }
  const {
    docs,
    layout,
    tracks,
    selectedTracks,
    barcodeHeight,
    rowPitch,
  } = stageProjection;
  const backgroundBarcodeTracks = findMode
    ? projectedBarcodeTracks(
        dispersion?.state.status === 'ready' ? dispersion.state.result : null,
        docs,
        series.map((item) => item.id),
      )
    : [];
  const {
    edgeX,
    hitSpec,
    labelBands,
    rowDomain,
  } = stageGeometry;
  // Presentation titles come from the project's document metadata — doc ids
  // are opaque identity (library documents use UUIDs). Ordinals are reading-order.
  const titleByDoc = new Map((project?.data.docs ?? []).map((d) => [d.doc, d.meta.title]));
  const titles = docs.map((doc) => titleByDoc.get(doc) ?? doc);
  // The store always requests declared-sequence coordinates, so the kernel
  // always returns sequenceBases — a null here is an invariant violation, and
  // the old ad-hoc fallback (d * count[d]) was NOT a prefix sum and would have
  // silently mislaid every x-position had it ever run.
  const bases = layout.bases;
  const captureBarcode: CaptureBarcodePointer = (
    sample,
    allowExactSnap,
  ) => {
    // Exact tracks can contain 250k occurrences. Allocate their pixel indexes
    // only on the first precise barcode event, retain them for these tracks,
    // and never turn hover into a React render/chart commit.
    let exactIndexes: ReturnType<typeof trendStageSnapIndexes> = [];
    if (allowExactSnap) {
      const cached = snapIndexCache.current;
      if (cached?.tracks === tracks) {
        exactIndexes = cached.indexes;
      } else {
        exactIndexes = trendStageSnapIndexes(stageProjection);
        snapIndexCache.current = { tracks, indexes: exactIndexes };
      }
    }
    return captureBarcodePointerTarget(
      tracks,
      exactIndexes,
      sample,
      edgeX,
      allowExactSnap,
    );
  };
  const activateBarcode = (
    track: BarcodeTrackVM,
    target: BarcodeActivation | null,
    openExact = false,
  ) => {
    if (!target) return;
    centerKwicAt(
      track.seriesId,
      target.doc,
      target.token,
      target.kind === 'bucket'
        ? { kind: 'bucket', count: target.bucketCount ?? 0 }
        : { kind: 'occurrence', groupId: track.groupId },
    );
    const readerTarget = openExact ? barcodeReaderActivation(target) : null;
    if (readerTarget && barcodeSnapshot) {
      openReader({
        snapshot: barcodeSnapshot,
        doc: readerTarget.doc,
        token: readerTarget.token,
        from: 'barcode',
        anchor: 'occurrence',
      });
    }
  };
  const displayedReady: DisplayedSeries[] = graphReady.map((item) => ({
    ...item,
    values: trendDisplayValues(item.trend, trendMeasure),
    rawValues: trendRawValues(item.trend, trendMeasure),
  }));
  const displayedSelected: DisplayedSeries[] = selectedReady.map((item) => ({
    ...item,
    values: trendDisplayValues(item.trend, trendMeasure),
    rawValues: trendRawValues(item.trend, trendMeasure),
  }));
  const plottedArrays = [
    ...displayedReady.flatMap((item) => [
      item.values,
      ...(trendMeasure.kind === 'rate' && trendMeasure.smoothing !== 0 && trendMeasure.showRaw
        && (!item.ghost || activeReady.length === 0)
        ? [item.rawValues]
        : []),
    ]),
    ...displayedSelected.map((item) => item.values),
  ];
  const dataMaxValue = Math.max(
    0,
    ...plottedArrays.map((values) => {
      let maximum = 0;
      for (const value of values) {
        if (Number.isFinite(value)) maximum = Math.max(maximum, value);
      }
      return maximum;
    }),
  );
  const maxValue = Math.max(1e-9, dataMaxValue);
  const strokeFor = () => geometry.strokeWidth;
  const previewRowPitch = (target: number | null) => {
    setRowPitchPreference(target === null
      ? null
      : trendRowPitchPreference(target, rowPitchContext));
  };
  const commitRowPitch = (target: number | null) => {
    if (findMode && target !== null) {
      setRowPitchPreference(committedRowPitchPreference.current);
      return;
    }
    const preference = target === null
      ? null
      : trendRowPitchPreference(target, rowPitchContext);
    committedRowPitchPreference.current = preference;
    setRowPitchPreference(preference);
    saveTrendRowPitch(trendRowStorage, preference);
  };
  const cancelRowPitch = () => {
    setRowPitchPreference(committedRowPitchPreference.current);
  };

  return (
    <section {...guideAnchorProps('trend-plate')}>
      <TrendPanelHeader>
        {viewSwitcher}
        <BarcodeLegend
          tracks={tracks}
          selectedTracks={selectedTracks}
          linkedSelection={displayedSelection !== null}
          selectedStatus={displayedSelection ? selectedDispersion?.state.status ?? 'pending' : null}
          styleOf={styleOf}
          labelOf={labelOf}
          onActivate={activateBarcode}
        />
      </TrendPanelHeader>
      {failed.length > 0 && (
        <p
          role="alert"
          style={{
            color: 'var(--accent-text)',
            fontSize: 'var(--text-sm)',
            margin: '0 0 var(--space-2)',
          }}
        >
          failed: {failed.map(failureText).join(' · ')}
        </p>
      )}
      {trendView !== 'series' && docs.length > 1 && (
        <TrendRowResizeHandle
          sizing={rowSizing}
          trackCount={sizingTrackCount}
          legendTrackCount={tracks.length}
          occurrenceInteractive={occurrenceInteractive}
          coarse={presentation.coarseAvailable}
          onPreview={previewRowPitch}
          onCommit={commitRowPitch}
          onCancel={cancelRowPitch}
        />
      )}
      {/* ScrubSurface owns cursor updates; keep its chart children stable. */}
      <ScrubSurface
        containerRef={setContainerEl}
        trendView={trendView}
        docs={docs}
        titleByDoc={titleByDoc}
        layout={layout}
        trend={geo}
        plotW={plotW}
        series={activeSeries}
        geometry={geometry}
        barcodeHeight={barcodeHeight}
        barcodeVisible={trendView === 'series' || rowSizing.barcodeVisible}
        barcodeInteractive={occurrenceInteractive}
        rowPitch={rowPitch}
        rowDomain={rowDomain}
        labelBands={labelBands}
        barcodeTracks={tracks}
        captureBarcode={captureBarcode}
        hitSpec={hitSpec}
        coarse={presentation.coarseAvailable}
        onBarcodeActivate={activateBarcode}
        barcodeBand={(trendView === 'series' || rowSizing.barcodeVisible) ? (
          <BarcodeBand
            view={trendView}
            docs={docs}
            tracks={tracks}
            backgroundTracks={backgroundBarcodeTracks}
            selectedTracks={selectedTracks}
            linkedSelection={displayedSelection !== null}
            edgeX={edgeX}
            width={plotW}
            plotHeight={trendView === 'series' ? geometry.seriesHeight : geometry.rowHeight}
            rowPitch={rowPitch}
            bandGap={geometry.barcodeBandGap}
            trackHeight={geometry.barcodeTrackHeight}
            trackGap={geometry.barcodeTrackGap}
            styleOf={styleOf}
            coarse={presentation.coarseAvailable}
            occurrenceInteractive={occurrenceInteractive}
            foregroundOverlay={findMode && find !== null}
            reservedTrackCount={findMode ? Math.max(series.length, activeSeries.length) : 0}
          />
        ) : null}
      >
        {trendView === 'series' ? (
          <SeriesView
            ready={displayedReady}
            selected={displayedSelected}
            docs={docs}
            titles={titles}
            bases={bases}
            maxValue={maxValue}
            dataMaxValue={dataMaxValue}
            measure={trendMeasure}
            plotW={plotW}
            strokeFor={strokeFor}
            geometry={geometry}
            barcodeHeight={barcodeHeight}
            labelBands={labelBands}
          />
        ) : (
          <ByBookView
            view={trendView}
            ready={displayedReady}
            selected={displayedSelected}
            docs={docs}
            titles={titles}
            maxValue={maxValue}
            measure={trendMeasure}
            plotW={plotW}
            strokeFor={strokeFor}
            geometry={geometry}
            labelBands={labelBands}
            rowPitch={rowPitch}
            rowDomain={rowDomain}
          />
        )}
      </ScrubSurface>
    </section>
  );
}

function TrendPanelHeader({ children }: { readonly children: React.ReactNode }) {
  const openSettings = useOpenSettings();
  return (
    <div className="trend-panel-header">
      <div className="trend-panel-controls">{children}</div>
      <button
        id="trend-settings-open"
        className="trend-settings-trigger coarse-target"
        type="button"
        aria-haspopup="dialog"
        onClick={(event) => openSettings(
          contextualSettingsEntry('trends'),
          event.currentTarget,
        )}
      >
        Trend settings
      </button>
    </div>
  );
}

function TrendViewSwitcher({
  view,
  compact,
  onChange,
}: {
  readonly view: TrendView;
  readonly compact: boolean;
  readonly onChange: (view: TrendView) => void;
}) {
  return (
    <div
      className="trend-view-switcher"
      role="group"
      aria-label="Layout — Trend view"
      style={{ fontSize: compact ? 'var(--text-sm)' : 'var(--text-xs)' }}
    >
      <span className="trend-view-caption">Layout</span>
      {TREND_VIEW_ORDER.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          aria-pressed={view === candidate}
          aria-label={trendViewAccessibleName(candidate)}
        >
          {trendViewLabel(candidate)}
        </button>
      ))}
    </div>
  );
}
