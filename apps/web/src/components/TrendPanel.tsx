/**
 * Trend comparison — two views over the same declared-sequence results:
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

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NumericTrend, WorkspaceTrendMeasureV1 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { findScope } from '../lib/interaction.ts';
import { BarcodeBand, BarcodeLegend } from './BarcodeStrip.tsx';
import {
  barcodeReaderActivation,
  captureBarcodePointerTarget,
  type BarcodeActivation,
  type BarcodeTrackVM,
} from '../lib/barcode-view.ts';
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
import {
  bookXFromTokenEdge,
  barcodeBandExtent,
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  trendBinSpan,
  trendRowsForDoc,
  type TrendLabelBand,
} from '../lib/trend-geometry.ts';
import type { SeriesIntent } from '../lib/app-state.ts';
import {
  TREND_VIEW_ORDER,
  trendViewAccessibleName,
  trendViewLabel,
  type TrendView,
} from '../lib/trend-view.ts';
import { recordChartCommit } from '../lib/e2e-probe.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { trendGeometryFor, type TrendGeometry } from '../lib/trend-compact.ts';
import {
  TREND_BARCODE_INTERACTIVE_STRIDE,
  trendRowSizing,
  type TrendRowSizing,
} from '../lib/trend-row-size.ts';
import {
  beginTrendRowDetent,
  moveTrendRowDetent,
  stepTrendRowPitch,
  type TrendRowDetentState,
} from '../lib/trend-row-detent.ts';
import {
  loadTrendRowPitch,
  resolveTrendRowPitch,
  saveTrendRowPitch,
  trendRowPitchPreference,
} from '../lib/trend-row-storage.ts';
import { browserStorage } from '../lib/preference-store.ts';
import {
  formatTrendDisplayValue,
  trendDisplayValues,
  trendMeasureUnit,
  trendRawValues,
} from '../lib/trend-display.ts';
import {
  projectedBarcodeTracks,
  trendStageGeometry,
  trendStageProjection,
  trendStageSnapIndexes,
} from '../lib/trend-stage.ts';
import { shortcutAria } from '../lib/shortcuts.ts';
import { useOpenSettings } from './SettingsEntryContext.tsx';
import { contextualSettingsEntry } from '../lib/settings-entry.ts';
import { guideAnchorProps } from '../lib/guide/anchors.ts';
import { ScrubSurface } from './trends/ScrubSurface.tsx';
import type { CaptureBarcodePointer } from '../lib/trend-surface.ts';

const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
const trendRowStorage = typeof window === 'undefined'
  ? null
  : browserStorage(window, 'local');
interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
  readonly ghost?: boolean;
}

interface DisplayedSeries extends ReadySeries {
  readonly values: Float64Array;
  readonly rawValues: Float64Array;
}

function accessibleTrendSeries(ready: readonly DisplayedSeries[]): string {
  const foreground = ready.filter((item) => !item.ghost).map((item) => item.intent.label);
  const context = ready.filter((item) => item.ghost).map((item) => item.intent.label);
  if (context.length === 0) return foreground.join(', ');
  if (foreground.length === 0) {
    return `${context.join(', ')} as de-emphasized context while Find awaits a query`;
  }
  return `Find ${foreground.join(', ')}, with ${context.join(', ')} as de-emphasized context`;
}

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

function TrendRowResizeHandle({
  sizing,
  trackCount,
  legendTrackCount,
  occurrenceInteractive,
  coarse,
  onPreview,
  onCommit,
  onCancel,
}: {
  readonly sizing: TrendRowSizing;
  readonly trackCount: number;
  readonly legendTrackCount: number;
  readonly occurrenceInteractive: boolean;
  readonly coarse: boolean;
  readonly onPreview: (target: number | null) => void;
  readonly onCommit: (target: number | null) => void;
  readonly onCancel: () => void;
}) {
  const [resizing, setResizing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detentHint, setDetentHint] = useState<'hide' | 'restore' | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const pendingTarget = useRef<number | null>(null);
  const keyboardTarget = useRef<number | null>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startPitch: number;
    detent: TrendRowDetentState;
    lastTarget: number;
  } | null>(null);

  useEffect(() => () => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    document.documentElement.removeAttribute('data-trend-row-resizing');
  }, []);

  const setResizeActive = (active: boolean) => {
    setResizing(active);
    if (active) document.documentElement.setAttribute('data-trend-row-resizing', 'true');
    else document.documentElement.removeAttribute('data-trend-row-resizing');
  };
  const commitPendingTarget = () => {
    if (resizeFrame.current !== null) {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = null;
    }
    const pending = pendingTarget.current;
    pendingTarget.current = null;
    if (pending !== null) onPreview(pending);
  };
  const scheduleTarget = (next: number) => {
    pendingTarget.current = next;
    if (drag.current) drag.current.lastTarget = next;
    resizeFrame.current ??= requestAnimationFrame(() => {
      resizeFrame.current = null;
      const pending = pendingTarget.current;
      pendingTarget.current = null;
      if (pending !== null) onPreview(pending);
    });
  };
  const finishResize = (pointerId: number) => {
    const active = drag.current;
    if (active?.pointerId !== pointerId) return;
    commitPendingTarget();
    drag.current = null;
    setResizeActive(false);
    setDetentHint(null);
    onCommit(active.lastTarget);
  };
  const stateText = `${sizing.rowPitch} pixels per text · ${
    sizing.titlesPainted ? 'titles shown' : 'titles hidden'
  }${trackCount > 0 && !sizing.barcodeVisible
    ? ' · occurrence rows hidden · smallest row'
    : trackCount > 0 && sizing.rowPitch === sizing.inkPitch
      ? ' · occurrence rows minimized · smallest row with occurrence rows'
    : ''}`;
  const valuetext = detentHint === 'hide'
    ? `${sizing.inkPitch} pixels per text · keep dragging up to hide ${trackCount} occurrence row${trackCount === 1 ? '' : 's'}`
    : detentHint === 'restore'
      ? `${sizing.minPitch} pixels per text · keep dragging down to restore occurrence rows`
      : stateText;
  const commitKeyboardTarget = () => {
    const pending = keyboardTarget.current;
    keyboardTarget.current = null;
    if (pending !== null) onCommit(pending);
  };

  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowDown' || event.key === 'PageDown'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'PageUp'
        ? -1
        : 0;
    if (direction === 0 && !['Home', 'End', 'Enter', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape' && drag.current === null) return;
    event.preventDefault();
    setFocused(true);
    if (event.key === 'Escape') {
      const active = drag.current;
      if (active) {
        if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
        resizeFrame.current = null;
        pendingTarget.current = null;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(active.pointerId)) {
          event.currentTarget.releasePointerCapture(active.pointerId);
        }
        onCancel();
        setResizeActive(false);
        setDetentHint(null);
      }
      return;
    }
    if (event.key === 'Enter') {
      keyboardTarget.current = null;
      onCommit(null);
      return;
    }
    const step = event.shiftKey
      ? 1
      : event.key === 'PageUp' || event.key === 'PageDown'
        ? 32
        : 8;
    const currentPitch = keyboardTarget.current ?? sizing.rowPitch;
    const next = event.key === 'Home'
      ? sizing.minPitch
      : event.key === 'End'
        ? sizing.maxPitch
        : stepTrendRowPitch(
            currentPitch,
            direction as -1 | 1,
            step,
            sizing,
          );
    keyboardTarget.current = next;
    onPreview(next);
  };

  return (
    <div
      className="trend-row-resize-handle"
      role="separator"
      aria-label="Resize trend rows"
      aria-orientation="horizontal"
      aria-controls="reading-position-scrubber"
      aria-valuemin={sizing.minPitch}
      aria-valuemax={sizing.maxPitch}
      aria-valuenow={sizing.rowPitch}
      aria-valuetext={valuetext}
      aria-describedby={legendTrackCount > 0 && !sizing.barcodeVisible
        ? 'trend-hidden-barcode-note'
        : legendTrackCount > 0 && !occurrenceInteractive
          ? 'trend-mini-barcode-note'
          : undefined}
      aria-keyshortcuts={shortcutAria([
        'trend-rows-step',
        'trend-rows-fine',
        'trend-rows-page',
        'trend-rows-limits',
        'trend-rows-reset',
      ])}
      tabIndex={0}
      data-resizing={resizing || undefined}
      data-titles-painted={sizing.titlesPainted}
      data-row-phase={sizing.phase}
      data-barcode-visible={sizing.barcodeVisible}
      data-barcode-interactive={occurrenceInteractive}
      style={{ '--trend-row-resize-target': coarse ? '44px' : '24px' } as React.CSSProperties}
      onDoubleClick={() => { onCommit(null); }}
      onKeyDown={resizeByKeyboard}
      onKeyUp={(event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
          commitKeyboardTarget();
        }
      }}
      onFocus={(event) => {
        setFocused(event.currentTarget.matches(':focus-visible'));
      }}
      onBlur={() => {
        setFocused(false);
        commitKeyboardTarget();
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        setFocused(false);
        commitKeyboardTarget();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startPitch: sizing.rowPitch,
          detent: beginTrendRowDetent(sizing.rowPitch, sizing.minPitch, event.clientY),
          lastTarget: sizing.rowPitch,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizeActive(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active?.pointerId !== event.pointerId) return;
        event.preventDefault();
        const requestedPitch = Math.max(
          sizing.minPitch,
          Math.min(
            sizing.maxPitch,
            Math.round(active.startPitch + event.clientY - active.startY),
          ),
        );
        const transition = moveTrendRowDetent(active.detent, {
          clientY: event.clientY,
          requestedPitch,
          minPitch: sizing.minPitch,
          inkPitch: sizing.inkPitch,
          coarse,
        });
        active.detent = transition.state;
        active.lastTarget = transition.pitch;
        setDetentHint(transition.hint);
        scheduleTarget(transition.pitch);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        finishResize(event.pointerId);
      }}
      onPointerCancel={(event) => { finishResize(event.pointerId); }}
      onLostPointerCapture={(event) => { finishResize(event.pointerId); }}
    >
      <span className="trend-row-resize-mark" aria-hidden="true" />
      {(resizing || focused) && <span className="trend-row-resize-readout">{valuetext}</span>}
    </div>
  );
}

/** E2E-only commit counter (dead code in production builds): an effect with no
 *  dependency array fires after EVERY commit of its owning subtree, which is
 *  exactly the "did the chart re-render on scrub?" probe the regression test
 *  needs. Never incremented during render. */
function ChartCommitProbe({ view }: { view: TrendView }) {
  useEffect(() => {
    recordChartCommit(view);
  });
  return null;
}

const SeriesView = memo(function SeriesView({
  ready,
  selected,
  docs,
  titles,
  bases,
  maxValue,
  dataMaxValue,
  measure,
  plotW,
  strokeFor,
  geometry,
  barcodeHeight,
  labelBands,
}: {
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  bases: readonly number[];
  maxValue: number;
  dataMaxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  barcodeHeight: number;
  labelBands: readonly TrendLabelBand[];
}) {
  const foregroundReady = ready.filter((item) => !item.ghost);
  const rawReady = foregroundReady.length > 0 ? foregroundReady : ready;
  const hasGhostContext = ready.some((item) => item.ghost);
  const geo = foregroundReady[0]?.trend ?? ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = linearMap(0, Math.max(1, totalTokens), 0, plotW);
  const y = linearMap(0, maxValue, geometry.seriesHeight, geometry.topPad);
  const axisY = geometry.seriesHeight;
  const barcodeBottom = axisY + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  const height = labelBands[0]
    ? labelBands[0].top + labelBands[0].height
    : barcodeBottom + 8;

  // One path segment per (series, doc) — the break at every boundary is
  // mandatory; connecting them would invent data.
  const pointX = (d: number, b: number) => {
    const { start, end } = trendBinSpan(geo, d, b);
    return x((bases[d] ?? 0) + (start + end) / 2);
  };
  const spanX = (d: number, b: number) => {
    const { start, end } = trendBinSpan(geo, d, b);
    const x0 = x(bases[d] ?? 0);
    const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
    return {
      start: clampToSpan(
        x((bases[d] ?? 0) + start),
        x0,
        x1,
        d > 0 ? BOUNDARY_GAP : 0,
        BOUNDARY_GAP,
      ),
      end: clampToSpan(
        x((bases[d] ?? 0) + end),
        x0,
        x1,
        d > 0 ? BOUNDARY_GAP : 0,
        BOUNDARY_GAP,
      ),
    };
  };

  return (
    <svg
      data-trend-view="series"
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${accessibleTrendSeries(ready)} across ${docs.length} texts in reading order`}
    >
      <line
        data-trend-axis="series"
        x1={0}
        y1={axisY}
        x2={plotW}
        y2={axisY}
        stroke="var(--rule-strong)"
        strokeWidth={1}
      />
      {docs.map((doc, d) => {
        const band = labelBands[d];
        const x0 = band?.left ?? x(bases[d] ?? 0);
        const x1 = band?.right ?? x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
        const title = titles[d] ?? doc;
        const n = String(d + 1);
        const label = (x1 - x0) > 7 * (title.length + 4) ? `${n} · ${title}` : n;
        return (
          <g key={doc}>
            {d > 0 && (
              <line x1={x0} y1={0} x2={x0} y2={axisY} stroke="var(--rule)" strokeWidth={1} />
            )}
            {band && (
              <text
                data-trend-row-title={d}
                x={(x0 + x1) / 2}
                y={band.top + 14}
                textAnchor="middle"
                fill="var(--fg-muted)"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-mono)"
                aria-hidden="true"
              >
                {label}
                <title>{title}</title>
              </text>
            )}
          </g>
        );
      })}
      {/* The direct-labeled y extent helps compare a combined multi-book
          sequence. With one text it is redundant chrome above the graph. */}
      {docs.length > 1 && (
        <g data-trend-y-extent>
          <line x1={0} y1={y(maxValue)} x2={plotW} y2={y(maxValue)} stroke="var(--rule)" strokeWidth={1} />
          <text x={0} y={y(maxValue) - 3} fill="var(--fg-muted)" fontSize="var(--text-xs)" fontFamily="var(--font-mono)">
            {formatTrendDisplayValue(dataMaxValue, measure)}{trendMeasureUnit(measure)}
          </text>
        </g>
      )}
      {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && rawReady.flatMap((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            r.rawValues,
            (b) => clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP),
            y,
            (b) => spanX(d, b),
          ).map((path, index) => (
            <path
              key={`raw:${r.intent.id}:${doc}:${index}`}
              data-raw-series-path={r.intent.id}
              d={path}
              fill="none"
              stroke={seriesColor(r.intent.style)}
              strokeWidth={1}
              strokeDasharray={seriesDash(r.intent.style)}
              opacity={r.ghost ? 0.1 : 0.2}
              pointerEvents="none"
            />
          ));
        }),
      )}
      {ready.map((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            r.values,
            (b) => clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP),
            y,
            (b) => spanX(d, b),
          ).map((path, index) => (
            <g key={`${r.intent.id}:${doc}:${index}`}>
              {!r.ghost && hasGhostContext && (
                <path
                  data-series-find-halo={r.intent.id}
                  d={path}
                  fill="none"
                  stroke="var(--bg)"
                  strokeWidth={findSeriesHaloStrokeWidth(strokeFor(r.intent.id))}
                  strokeDasharray={seriesDash(r.intent.style)}
                  strokeLinecap={seriesLinecap(r.intent.style)}
                  opacity={0.92}
                  pointerEvents="none"
                />
              )}
              <path
                data-series-path={r.intent.id}
                data-series-ghost={r.ghost || undefined}
                data-series-find-foreground={!r.ghost && hasGhostContext || undefined}
                d={path}
                fill="none"
                stroke={seriesColor(r.intent.style)}
                strokeWidth={r.ghost
                  ? ghostSeriesStrokeWidth(strokeFor(r.intent.id))
                  : hasGhostContext
                    ? findSeriesStrokeWidth(strokeFor(r.intent.id))
                    : strokeFor(r.intent.id)}
                strokeDasharray={seriesDash(r.intent.style)}
                strokeLinecap={seriesLinecap(r.intent.style)}
                opacity={r.ghost ? GHOST_SERIES_OPACITY : selected.length > 0 ? 0.45 : 1}
                pointerEvents={r.ghost ? 'none' : undefined}
              />
            </g>
          ));
        }),
      )}
      {selected.flatMap((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            r.values,
            (b) => clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP),
            y,
            (b) => spanX(d, b),
          ).map((path, i) => (
            <path
              key={`selected:${r.intent.id}:${doc}:${i}`}
              data-selected-overlay={r.intent.id}
              d={path}
              fill="none"
              stroke={seriesColor(r.intent.style)}
              strokeWidth={strokeFor(r.intent.id) + 1.5}
              strokeDasharray={seriesDash(r.intent.style)}
              strokeLinecap="round"
              pointerEvents="none"
            />
          ));
        }),
      )}
      {/* The moving cursor is NOT here: it is ScrubSurface's overlay div, so
          scrubbing never re-renders this SVG. */}
      {__TT_E2E__ && <ChartCommitProbe view="series" />}
      {/* Hover layer: one column per (book, bin) reporting every series */}
      {docs.map((doc, d) =>
        Array.from({ length: trendRowsForDoc(geo, d).count }, (_, b) => {
          const rows = trendRowsForDoc(geo, d);
          const { start, end } = trendBinSpan(geo, d, b);
          if (end <= start) return null;
          const x0 = x((bases[d] ?? 0) + start);
          const w = Math.max(1, x((bases[d] ?? 0) + end) - x0);
          const title = titles[d] ?? doc;
          const lines = foregroundReady
            .map((r) => {
              const iRow = rows.start + b;
              const displayed = r.values[iRow];
              const formatted = displayed !== undefined && Number.isFinite(displayed)
                ? `${formatTrendDisplayValue(displayed, measure)}${trendMeasureUnit(measure)}`
                : 'gap';
              return `${r.intent.label}: ${r.trend.count[iRow]}× (${formatted})`;
            })
            .join('\n');
          return (
            <rect key={`${doc}:${b}`} x={x0} y={0} width={w} height={axisY} fill="transparent">
              <title>{`${title}, bin ${b + 1}/${rows.count}\n${lines}`}</title>
            </rect>
          );
        }),
      )}
    </svg>
  );
});

const ByBookView = memo(function ByBookView({
  view,
  ready,
  selected,
  docs,
  titles,
  maxValue,
  measure,
  plotW,
  strokeFor,
  geometry,
  labelBands,
  rowPitch,
  rowDomain,
}: {
  view: Exclude<TrendView, 'series'>;
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  maxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  labelBands: readonly TrendLabelBand[];
  rowPitch: number;
  rowDomain: readonly number[];
}) {
  const foregroundReady = ready.filter((item) => !item.ghost);
  const rawReady = foregroundReady.length > 0 ? foregroundReady : ready;
  const hasGhostContext = ready.some((item) => item.ghost);
  const geo = foregroundReady[0]?.trend ?? ready[0]!.trend;
  const y = linearMap(0, maxValue, geometry.rowHeight, 0);
  const height = docs.length * rowPitch + 4;
  const pointX = (d: number, b: number) => {
    const span = trendBinSpan(geo, d, b);
    return bookXFromTokenEdge((span.start + span.end) / 2, plotW, rowDomain[d] ?? 0);
  };
  const spanX = (d: number, b: number) => {
    const span = trendBinSpan(geo, d, b);
    const domain = rowDomain[d] ?? 0;
    return {
      start: bookXFromTokenEdge(span.start, plotW, domain),
      end: bookXFromTokenEdge(span.end, plotW, domain),
    };
  };

  return (
    <svg
      data-trend-view={view}
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${accessibleTrendSeries(ready)} within each of ${docs.length} texts${view === 'by-book-scaled' ? '; shared token scale, shorter texts end early' : '; each text fills an equal-width row'}`}
    >
      {docs.map((doc, d) => {
        const rowBase = d * rowPitch;
        const rowY = rowBase;
        const title = titles[d] ?? doc;
        const tokens = geo.docTokenCount[d] ?? 0;
        const domain = rowDomain[d] ?? 0;
        const rowEnd = bookXFromTokenEdge(tokens, plotW, domain);
        const titleFontSize = geometry.rowGap >= 14 ? 11 : 9;
        const titleBandTop = labelBands[d]?.top ?? rowBase + rowPitch - geometry.rowGap;
        const titleBaseline = titleBandTop + Math.max(7, Math.min(15, geometry.rowGap - 3));
        return (
          <g key={doc}>
            {labelBands[d]?.titlePainted !== false && (
              <text
                data-trend-row-title={d}
                x={0}
                y={titleBaseline}
                fill="var(--fg-muted)"
                fontFamily="var(--font-mono)"
                fontSize={titleFontSize}
                pointerEvents="none"
                aria-hidden="true"
              >
                {title}
              </text>
            )}
            <line
              data-trend-row-axis={d}
              x1={0}
              y1={rowY + geometry.rowHeight}
              x2={rowEnd}
              y2={rowY + geometry.rowHeight}
              stroke="var(--rule)"
              strokeWidth={1}
            />
            {view === 'by-book-scaled' && tokens > 0 && tokens < domain && (
              <line
                data-trend-row-end={d}
                x1={rowEnd}
                y1={rowY}
                x2={rowEnd}
                y2={rowY + geometry.rowHeight}
                stroke="var(--rule-strong)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
            {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && rawReady.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.rawValues,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
                (b) => spanX(d, b),
              ).map((path, index) => (
                <path
                  key={`raw:${r.intent.id}:${index}`}
                  data-raw-series-path={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={seriesColor(r.intent.style)}
                  strokeWidth={1}
                  strokeDasharray={seriesDash(r.intent.style)}
                  opacity={r.ghost ? 0.1 : 0.2}
                  pointerEvents="none"
                />
              )),
            )}
            {ready.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.values,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
                (b) => spanX(d, b),
              ).map((path, index) => (
                <g key={`${r.intent.id}:${index}`}>
                  {!r.ghost && hasGhostContext && (
                    <path
                      data-series-find-halo={r.intent.id}
                      d={path}
                      fill="none"
                      stroke="var(--bg)"
                      strokeWidth={findSeriesHaloStrokeWidth(strokeFor(r.intent.id))}
                      strokeDasharray={seriesDash(r.intent.style)}
                      strokeLinecap={seriesLinecap(r.intent.style)}
                      opacity={0.92}
                      pointerEvents="none"
                    />
                  )}
                  <path
                    data-series-path={r.intent.id}
                    data-series-ghost={r.ghost || undefined}
                    data-series-find-foreground={!r.ghost && hasGhostContext || undefined}
                    d={path}
                    fill="none"
                    stroke={seriesColor(r.intent.style)}
                    strokeWidth={r.ghost
                      ? ghostSeriesStrokeWidth(strokeFor(r.intent.id))
                      : hasGhostContext
                        ? findSeriesStrokeWidth(strokeFor(r.intent.id))
                        : strokeFor(r.intent.id)}
                    strokeDasharray={seriesDash(r.intent.style)}
                    strokeLinecap={seriesLinecap(r.intent.style)}
                    opacity={r.ghost ? GHOST_SERIES_OPACITY : selected.length > 0 ? 0.45 : 1}
                    pointerEvents={r.ghost ? 'none' : undefined}
                  />
                </g>
              )),
            )}
            {selected.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.values,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
                (b) => spanX(d, b),
              ).map((path, i) => (
                <path
                  key={`selected:${r.intent.id}:${i}`}
                  data-selected-overlay={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={seriesColor(r.intent.style)}
                  strokeWidth={strokeFor(r.intent.id) + 1.5}
                  strokeDasharray={seriesDash(r.intent.style)}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )),
            )}
            {Array.from({ length: trendRowsForDoc(geo, d).count }, (_, b) => {
              const rows = trendRowsForDoc(geo, d);
              const span = trendBinSpan(geo, d, b);
              if (span.end <= span.start) return null;
              const lines = foregroundReady
                .map((r) => {
                  const iRow = rows.start + b;
                  const displayed = r.values[iRow];
                  const formatted = displayed !== undefined && Number.isFinite(displayed)
                    ? `${formatTrendDisplayValue(displayed, measure)}${trendMeasureUnit(measure)}`
                    : 'gap';
                  return `${r.intent.label}: ${r.trend.count[iRow]}× (${formatted})`;
                })
                .join('\n');
              return (
                <rect
                  key={b}
                  data-trend-hit-row={d}
                  x={bookXFromTokenEdge(span.start, plotW, domain)}
                  y={rowY}
                  width={Math.max(
                    1,
                    bookXFromTokenEdge(span.end, plotW, domain)
                      - bookXFromTokenEdge(span.start, plotW, domain),
                  )}
                  height={geometry.rowHeight}
                  fill="transparent"
                >
                  <title>{`${title}, bin ${b + 1}/${rows.count}\n${lines}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      {/* Moving cursor lives in ScrubSurface's overlay div, not this SVG. */}
      {__TT_E2E__ && <ChartCommitProbe view={view} />}
    </svg>
  );
});
