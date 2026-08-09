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
 * is color + dash + chips/direct labels — never color alone. The plot holds
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
  spreadLabels,
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
import {
  armRange,
  cancelRange,
  commitRangeDraft,
  draftRanges,
  moveRangeHandle,
  setRangeEnd,
  stepRangeHandle,
  type RangeDraft,
  type RangeHandle,
} from '../lib/range-mode.ts';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';
import { trendGeometryFor, type TrendGeometry } from '../lib/trend-compact.ts';
import {
  trendDisplayValues,
  trendMeasureUnit,
  trendRawValues,
} from '../lib/trend-display.ts';
import { trendStageGeometry, trendStageProjection, trendStageSnapIndexes } from '../lib/trend-stage.ts';

const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
const MIN_LABEL_GAP = 12;

interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
}

interface DisplayedSeries extends ReadySeries {
  readonly values: Float64Array;
  readonly rawValues: Float64Array;
}

interface RangePreview {
  readonly mode: 'pointer' | 'keyboard';
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
  // hover rect, label, and totals row. The ScrubSurface child owns the
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
  const trendBins = useApp((s) => s.trendBins);
  const trendMeasure = useApp((s) => s.trendMeasure);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const pushLayer = useApp((s) => s.pushLayer);
  const replaceLayer = useApp((s) => s.replaceLayer);
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
      // The plot and its direct-label rail must fit their measured owner.
      // Compact geometry gets richer in Stage 3, but the foundation must not
      // impose a desktop minimum that makes the page itself pan horizontally.
      const next = Math.max(1, Math.round(width) - geometry.labelSpace);
      setPlotW((prev) => (prev === next ? prev : next));
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl, geometry]);

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
  const snapIndexes = useMemo(
    // Branch before calling the allocator: exact tracks can contain 250k
    // occurrences, and coarse pointers never consume pixel snapping.
    () => stageProjection && presentation.pointer !== 'coarse'
      ? trendStageSnapIndexes(stageProjection)
      : [],
    [presentation.pointer, stageProjection],
  );
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
  ) => captureBarcodePointerTarget(
    tracks,
    snapIndexes,
    sample,
    edgeX,
    allowExactSnap && presentation.pointer !== 'coarse',
  );
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

  const binLine = trendBins.mode === 'per-doc'
    ? `${trendBins.count} equal bins per book`
    : `${trendBins.count.toLocaleString()} tokens per bin`;
  const smoothingLine = trendMeasure.kind === 'rate' && trendMeasure.smoothing !== 0
    ? `${trendMeasure.smoothing}-bin rolling mean${trendMeasure.showRaw ? ' · raw behind' : ''}`
    : 'unsmoothed';
  const methodLine = `${trendMeasure.kind === 'count' ? 'counts' : `rate per ${trendMeasure.denominator.toLocaleString()} tokens`} · ${binLine} · ${smoothingLine} · books token-proportional in declared order`;
  const openSettings = () => {
    const top = useApp.getState().layers.at(-1);
    if (top?.kind === 'sheet') {
      replaceLayer('sheet', Object.freeze({ surface: 'method' }), 'trend-settings-open', { detent: 'tall' });
    } else {
      pushLayer('sheet', Object.freeze({ surface: 'method' }), 'trend-settings-open', { detent: 'tall' });
    }
  };

  return (
    <section>
      <p
        style={{
          fontSize: presentation.width === 'compact' ? 'var(--text-sm)' : 'var(--text-xs)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 400,
          color: 'var(--fg-muted)',
          margin: '0 0 var(--space-2)',
        }}
      >
        {methodLine}
        {' · '}
        <button
          id="trend-settings-open"
          type="button"
          className="method-inline-action"
          onClick={openSettings}
        >
          settings
        </button>
        {failed.length > 0 && (
          <span style={{ color: 'var(--accent-text)' }}>
            {' '}· failed: {failed.map(failureText).join(' · ')}
          </span>
        )}
      </p>
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
            coarse={presentation.pointer === 'coarse'}
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
        axisLabel={trendView === 'series' ? 'occurrences' : 'occurrences · within each book'}
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
  const [preview, setPreview] = useState<RangePreview | null>(null);
  const [rangeDraft, setRangeDraft] = useState<RangeDraft | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);

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
      if (range.mode === 'pointer') setPreview(null);
      return;
    }
    setLinkedSelection(selection);
    setPreview(null);
  };

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
    if (e.key === 'Escape' && rangeDraft !== null) {
      e.preventDefault();
      setRangeDraft(cancelRange());
      return;
    }
    if (
      (e.key === 's' || e.key === 'S')
      && preview === null
      && rangeDraft === null
    ) {
      if (scrub && scrubDocOrdinal >= 0) {
        e.preventDefault();
        setPreview({ mode: 'keyboard', origin: scrub, head: scrub });
      }
      return;
    }
    if (preview?.mode === 'keyboard') {
      const d = docs.indexOf(preview.head.doc);
      const count = docTokenCount[d] ?? 0;
      let head: ScrubTarget = preview.head;
      switch (e.key) {
        case 'ArrowLeft': {
          const next = stepAlongSequence(d, preview.head.token, -1, layout);
          head = next ? { doc: docs[next.d]!, token: next.token } : preview.head;
          break;
        }
        case 'ArrowRight': {
          const next = stepAlongSequence(d, preview.head.token, 1, layout);
          head = next ? { doc: docs[next.d]!, token: next.token } : preview.head;
          break;
        }
        case 'Home': head = { doc: preview.head.doc, token: 0 }; break;
        case 'End': head = { doc: preview.head.doc, token: Math.max(0, count - 1) }; break;
        case 'Enter':
          e.preventDefault();
          commitPreview(preview);
          return;
        case 'Escape':
          e.preventDefault();
          setPreview(null);
          return;
        default: return;
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
    switch (e.key) {
      case 'ArrowLeft': next = step(e.shiftKey ? -5 : -1); break;
      case 'ArrowRight': next = step(e.shiftKey ? 5 : 1); break;
      case 'PageUp': next = step(-binWidth); break;
      case 'PageDown': next = step(binWidth); break;
      case 'Home': next = { doc: current.doc, token: 0 }; break;
      case 'End': next = { doc: current.doc, token: Math.max(0, tc - 1) }; break;
      default: return;
    }
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
    : rangeDraft
      ? draftRanges(rangeDraft, docs, docTokenCount)
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
  const rangeStatus = preview
    ? `Selecting ${describeRanges(shownRanges)}`
    : rangeDraft
      ? `Range draft in ${describeRanges(shownRanges)}`
    : linkedSelection
      ? linkedSelection.ranges.length === 1
        ? `Selected ${selectionTokenCount(linkedSelection).toLocaleString()} tokens in ${titleByDoc.get(linkedSelection.ranges[0]!.doc) ?? linkedSelection.ranges[0]!.doc}`
        : `Selected ${describeRanges(linkedSelection.ranges)}`
      : 'Press S at the reading cursor to select a range';

  const pointX = (point: ScrubTarget): number | null => {
    const d = docs.indexOf(point.doc);
    if (d < 0) return null;
    return trendView === 'series'
      ? seriesXFromToken(d, point.token, plotW, layout)
      : bookXFromToken(point.token, plotW, docTokenCount[d] ?? 0);
  };

  const rangeHandlePosition = rangeDraft
    ? Object.fromEntries((['start', 'end'] as const).map((handle) => {
        const point = rangeDraft[handle];
        const ordinal = docs.indexOf(point.doc);
        return [handle, {
          x: pointX(point),
          top: trendView === 'series' ? geometry.topPad : ordinal * rowPitch,
          height: trendView === 'series'
            ? geometry.seriesHeight + bandExtent - geometry.topPad
            : geometry.rowHeight + bandExtent,
        }];
      })) as Record<RangeHandle, { x: number | null; top: number; height: number }>
    : null;

  const useRangeDraft = () => {
    if (!rangeDraft || !snapshot) return;
    const selection = commitRangeDraft(
      snapshot.snapshot,
      rangeDraft,
      docs,
      docTokenCount,
    );
    if (!selection) return;
    setLinkedSelection(selection);
    setRangeDraft(null);
  };

  const pointerTap = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly origin: StagePointerTarget;
    readonly pointerType: string;
    moved: boolean;
  } | null>(null);
  const rangeHandleDrag = useRef<{
    readonly pointerId: number;
    readonly handle: RangeHandle;
  } | null>(null);

  const moveDraftHandleFromPointer = (
    handle: RangeHandle,
    clientX: number,
    clientY: number,
  ) => {
    const slider = sliderRef.current;
    if (!slider) return;
    const rect = slider.getBoundingClientRect();
    const target = targetFromPointer(clientX - rect.left, clientY - rect.top, false);
    if (!target) return;
    setRangeDraft((draft) => draft
      ? moveRangeHandle(draft, handle, target)
      : draft);
  };

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div
        ref={sliderRef}
        className="trend-scrubber"
        role="slider"
        id="reading-position-scrubber"
        tabIndex={0}
        aria-label="Reading position scrubber"
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
        onDoubleClick={(event) => {
          event.preventDefault();
          setPreview(null);
          setRangeDraft(null);
          setLinkedSelection(null);
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          const target = targetFromPointer(px, py);
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
          const origin = targetFromPointer(
            e.clientX - rect.left,
            e.clientY - rect.top,
            rangeDraft === null,
          );
          if (!origin) return;
          if (origin.zone === 'barcode' || e.pointerType !== 'mouse' || rangeDraft !== null) {
            if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
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
          const tap = pointerTap.current;
          if (tap?.pointerId === e.pointerId) {
            pointerTap.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            if (!tap.moved) {
              if (
                tap.origin.zone === 'barcode'
                && tap.pointerType === 'mouse'
                && rangeDraft === null
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
                setRangeDraft((draft) => draft
                  ? setRangeEnd(draft, tap.origin)
                  : draft);
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
          if (pointerTap.current?.pointerId === e.pointerId) {
            pointerTap.current = null;
          }
          if (pointerDrag.current?.pointerId !== e.pointerId) return;
          pointerDrag.current = null;
          setPreview(null);
        }}
      >
        {children}
        {barcodeBand}
        {rangeDraft && rangeBoxes.length > 0 && rangeHandlePosition && (
          <>
            {(['start', 'end'] as const).map((handle) => {
              if (
                rangeDraft.start.doc === rangeDraft.end.doc
                && rangeDraft.start.token === rangeDraft.end.token
                && handle === 'start'
              ) {
                return null;
              }
              const position = rangeHandlePosition[handle];
              const x = position.x;
              if (x === null) return null;
              return (
                <span
                  key={handle}
                  className="range-handle"
                  data-range-handle={handle}
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    rangeHandleDrag.current = {
                      pointerId: event.pointerId,
                      handle,
                    };
                  }}
                  onPointerMove={(event) => {
                    if (rangeHandleDrag.current?.pointerId !== event.pointerId) return;
                    event.stopPropagation();
                    moveDraftHandleFromPointer(handle, event.clientX, event.clientY);
                  }}
                  onPointerUp={(event) => {
                    if (rangeHandleDrag.current?.pointerId !== event.pointerId) return;
                    event.stopPropagation();
                    rangeHandleDrag.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (rangeHandleDrag.current?.pointerId === event.pointerId) {
                      rangeHandleDrag.current = null;
                    }
                  }}
                  style={{
                    position: 'absolute',
                    left: Math.max(0, Math.min(plotW - 44, x - 22)),
                    top: Math.max(0, position.top + position.height / 2 - 22),
                    zIndex: 4,
                    inlineSize: 44,
                    blockSize: 44,
                    border: '1px solid var(--accent-text)',
                    background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
                    color: 'var(--fg)',
                    cursor: 'ew-resize',
                    touchAction: 'none',
                  }}
                >
                  {handle === 'start' ? '◀' : '▶'}
                </span>
              );
            })}
          </>
        )}
        {rangeBoxes.map((rangeBox, index) => (
          <div
            key={`${rangeBox.left}:${rangeBox.top}:${rangeBox.right}`}
            aria-hidden="true"
            data-range-selection-segment="true"
            data-testid={index === 0
              ? preview
                ? 'selection-preview'
                : rangeDraft
                  ? 'range-draft'
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
      <p
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-muted)',
          minHeight: '3.2em',
          margin: 'var(--space-2) 0 0',
        }}
      >
        {scrub
          ? 'arrows step by token, shift+arrows by 5, PageUp/Down by bin · press S to select a range'
          : 'hover or focus the chart to set the reading position — arrows step by token, shift+arrows by 5, PageUp/Down by bin · press S to select a range'}
      </p>
      <p
        role="status"
        aria-live="polite"
        style={{
          margin: 'var(--space-1) 0 0',
          minHeight: '1.5em',
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
        }}
      >
        {rangeStatus}
        {preview?.mode === 'keyboard' ? ' · arrows extend · Enter commits · Escape cancels' : ''}
        {linkedSelection && preview === null ? (
          <>
            {' · '}
            <button
              type="button"
              onClick={() => setLinkedSelection(null)}
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
      {scrub && preview === null && rangeDraft === null && (
        <button
          className="coarse-target"
          type="button"
          onClick={() => setRangeDraft(armRange(scrub))}
          style={SMALL_BUTTON_STYLE}
        >
          select range
        </button>
      )}
      {rangeDraft && (
        <div
          role="group"
          aria-label="Range selection controls"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-1)',
          }}
        >
          {(['start', 'end'] as const).flatMap((handle) =>
            ([-1, 1] as const).map((delta) => (
              <button
                key={`${handle}:${delta}`}
                className="coarse-target"
                type="button"
                aria-label={`Move range ${handle} ${delta < 0 ? 'back' : 'forward'} one token`}
                onClick={() => {
                  setRangeDraft(stepRangeHandle(
                    rangeDraft,
                    handle,
                    delta,
                    docs,
                    docTokenCount,
                  ));
                }}
                style={SMALL_BUTTON_STYLE}
              >
                {handle} {delta < 0 ? '−' : '+'}
              </button>
            )))}
          <button
            className="coarse-target"
            type="button"
            onClick={() => setRangeDraft(cancelRange())}
            style={SMALL_BUTTON_STYLE}
          >
            cancel
          </button>
          <button
            className="coarse-target"
            type="button"
            onClick={useRangeDraft}
            style={SMALL_BUTTON_STYLE}
          >
            use range
          </button>
        </div>
      )}
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

  const endPoints = ready.map((r) => {
    for (let d = docs.length - 1; d >= 0; d--) {
      const rows = trendRowsForDoc(r.trend, d);
      for (let row = rows.end - 1; row >= rows.start; row--) {
        const value = r.values[row];
        if (value !== undefined && Number.isFinite(value)) return y(value);
      }
    }
    return y(0);
  });
  const labelY = spreadLabels(
    endPoints,
    geometry.topPad + 4,
    geometry.seriesHeight - 2,
    MIN_LABEL_GAP,
  );

  return (
    <svg
      data-trend-view="series"
      width={plotW + geometry.labelSpace}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${ready.map((r) => r.intent.label).join(', ')} across ${docs.length} books in reading order`}
    >
      <line x1={0} y1={axisY} x2={plotW} y2={axisY} stroke="var(--rule-strong)" strokeWidth={1} />
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
      {/* Direct end labels, collision-spread, foreground text + colored leader */}
      {geometry.directLabels && ready.map((r, i) => (
        <g key={`label-${r.intent.id}`}>
          <line
            x1={plotW + 2}
            y1={endPoints[i]!}
            x2={plotW + 14}
            y2={labelY[i]!}
            stroke={slotColor(r.intent.styleSlot)}
            strokeWidth={1}
            strokeDasharray={slotDash(r.intent.styleSlot)}
          />
          <text
            x={plotW + 18}
            y={labelY[i]! + 3}
            fill="var(--fg)"
            fontSize="var(--text-xs)"
            fontFamily="var(--font-mono)"
          >
            {r.intent.label}
          </text>
        </g>
      ))}
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
      width={plotW + geometry.labelSpace}
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
            {geometry.directLabels && (
              <text
                x={plotW + 6}
                y={rowY + geometry.rowHeight - 2}
                fill="var(--fg)"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-mono)"
              >
                {`${d + 1} · `}{title.slice(0, 16)}
                <title>{title}</title>
              </text>
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
