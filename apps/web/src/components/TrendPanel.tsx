/**
 * Trend comparison — two views over the same declared-sequence results:
 *
 * - 'series' (primary): one axis, books concatenated in declared reading
 *   order with token-proportional widths (sequenceBases + docTokenCount).
 *   One line per term. Paths BREAK at every book boundary — a slope from the
 *   last bin of one book into the first bin of the next would fabricate a
 *   trend across a structural discontinuity.
 * - 'by-book': one row per book on a normalized 0–100% axis, all terms in
 *   each row.
 *
 * Both views share one y-scale across every term and book so magnitude
 * comparison stays honest. Rate denominator and optional within-book
 * smoothing are presentation settings; count is a separate unsmoothed view. Series identity
 * is color + dash in the Terms footer — never color alone. The plot holds
 * until every non-failed series resolves so the shared scale never jumps.
 * Exact per-book values live in Catalog; this surface stays focused on shape,
 * distribution, and reading-position interaction.
 *
 * The chart spans its container's full width (the app gives it the viewport)
 * via a measured ResizeObserver width; the axis position under the pointer /
 * keyboard scrubber drives the shared reading cursor and concordance center.
 * Pointer motion is rAF-coalesced and deduplicated.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NumericTrend, WorkspaceTrendMeasureV1 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { BarcodeBand, BarcodeLegend } from './BarcodeStrip.tsx';
import {
  barcodeReaderActivation,
  captureBarcodePointerTarget,
  resolveCapturedBarcodeTarget,
  type BarcodeActivation,
  type BarcodePointerSample,
  type BarcodeTrackVM,
  type CapturedBarcodeTarget,
} from '../lib/barcode-view.ts';
import { slotColor, slotDash } from '../lib/series-style.ts';
import {
  bookXFromToken,
  bookXFromTokenEdge,
  barcodeBandExtent,
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  seriesXFromToken,
  seriesXFromTokenEdge,
  stepAlongSequence,
  trendBinAtToken,
  trendBinSpan,
  trendRowsForDoc,
  trendStageHit,
  type SequenceLayout,
  type TrendStageSpec,
} from '../lib/trend-geometry.ts';
import type { ScrubTarget, SeriesIntent } from '../lib/store.ts';
import { recordChartCommit } from '../lib/e2e-probe.ts';
import {
  commitRange,
  selectionTokenCount,
  type TokenRangeSelectionSpanV1,
} from '../lib/selection.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { trendGeometryFor, type TrendGeometry } from '../lib/trend-compact.ts';
import {
  trendDisplayValues,
  trendMeasureUnit,
  trendRawValues,
} from '../lib/trend-display.ts';
import { trendStageGeometry, trendStageProjection, trendStageSnapIndexes } from '../lib/trend-stage.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import { pointerIntentFor } from '../lib/pointer-capability.ts';
import {
  TOUCH_RANGE_HOLD_MS,
  beginTouchRangeGesture,
  resetTouchRangeGesture,
  touchRangeCancel,
  touchRangeDown,
  touchRangeHold,
  touchRangeMove,
  touchRangeUp,
  type TouchRangeEffect,
  type TouchRangeGesture,
} from '../lib/touch-range-gesture.ts';

const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
}

interface DisplayedSeries extends ReadySeries {
  readonly values: Float64Array;
  readonly rawValues: Float64Array;
}

interface RangePreview {
  readonly mode: 'pointer' | 'touch' | 'touch-anchor' | 'keyboard';
  readonly origin: ScrubTarget;
  readonly head: ScrubTarget;
}

interface StagePointerTargetBase extends ScrubTarget {
  readonly d: number;
  /** Unsnapped inversion retained for density-cell activation and raw scrub. */
  readonly rawToken: number;
}

type StagePointerTarget =
  | (StagePointerTargetBase & { readonly zone: 'plot' })
  | (StagePointerTargetBase & {
      readonly zone: 'barcode';
      readonly trackRow: number;
      readonly trackId: string;
      readonly snapActivation: BarcodeActivation | null;
    });

type CaptureBarcodePointer = (
  sample: BarcodePointerSample,
  allowExactSnap: boolean,
) => CapturedBarcodeTarget | null;

export function TrendPanel() {
  // Deliberately NO `scrub` subscription here: it updates once per
  // pointer animation frame, and this component's render rebuilds every path,
  // hover rect, and totals row. The ScrubSurface child owns the
  // per-frame state; this panel re-renders only on data/view/focus/resize
  // changes (the Phase B ruling's invariant).
  const series = useApp((s) => s.series);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const trends = useApp((s) => s.trends);
  const selectedTrends = useApp((s) => s.selectedTrends);
  const dispersion = useApp((s) => s.dispersion);
  const selectedDispersion = useApp((s) => s.selectedDispersion);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const trendView = useApp((s) => s.trendView);
  const trendMeasure = useApp((s) => s.trendMeasure);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const centerKwicAt = useApp((s) => s.centerKwicAt);
  const setScrub = useApp((s) => s.setScrub);
  const openReader = useApp((s) => s.openReader);
  const presentation = usePresentation();
  const geometry = trendGeometryFor(presentation.width);

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

  const states = series.map((intent) => ({ intent, state: trends.get(intent.id) }));
  const pending = states.filter((s) => !s.state || s.state.status === 'pending');
  const failed = states.filter((s) => s.state?.status === 'error');
  const failureText = (failure: (typeof failed)[number]) =>
    `${failure.intent.label}: ${failure.state?.status === 'error' ? failure.state.message : 'query failed'}`;
  const ready: ReadySeries[] = states.flatMap(({ intent, state }) =>
    state?.status === 'ready' ? [{ intent, trend: state.trend }] : [],
  );
  const selectedReady: ReadySeries[] = series.flatMap((intent) => {
    const state = selectedTrends.get(intent.id);
    return state?.status === 'ready' ? [{ intent, trend: state.trend }] : [];
  });
  const readyGeo = ready[0]?.trend ?? null;
  const stageProjection = useMemo(() => {
    if (
      series.length === 0
      || pending.length > 0
      || !readyGeo
      || !readyGeo.sequenceBases
    ) return null;
    return trendStageProjection({
      trend: readyGeo,
      seriesOrder: series.map((item) => item.id),
      dispersion: dispersion?.state.status === 'ready' ? dispersion.state.result : null,
      selectedDispersion: selectedDispersion?.state.status === 'ready'
        ? selectedDispersion.state.result
        : null,
      selectedDocs: linkedSelection?.ranges.map((range) => range.doc) ?? [],
      geometry,
    });
  }, [dispersion, geometry, linkedSelection, pending.length, readyGeo, selectedDispersion, series]);
  const stageGeometry = useMemo(() => stageProjection
    ? trendStageGeometry(stageProjection, {
        plotWidth: plotW,
        view: trendView,
      })
    : null,
  [plotW, stageProjection, trendView]);
  const snapIndexCache = useRef<{
    readonly projection: NonNullable<typeof stageProjection>;
    readonly indexes: ReturnType<typeof trendStageSnapIndexes>;
  } | null>(null);
  const styleSlotBySeries = useMemo(
    () => new Map(series.map((item) => [item.id, item.styleSlot])),
    [series],
  );
  const labelBySeries = useMemo(
    () => new Map(series.map((item) => [item.id, item.label])),
    [series],
  );
  const slotOf = useCallback((id: string) => styleSlotBySeries.get(id) ?? 0, [styleSlotBySeries]);
  const labelOf = useCallback((id: string) => labelBySeries.get(id) ?? id, [labelBySeries]);

  if (series.length === 0) return null;

  // Hold the comparison until the current set settles: a shared y-scale that
  // re-fits as each line lands reads as data changing when it isn't.
  if (pending.length > 0) {
    return (
      <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>computing trends…</p>
    );
  }
  if (ready.length === 0) {
    return failed.length > 0 ? (
      <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
        {failed.map(failureText).join(' · ')}
      </p>
    ) : null;
  }

  // Geometry is identical across series (same snapshot, selection, bins) —
  // take it from the first ready result.
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
  const {
    edgeX,
    hitSpec,
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
    // only on the first precise barcode event, retain them for this projection,
    // and never turn hover into a React render/chart commit.
    let exactIndexes: ReturnType<typeof trendStageSnapIndexes> = [];
    if (allowExactSnap) {
      const cached = snapIndexCache.current;
      if (cached?.projection === stageProjection) {
        exactIndexes = cached.indexes;
      } else {
        exactIndexes = trendStageSnapIndexes(stageProjection);
        snapIndexCache.current = { projection: stageProjection, indexes: exactIndexes };
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
    setScrub({ doc: target.doc, token: target.token });
    centerKwicAt(
      track.seriesId,
      target.doc,
      target.token,
      target.kind === 'bucket' ? { kind: 'bucket', count: target.bucketCount ?? 0 } : undefined,
    );
    const readerTarget = openExact ? barcodeReaderActivation(target) : null;
    if (readerTarget && dispersion) {
      openReader({
        snapshot: dispersion.snapshot,
        doc: readerTarget.doc,
        token: readerTarget.token,
        from: 'barcode',
      });
    }
  };
  const displayedReady: DisplayedSeries[] = ready.map((item) => ({
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
        ? [item.rawValues]
        : []),
    ]),
    ...displayedSelected.map((item) => item.values),
  ];
  const maxValue = Math.max(
    1e-9,
    ...plottedArrays.map((values) => {
      let maximum = 0;
      for (const value of values) {
        if (Number.isFinite(value)) maximum = Math.max(maximum, value);
      }
      return maximum;
    }),
  );
  const strokeFor = (id: string) =>
    id === focusedSeries ? geometry.strokeFocused : geometry.strokeOther;

  return (
    <section>
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
      <ScrubSurface
        containerRef={setContainerEl}
        trendView={trendView}
        docs={docs}
        titleByDoc={titleByDoc}
        layout={layout}
        trend={geo}
        plotW={plotW}
        series={series}
        focusedSeries={focusedSeries}
        geometry={geometry}
        barcodeHeight={barcodeHeight}
        rowPitch={rowPitch}
        barcodeTracks={tracks}
        captureBarcode={captureBarcode}
        hitSpec={hitSpec}
        onBarcodeActivate={activateBarcode}
        barcodeBand={(
          <BarcodeBand
            view={trendView}
            docs={docs}
            tracks={tracks}
            selectedTracks={selectedTracks}
            linkedSelection={linkedSelection !== null}
            edgeX={edgeX}
            width={plotW}
            plotHeight={trendView === 'series' ? geometry.seriesHeight : geometry.rowHeight}
            rowPitch={rowPitch}
            bandGap={geometry.barcodeBandGap}
            trackHeight={geometry.barcodeTrackHeight}
            trackGap={geometry.barcodeTrackGap}
            slotOf={slotOf}
            focusedSeries={focusedSeries}
            coarse={presentation.coarseAvailable}
          />
        )}
      >
        {trendView === 'series' ? (
          <SeriesView
            ready={displayedReady}
            selected={displayedSelected}
            docs={docs}
            titles={titles}
            bases={bases}
            maxValue={maxValue}
            measure={trendMeasure}
            plotW={plotW}
            strokeFor={strokeFor}
            geometry={geometry}
            barcodeHeight={barcodeHeight}
          />
        ) : (
          <ByBookView
            ready={displayedReady}
            selected={displayedSelected}
            docs={docs}
            titles={titles}
            maxValue={maxValue}
            measure={trendMeasure}
            plotW={plotW}
            strokeFor={strokeFor}
            geometry={geometry}
            rowPitch={rowPitch}
          />
        )}
      </ScrubSurface>
      <BarcodeLegend
        tracks={tracks}
        selectedTracks={selectedTracks}
        linkedSelection={linkedSelection !== null}
        selectedStatus={linkedSelection ? selectedDispersion?.state.status ?? 'pending' : null}
        slotOf={slotOf}
        labelOf={labelOf}
        focusedSeries={focusedSeries}
        onActivate={activateBarcode}
      />
    </section>
  );
}

/**
 * The per-frame half of the trend panel: the ONLY component that subscribes
 * to `scrub` (which updates once per pointer animation frame). It
 * owns the slider container (pointer + keyboard + ARIA), the moving chart
 * cursor — an absolutely-positioned overlay div, NOT an SVG line, so cursor
 * motion never re-renders the chart or its caption/hint area.
 *
 * The chart SVG arrives as `children`, created by the non-rendering outer
 * panel, so every scrub-frame render here hands React the SAME element and
 * the chart subtree is skipped entirely. The load-bearing invariant is
 * "TrendPanel does not subscribe to scrub and its child element is
 * stable across child-local updates" — the views' React.memo is secondary
 * protection, not the contract (their props may legitimately change identity
 * whenever the outer panel really re-renders).
 */
function ScrubSurface({
  containerRef,
  trendView,
  docs,
  titleByDoc,
  layout,
  trend,
  plotW,
  series,
  focusedSeries,
  geometry,
  barcodeHeight,
  rowPitch,
  barcodeTracks,
  captureBarcode,
  hitSpec,
  onBarcodeActivate,
  barcodeBand,
  children,
}: {
  containerRef: (el: HTMLDivElement | null) => void;
  trendView: 'series' | 'by-book';
  docs: readonly string[];
  titleByDoc: ReadonlyMap<string, string>;
  layout: SequenceLayout;
  trend: NumericTrend;
  plotW: number;
  series: readonly SeriesIntent[];
  focusedSeries: string | null;
  geometry: TrendGeometry;
  barcodeHeight: number;
  rowPitch: number;
  barcodeTracks: readonly BarcodeTrackVM[];
  captureBarcode: CaptureBarcodePointer;
  hitSpec: TrendStageSpec;
  onBarcodeActivate: (track: BarcodeTrackVM, target: BarcodeActivation | null, openExact?: boolean) => void;
  barcodeBand: React.ReactNode;
  children: React.ReactNode;
}) {
  const scrub = useApp((s) => s.scrub);
  const setScrub = useApp((s) => s.setScrub);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const setTrendView = useApp((s) => s.setTrendView);
  const [preview, setPreview] = useState<RangePreview | null>(null);
  const [rangeAnnouncement, setRangeAnnouncement] = useState('');
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const touchGesture = useRef<TouchRangeGesture>(beginTouchRangeGesture());
  const touchHoldTimer = useRef<{
    readonly pointerId: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const releasedTouchPointers = useRef(new Set<number>());

  // rAF-coalesced pointer scrubbing: the latest pointer sample wins the frame.
  const pointerSample = useRef<ScrubTarget | null>(null);
  const frame = useRef<number | null>(null);
  const scheduleScrub = useCallback(
    (target: ScrubTarget | null) => {
      if (!target) return;
      pointerSample.current = { doc: target.doc, token: target.token };
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null;
        if (pointerSample.current) setScrub(pointerSample.current);
      });
    },
    [setScrub],
  );
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (touchHoldTimer.current !== null) clearTimeout(touchHoldTimer.current.timer);
  }, []);

  const docTokenCount = layout.tokenCounts;
  const bandExtent = barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  const scrubDocOrdinal = scrub ? docs.indexOf(scrub.doc) : -1;
  const scrubX =
    scrub && scrubDocOrdinal >= 0
      ? trendView === 'series'
        ? seriesXFromToken(scrubDocOrdinal, scrub.token, plotW, layout)
        : bookXFromToken(scrub.token, plotW, docTokenCount[scrubDocOrdinal] ?? 0)
      : null;

  const targetFromPointer = (
    px: number,
    py: number,
    allowSnap = true,
  ): StagePointerTarget | null => {
    const hit = trendStageHit(px, py, hitSpec);
    if (!hit) return null;
    const doc = docs[hit.d];
    if (doc === undefined) return null;
    // A series pointer owns the document it inverted into. Do not cross a
    // declared document boundary merely because another lane's tick is close.
    if (hit.zone === 'plot') return {
      d: hit.d,
      doc,
      token: hit.token,
      rawToken: hit.token,
      zone: 'plot',
    };
    const captured = captureBarcode({
      trackRow: hit.trackRow,
      docOrdinal: hit.d,
      doc,
      rawToken: hit.token,
      px,
    }, allowSnap);
    if (!captured) return null;
    return {
      d: hit.d,
      doc,
      token: captured.exactActivation?.token ?? hit.token,
      rawToken: hit.token,
      zone: 'barcode',
      trackRow: hit.trackRow,
      trackId: captured.trackId,
      snapActivation: captured.exactActivation,
    };
  };

  const commitPreview = (range: RangePreview) => {
    const selection = snapshot
      ? commitRange(
          snapshot.snapshot,
          range.origin,
          range.head,
          docs,
          docTokenCount,
        )
      : null;
    if (!selection) {
      if (range.mode !== 'keyboard') setPreview(null);
      setRangeAnnouncement('Range selection cancelled.');
      return;
    }
    setLinkedSelection(selection);
    setPreview(null);
    const tokenCount = selectionTokenCount(selection);
    setRangeAnnouncement(
      `Range applied: ${tokenCount.toLocaleString()} token${tokenCount === 1 ? '' : 's'}.`,
    );
  };

  const applyTouchRangeEffect = (effect: TouchRangeEffect) => {
    switch (effect.kind) {
      case 'scrub':
      case 'tap':
        if (effect.kind === 'scrub') scheduleScrub(effect.point);
        else setScrub(effect.point);
        return;
      case 'anchor':
        setPreview({ mode: 'touch-anchor', origin: effect.point, head: effect.point });
        setRangeAnnouncement('Range start set. Tap another position to select.');
        return;
      case 'preview':
        setPreview({
          mode: touchGesture.current.phase === 'anchored' ? 'touch-anchor' : 'touch',
          origin: effect.origin,
          head: effect.head,
        });
        return;
      case 'commit':
        commitPreview({ mode: 'touch', origin: effect.origin, head: effect.head });
        return;
      case 'cancel':
        setPreview((current) =>
          current?.mode === 'touch' || current?.mode === 'touch-anchor'
            ? null
            : current);
        setRangeAnnouncement('Range selection cancelled.');
        return;
      case 'none':
        return;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  };

  const clearTouchHold = () => {
    if (touchHoldTimer.current === null) return;
    clearTimeout(touchHoldTimer.current.timer);
    touchHoldTimer.current = null;
  };

  const startTouchHold = (pointerId: number) => {
    clearTouchHold();
    touchHoldTimer.current = {
      pointerId,
      timer: setTimeout(() => {
        touchHoldTimer.current = null;
        const transition = touchRangeHold(touchGesture.current, pointerId);
        touchGesture.current = transition.state;
        if (transition.state.phase === 'anchored') {
          try {
            sliderRef.current?.setPointerCapture(pointerId);
          } catch {
            // Synthetic PointerEvents do not create native capture state.
          }
        }
        applyTouchRangeEffect(transition.effect);
      }, TOUCH_RANGE_HOLD_MS),
    };
  };

  const releaseCapturedPointer = (element: HTMLDivElement, pointerId: number) => {
    if (!element.hasPointerCapture(pointerId)) return;
    releasedTouchPointers.current.add(pointerId);
    element.releasePointerCapture(pointerId);
  };

  useEffect(() => {
    clearTouchHold();
    const reset = resetTouchRangeGesture(touchGesture.current);
    touchGesture.current = reset.state;
    applyTouchRangeEffect(reset.effect);
  }, [snapshot?.snapshot, trend]);

  const pointerDrag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    origin: ScrubTarget;
    head: ScrubTarget;
    active: boolean;
  } | null>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep browser/application shortcuts (notably Cmd/Ctrl+S) intact. Shift
    // remains unguarded because it deliberately changes the scrub step.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      shortcutMatches(e, 'trend-selection-cancel')
      && touchGesture.current.phase !== 'idle'
    ) {
      e.preventDefault();
      clearTouchHold();
      const reset = resetTouchRangeGesture(touchGesture.current);
      touchGesture.current = reset.state;
      applyTouchRangeEffect(reset.effect);
      return;
    }
    if (
      shortcutMatches(e, 'trend-toggle-view')
      && preview === null
    ) {
      e.preventDefault();
      setTrendView(trendView === 'series' ? 'by-book' : 'series');
      return;
    }
    if (
      shortcutMatches(e, 'trend-selection-start')
      && preview === null
    ) {
      if (scrub && scrubDocOrdinal >= 0) {
        e.preventDefault();
        setPreview({ mode: 'keyboard', origin: scrub, head: scrub });
        setRangeAnnouncement('Keyboard range started.');
      }
      return;
    }
    if (preview?.mode === 'keyboard') {
      const d = docs.indexOf(preview.head.doc);
      const count = docTokenCount[d] ?? 0;
      let head: ScrubTarget = preview.head;
      if (
        shortcutMatches(e, 'trend-step-previous')
        || shortcutMatches(e, 'trend-step-five-previous')
      ) {
          const next = stepAlongSequence(d, preview.head.token, -1, layout);
          head = next ? { doc: docs[next.d]!, token: next.token } : preview.head;
      } else if (
        shortcutMatches(e, 'trend-step-next')
        || shortcutMatches(e, 'trend-step-five-next')
      ) {
          const next = stepAlongSequence(d, preview.head.token, 1, layout);
          head = next ? { doc: docs[next.d]!, token: next.token } : preview.head;
      } else if (shortcutMatches(e, 'trend-book-start')) {
        head = { doc: preview.head.doc, token: 0 };
      } else if (shortcutMatches(e, 'trend-book-end')) {
        head = { doc: preview.head.doc, token: Math.max(0, count - 1) };
      } else if (shortcutMatches(e, 'trend-selection-commit')) {
        e.preventDefault();
        commitPreview(preview);
        return;
      } else if (shortcutMatches(e, 'trend-selection-cancel')) {
        e.preventDefault();
        setPreview(null);
        setRangeAnnouncement('Range selection cancelled.');
        return;
      } else {
        return;
      }
      e.preventDefault();
      setPreview({
        ...preview,
        head,
      });
      return;
    }
    const current: ScrubTarget =
      scrub && scrubDocOrdinal >= 0
        ? scrub
        : { doc: docs.find((_, d) => (docTokenCount[d] ?? 0) > 0) ?? '', token: 0 };
    const d = docs.indexOf(current.doc);
    if (d < 0) return;
    const tc = docTokenCount[d] ?? 0;
    const currentBin = trendBinAtToken(trend, d, current.token);
    const binWidth = currentBin === null
      ? 1
      : Math.max(1, currentBin.span.end - currentBin.span.start);
    const step = (delta: number): ScrubTarget | null => {
      if (trendView === 'series') {
        const next = stepAlongSequence(d, current.token, delta, layout);
        return next ? { doc: docs[next.d]!, token: next.token } : null;
      }
      return { doc: current.doc, token: Math.max(0, Math.min(tc - 1, current.token + delta)) };
    };
    let next: ScrubTarget | null = null;
    if (shortcutMatches(e, 'trend-step-five-previous')) next = step(-5);
    else if (shortcutMatches(e, 'trend-step-five-next')) next = step(5);
    else if (shortcutMatches(e, 'trend-step-previous')) next = step(-1);
    else if (shortcutMatches(e, 'trend-step-next')) next = step(1);
    else if (shortcutMatches(e, 'trend-bin-previous')) next = step(-binWidth);
    else if (shortcutMatches(e, 'trend-bin-next')) next = step(binWidth);
    else if (shortcutMatches(e, 'trend-book-start')) next = { doc: current.doc, token: 0 };
    else if (shortcutMatches(e, 'trend-book-end')) next = { doc: current.doc, token: Math.max(0, tc - 1) };
    else return;
    e.preventDefault();
    if (next) setScrub(next);
  };

  const scrubTitle = scrub ? titleByDoc.get(scrub.doc) ?? scrub.doc : '';
  const scrubCaption = scrub && scrubDocOrdinal >= 0
    ? `${scrubTitle} · token ${(scrub.token + 1).toLocaleString()} of ${(docTokenCount[scrubDocOrdinal] ?? 0).toLocaleString()}`
    : '';

  // Cursor geometry per the Phase B ruling: series spans topPad..seriesHeight;
  // by-book covers only the scrubbed row. transform (not left/top mutation)
  // so frame-to-frame motion is a compositor-friendly update.
  const cursorTop = trendView === 'series'
    ? geometry.topPad
    : scrubDocOrdinal * rowPitch;
  const cursorHeight = trendView === 'series'
    ? geometry.seriesHeight + bandExtent - geometry.topPad
    : geometry.rowHeight + bandExtent;

  const shownRanges: readonly TokenRangeSelectionSpanV1[] = preview
    ? commitRange('', preview.origin, preview.head, docs, docTokenCount)?.ranges ?? []
    : linkedSelection?.ranges ?? [];
  const rangeBoxes = trendView === 'series' && shownRanges.length > 0
    ? (() => {
        const first = shownRanges[0]!;
        const last = shownRanges.at(-1)!;
        const firstOrdinal = docs.indexOf(first.doc);
        const lastOrdinal = docs.indexOf(last.doc);
        return firstOrdinal < 0 || lastOrdinal < 0 ? [] : [{
          left: seriesXFromTokenEdge(firstOrdinal, first.tokens.start, plotW, layout),
          right: seriesXFromTokenEdge(lastOrdinal, last.tokens.end, plotW, layout),
          top: geometry.topPad,
          height: geometry.seriesHeight + bandExtent - geometry.topPad,
        }];
      })()
    : shownRanges.flatMap((range) => {
        const ordinal = docs.indexOf(range.doc);
        return ordinal < 0 ? [] : [{
          left: bookXFromTokenEdge(
            range.tokens.start,
            plotW,
            docTokenCount[ordinal] ?? 0,
          ),
          right: bookXFromTokenEdge(
            range.tokens.end,
            plotW,
            docTokenCount[ordinal] ?? 0,
          ),
          top: ordinal * rowPitch,
          height: geometry.rowHeight + bandExtent,
        }];
      });
  const describeRanges = (ranges: readonly TokenRangeSelectionSpanV1[]): string => {
    if (ranges.length === 0) return 'no tokens';
    if (ranges.length === 1) {
      const range = ranges[0]!;
      return `${titleByDoc.get(range.doc) ?? range.doc}, tokens ${range.tokens.start + 1}–${range.tokens.end}`;
    }
    const first = ranges[0]!;
    const last = ranges.at(-1)!;
    const count = selectionTokenCount({ snapshot: '', ranges });
    return `${titleByDoc.get(first.doc) ?? first.doc} token ${first.tokens.start + 1} → ${titleByDoc.get(last.doc) ?? last.doc} token ${last.tokens.end} · ${count.toLocaleString()} tokens across ${ranges.length} books`;
  };
  const anchoredWaiting = preview?.mode === 'touch-anchor'
    && touchGesture.current.phase === 'anchored'
    && touchGesture.current.endpoint === null;
  const rangeStatus = preview
    ? anchoredWaiting
      ? `Range start set at ${describeRanges(shownRanges)} · tap another position`
      : `Selecting ${describeRanges(shownRanges)}`
    : '';

  const pointerTap = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly origin: StagePointerTarget;
    readonly pointerType: string;
    moved: boolean;
  } | null>(null);
  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div
        ref={sliderRef}
        className="trend-scrubber"
        role="slider"
        id="reading-position-scrubber"
        tabIndex={0}
        aria-label="Reading position scrubber"
        aria-keyshortcuts={shortcutAria([
          'trend-step-previous',
          'trend-step-next',
          'trend-step-five-previous',
          'trend-step-five-next',
          'trend-bin-previous',
          'trend-bin-next',
          'trend-book-start',
          'trend-book-end',
          'trend-selection-start',
          'trend-selection-commit',
          'trend-selection-cancel',
          'trend-toggle-view',
        ])}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, layout.totalTokens - 1)}
        aria-valuenow={
          preview?.mode === 'keyboard'
            ? (layout.bases[docs.indexOf(preview.head.doc)] ?? 0) + preview.head.token
            : scrub && scrubDocOrdinal >= 0
              ? (layout.bases[scrubDocOrdinal] ?? 0) + scrub.token
              : 0
        }
        aria-valuetext={
          preview?.mode === 'keyboard'
            ? `${titleByDoc.get(preview.head.doc) ?? preview.head.doc} · selection head token ${(preview.head.token + 1).toLocaleString()}`
            : scrubCaption || 'no position'
        }
        onKeyDown={onKeyDown}
        style={{ width: '100%', outline: 'none', position: 'relative', touchAction: 'pan-y' }}
        onContextMenu={(event) => {
          if (touchGesture.current.phase !== 'idle') event.preventDefault();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          clearTouchHold();
          const reset = resetTouchRangeGesture(touchGesture.current);
          touchGesture.current = reset.state;
          applyTouchRangeEffect(reset.effect);
          setPreview((current) => current?.mode === 'keyboard' ? null : current);
          setLinkedSelection(null);
          setRangeAnnouncement('Range cleared.');
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          if (e.pointerType === 'touch') {
            const before = touchGesture.current;
            if (before.phase === 'idle') return;
            const target = targetFromPointer(px, py, false);
            const transition = touchRangeMove(before, {
              pointerId: e.pointerId,
              point: target ? { doc: target.doc, token: target.token } : null,
              clientX: e.clientX,
              clientY: e.clientY,
            });
            touchGesture.current = transition.state;
            if (
              before.phase === 'ranging'
              || before.phase === 'anchored'
              || before.phase === 'spent'
            ) e.preventDefault();
            applyTouchRangeEffect(transition.effect);
            return;
          }
          if (touchGesture.current.phase !== 'idle') return;
          const precise = pointerIntentFor(e.pointerType) === 'precise';
          const target = targetFromPointer(px, py, precise);
          const tap = pointerTap.current;
          if (tap?.pointerId === e.pointerId) {
            if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= 4) {
              tap.moved = true;
            }
            scheduleScrub(target);
            return;
          }
          const drag = pointerDrag.current;
          if (drag?.pointerId === e.pointerId) {
            const rangeTarget = targetFromPointer(px, py, false);
            if (!rangeTarget) return;
            const distance = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
            if (!drag.active && distance >= 4) drag.active = true;
            if (drag.active) {
              drag.head = { doc: rangeTarget.doc, token: rangeTarget.token };
              setPreview({ mode: 'pointer', origin: drag.origin, head: drag.head });
            }
            return;
          }
          scheduleScrub(target);
        }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const precise = pointerIntentFor(e.pointerType) === 'precise';
          const origin = targetFromPointer(
            e.clientX - rect.left,
            e.clientY - rect.top,
            e.pointerType === 'touch' ? false : precise,
          );
          if (!origin) return;
          if (e.pointerType === 'touch') {
            if (pointerDrag.current) return;
            releasedTouchPointers.current.delete(e.pointerId);
            pointerTap.current = null;
            const before = touchGesture.current;
            const transition = touchRangeDown(before, {
              pointerId: e.pointerId,
              point: { doc: origin.doc, token: origin.token },
              clientX: e.clientX,
              clientY: e.clientY,
            });
            touchGesture.current = transition.state;
            if (before.phase === 'idle' && transition.state.phase === 'reading') {
              startTouchHold(e.pointerId);
            } else {
              clearTouchHold();
            }
            if (transition.state.phase === 'ranging') {
              pointerTap.current = null;
              setPreview((current) => current?.mode === 'keyboard' ? null : current);
              for (const pointerId of transition.state.heldPointerIds) {
                try {
                  e.currentTarget.setPointerCapture(pointerId);
                } catch {
                  // Synthetic PointerEvents do not register an active native
                  // pointer; browser-delivered touches do and are captured.
                }
              }
              e.preventDefault();
            } else if (
              transition.state.phase === 'anchored'
              && transition.state.endpoint?.pointerId === e.pointerId
            ) {
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // Synthetic PointerEvents do not register native capture.
              }
              e.preventDefault();
            } else if (
              before.phase === 'ranging'
              || before.phase === 'anchored'
              || before.phase === 'spent'
            ) {
              e.preventDefault();
            }
            applyTouchRangeEffect(transition.effect);
            return;
          }
          if (touchGesture.current.phase !== 'idle') return;
          if (origin.zone === 'barcode' || e.pointerType !== 'mouse') {
            if (precise) e.currentTarget.setPointerCapture(e.pointerId);
            pointerTap.current = {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              origin,
              pointerType: e.pointerType,
              moved: false,
            };
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          pointerDrag.current = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            origin: { doc: origin.doc, token: origin.token },
            head: { doc: origin.doc, token: origin.token },
            active: false,
          };
          setPreview(null);
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'touch') {
            if (touchHoldTimer.current?.pointerId === e.pointerId) clearTouchHold();
            const before = touchGesture.current;
            if (before.phase === 'idle') return;
            const rect = e.currentTarget.getBoundingClientRect();
            const target = targetFromPointer(
              e.clientX - rect.left,
              e.clientY - rect.top,
              false,
            );
            const transition = touchRangeUp(before, {
              pointerId: e.pointerId,
              point: target ? { doc: target.doc, token: target.token } : null,
              clientX: e.clientX,
              clientY: e.clientY,
            });
            touchGesture.current = transition.state;
            releaseCapturedPointer(e.currentTarget, e.pointerId);
            if (
              before.phase === 'ranging'
              || before.phase === 'anchored'
              || before.phase === 'spent'
            ) e.preventDefault();
            applyTouchRangeEffect(transition.effect);
            return;
          }
          if (touchGesture.current.phase !== 'idle') return;
          const tap = pointerTap.current;
          if (tap?.pointerId === e.pointerId) {
            pointerTap.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            if (!tap.moved) {
              if (
                tap.origin.zone === 'barcode'
                && pointerIntentFor(tap.pointerType) === 'precise'
              ) {
                const resolution = resolveCapturedBarcodeTarget(barcodeTracks, {
                  trackId: tap.origin.trackId,
                  doc: tap.origin.doc,
                  rawToken: tap.origin.rawToken,
                  exactActivation: tap.origin.snapActivation ?? null,
                });
                if (resolution.kind === 'activation') {
                  onBarcodeActivate(resolution.track, resolution.activation, true);
                } else {
                  setScrub({ doc: resolution.doc, token: resolution.token });
                }
              } else {
                setScrub({ doc: tap.origin.doc, token: tap.origin.token });
              }
            }
            return;
          }
          const drag = pointerDrag.current;
          if (!drag || drag.pointerId !== e.pointerId) return;
          pointerDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          if (drag.active) {
            commitPreview({ mode: 'pointer', origin: drag.origin, head: drag.head });
          } else {
            setScrub(drag.origin);
          }
        }}
        onPointerCancel={(e) => {
          if (e.pointerType === 'touch') {
            if (touchHoldTimer.current?.pointerId === e.pointerId) clearTouchHold();
            const before = touchGesture.current;
            const transition = touchRangeCancel(before, e.pointerId);
            touchGesture.current = transition.state;
            releaseCapturedPointer(e.currentTarget, e.pointerId);
            applyTouchRangeEffect(transition.effect);
            return;
          }
          if (pointerTap.current?.pointerId === e.pointerId) {
            pointerTap.current = null;
          }
          if (pointerDrag.current?.pointerId !== e.pointerId) return;
          pointerDrag.current = null;
          setPreview(null);
        }}
        onLostPointerCapture={(e) => {
          if (e.pointerType !== 'touch') return;
          if (releasedTouchPointers.current.delete(e.pointerId)) return;
          const transition = touchRangeCancel(touchGesture.current, e.pointerId);
          touchGesture.current = transition.state;
          applyTouchRangeEffect(transition.effect);
        }}
      >
        {children}
        {barcodeBand}
        {rangeBoxes.map((rangeBox, index) => (
          <div
            key={`${rangeBox.left}:${rangeBox.top}:${rangeBox.right}`}
            aria-hidden="true"
            data-range-selection-segment="true"
            data-testid={index === 0
              ? preview
                ? 'selection-preview'
                : 'linked-selection'
              : undefined}
            style={{
              position: 'absolute',
              left: rangeBox.left,
              top: rangeBox.top,
              width: Math.max(1, rangeBox.right - rangeBox.left),
              height: rangeBox.height,
              background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
              borderInline: '1px solid color-mix(in srgb, var(--accent) 70%, transparent)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        ))}
        {scrubX !== null && (
          <div
            aria-hidden="true"
            data-testid="chart-cursor"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: cursorHeight,
              transform: `translate3d(${scrubX}px, ${cursorTop}px, 0)`,
              willChange: 'transform',
              background: 'var(--fg-muted)',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          />
        )}
      </div>
      {(rangeStatus || linkedSelection) && (
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {rangeStatus}
          {preview?.mode === 'keyboard' ? ' · arrows extend · Enter commits · Escape cancels' : ''}
          {preview?.mode === 'touch-anchor' ? (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => {
                  clearTouchHold();
                  const reset = resetTouchRangeGesture(touchGesture.current);
                  touchGesture.current = reset.state;
                  applyTouchRangeEffect(reset.effect);
                }}
                style={{
                  font: 'inherit',
                  color: 'var(--fg)',
                  background: 'none',
                  border: '1px solid var(--rule)',
                  cursor: 'pointer',
                  padding: '0 0.5ch',
                }}
              >
                cancel range
              </button>
            </>
          ) : null}
          {linkedSelection && preview === null ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setLinkedSelection(null);
                  setRangeAnnouncement('Range cleared.');
                }}
                style={{
                  font: 'inherit',
                  color: 'var(--fg)',
                  background: 'none',
                  border: '1px solid var(--rule)',
                  cursor: 'pointer',
                  padding: '0 0.5ch',
                }}
              >
                clear selection
              </button>
            </>
          ) : null}
        </p>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {rangeAnnouncement}
      </span>
    </div>
  );
}

/** E2E-only commit counter (dead code in production builds): an effect with no
 *  dependency array fires after EVERY commit of its owning subtree, which is
 *  exactly the "did the chart re-render on scrub?" probe the regression test
 *  needs. Never incremented during render. */
function ChartCommitProbe({ view }: { view: 'series' | 'by-book' }) {
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
  measure,
  plotW,
  strokeFor,
  geometry,
  barcodeHeight,
}: {
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  bases: readonly number[];
  maxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  barcodeHeight: number;
}) {
  const geo = ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = linearMap(0, Math.max(1, totalTokens), 0, plotW);
  const y = linearMap(0, maxValue, geometry.seriesHeight, geometry.topPad);
  const axisY = geometry.seriesHeight;
  const barcodeBottom = axisY + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  const height = barcodeBottom + (geometry.bookMarks === 'ticks' ? 34 : 8);

  // One path segment per (series, doc) — the break at every boundary is
  // mandatory; connecting them would invent data.
  const pointX = (d: number, b: number) => {
    const { start, end } = trendBinSpan(geo, d, b);
    return x((bases[d] ?? 0) + (start + end) / 2);
  };

  return (
    <svg
      data-trend-view="series"
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${ready.map((r) => r.intent.label).join(', ')} across ${docs.length} books in reading order`}
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
        const x0 = x(bases[d] ?? 0);
        const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
        const title = titles[d] ?? doc;
        const n = String(d + 1);
        const label = (x1 - x0) > 7 * (title.length + 4) ? `${n} · ${title}` : n;
        return (
          <g key={doc}>
            {d > 0 && (
              <line x1={x0} y1={0} x2={x0} y2={axisY} stroke="var(--rule)" strokeWidth={1} />
            )}
            {geometry.bookMarks === 'ticks' && (
              <text
                x={(x0 + x1) / 2}
                y={barcodeBottom + 14}
                textAnchor="middle"
                fill="var(--fg-muted)"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-mono)"
              >
                {label}
                <title>{title}</title>
              </text>
            )}
          </g>
        );
      })}
      {/* y extent, direct-labeled at the max gridline — no axis chrome */}
      <line x1={0} y1={y(maxValue)} x2={plotW} y2={y(maxValue)} stroke="var(--rule)" strokeWidth={1} />
      <text x={0} y={y(maxValue) - 3} fill="var(--fg-muted)" fontSize="var(--text-xs)" fontFamily="var(--font-mono)">
        {maxValue.toFixed(measure.kind === 'count' ? 0 : 1)}{trendMeasureUnit(measure)}
      </text>
      {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && ready.flatMap((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            r.rawValues,
            (b) => clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP),
            y,
          ).map((path, index) => (
            <path
              key={`raw:${r.intent.id}:${doc}:${index}`}
              data-raw-series-path={r.intent.id}
              d={path}
              fill="none"
              stroke={slotColor(r.intent.styleSlot)}
              strokeWidth={1}
              strokeDasharray={slotDash(r.intent.styleSlot)}
              opacity={0.2}
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
          ).map((path, index) => (
            <path
              key={`${r.intent.id}:${doc}:${index}`}
              data-series-path={r.intent.id}
              d={path}
              fill="none"
              stroke={slotColor(r.intent.styleSlot)}
              strokeWidth={strokeFor(r.intent.id)}
              strokeDasharray={slotDash(r.intent.styleSlot)}
              strokeLinecap={slotDash(r.intent.styleSlot) === '1 3' ? 'round' : 'butt'}
              opacity={selected.length > 0 ? 0.45 : 1}
            />
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
          ).map((path, i) => (
            <path
              key={`selected:${r.intent.id}:${doc}:${i}`}
              data-selected-overlay={r.intent.id}
              d={path}
              fill="none"
              stroke={slotColor(r.intent.styleSlot)}
              strokeWidth={strokeFor(r.intent.id) + 1.5}
              strokeDasharray={slotDash(r.intent.styleSlot)}
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
          const lines = ready
            .map((r) => {
              const iRow = rows.start + b;
              const displayed = r.values[iRow];
              const formatted = displayed !== undefined && Number.isFinite(displayed)
                ? `${displayed.toFixed(measure.kind === 'count' ? 0 : 1)}${trendMeasureUnit(measure)}`
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
  ready,
  selected,
  docs,
  titles,
  maxValue,
  measure,
  plotW,
  strokeFor,
  geometry,
  rowPitch,
}: {
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  maxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  rowPitch: number;
}) {
  const geo = ready[0]!.trend;
  const y = linearMap(0, maxValue, geometry.rowHeight, 0);
  const height = docs.length * rowPitch + 4;
  const pointX = (d: number, b: number) => {
    const span = trendBinSpan(geo, d, b);
    const tokens = geo.docTokenCount[d] ?? 0;
    return bookXFromTokenEdge((span.start + span.end) / 2, plotW, tokens);
  };

  return (
    <svg
      data-trend-view="by-book"
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${ready.map((r) => r.intent.label).join(', ')} within each of ${docs.length} books`}
    >
      {docs.map((doc, d) => {
        const rowY = d * rowPitch;
        const title = titles[d] ?? doc;
        return (
          <g key={doc}>
            <line x1={0} y1={rowY + geometry.rowHeight} x2={plotW} y2={rowY + geometry.rowHeight} stroke="var(--rule)" strokeWidth={1} />
            {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && ready.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.rawValues,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
              ).map((path, index) => (
                <path
                  key={`raw:${r.intent.id}:${index}`}
                  data-raw-series-path={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={slotColor(r.intent.styleSlot)}
                  strokeWidth={1}
                  strokeDasharray={slotDash(r.intent.styleSlot)}
                  opacity={0.2}
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
              ).map((path, index) => (
                <path
                  key={`${r.intent.id}:${index}`}
                  data-series-path={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={slotColor(r.intent.styleSlot)}
                  strokeWidth={strokeFor(r.intent.id)}
                  strokeDasharray={slotDash(r.intent.styleSlot)}
                  strokeLinecap={slotDash(r.intent.styleSlot) === '1 3' ? 'round' : 'butt'}
                  opacity={selected.length > 0 ? 0.45 : 1}
                />
              )),
            )}
            {selected.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.values,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
              ).map((path, i) => (
                <path
                  key={`selected:${r.intent.id}:${i}`}
                  data-selected-overlay={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={slotColor(r.intent.styleSlot)}
                  strokeWidth={strokeFor(r.intent.id) + 1.5}
                  strokeDasharray={slotDash(r.intent.styleSlot)}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )),
            )}
            {Array.from({ length: trendRowsForDoc(geo, d).count }, (_, b) => {
              const rows = trendRowsForDoc(geo, d);
              const span = trendBinSpan(geo, d, b);
              if (span.end <= span.start) return null;
              const lines = ready
                .map((r) => {
                  const iRow = rows.start + b;
                  const displayed = r.values[iRow];
                  const formatted = displayed !== undefined && Number.isFinite(displayed)
                    ? `${displayed.toFixed(measure.kind === 'count' ? 0 : 1)}${trendMeasureUnit(measure)}`
                    : 'gap';
                  return `${r.intent.label}: ${r.trend.count[iRow]}× (${formatted})`;
                })
                .join('\n');
              return (
                <rect
                  key={b}
                  data-trend-hit-row={d}
                  x={bookXFromTokenEdge(span.start, plotW, geo.docTokenCount[d] ?? 0)}
                  y={rowY}
                  width={Math.max(
                    1,
                    bookXFromTokenEdge(span.end, plotW, geo.docTokenCount[d] ?? 0)
                      - bookXFromTokenEdge(span.start, plotW, geo.docTokenCount[d] ?? 0),
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
      {__TT_E2E__ && <ChartCommitProbe view="by-book" />}
    </svg>
  );
});
