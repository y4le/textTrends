/**
 * Global corpus-order reading instrument. Passage, sparkline, progress, and
 * barcode share one declared-sequence token axis. It is absent in Reader and
 * never persists excerpts or ranges.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import {
  corpusProgress,
  footerBlockSize,
  footerGeometryFor,
  footerStatusText,
  sequenceLayoutFor,
  type FooterGeometry,
} from '../lib/footer-view.ts';
import { trendDisplayValues } from '../lib/trend-display.ts';
import {
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  seriesTokenFromX,
  seriesXFromToken,
  seriesXFromTokenEdge,
  stepAlongSequence,
  trendBinAtToken,
  trendBinSpan,
  type SequenceLayout,
} from '../lib/trend-geometry.ts';
import {
  projectedBarcodeSnapIndexes,
  projectedBarcodeTracks,
} from '../lib/trend-stage.ts';
import {
  bucketActivationAt,
  snapBarcodeIndex,
  type BarcodeActivation,
  type BarcodeSnapIndex,
  type BarcodeTrackVM,
} from '../lib/barcode-view.ts';
import { slotColor, slotDash } from '../lib/series-style.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { BarcodeBand } from './BarcodeStrip.tsx';
import { FooterPassage } from './FooterPassage.tsx';

const BOUNDARY_GAP = 1;
const FOOTER_HOVER_DWELL_MS = 120;

interface FooterSeries {
  readonly id: string;
  readonly styleSlot: number;
  readonly trend: NumericTrend;
  readonly values: Float64Array;
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
  focusedSeries,
}: {
  readonly series: readonly FooterSeries[];
  readonly docs: readonly string[];
  readonly layout: SequenceLayout;
  readonly width: number;
  readonly geometry: FooterGeometry;
  readonly focusedSeries: string | null;
}) {
  let maxValue = 0;
  for (const item of series) {
    for (const value of item.values) {
      if (Number.isFinite(value)) maxValue = Math.max(maxValue, value);
    }
  }
  const y = linearMap(0, maxValue, geometry.seriesHeight, geometry.topPad);
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
          <path
            key={`${item.id}:${doc}:${index}`}
            d={path}
            fill="none"
            stroke={slotColor(item.styleSlot)}
            strokeWidth={item.id === focusedSeries
              ? geometry.strokeFocused
              : geometry.strokeOther}
            strokeDasharray={slotDash(item.styleSlot)}
            strokeLinecap={slotDash(item.styleSlot) === '1 3' ? 'round' : 'butt'}
            opacity={focusedSeries !== null && item.id !== focusedSeries ? 0.55 : 1}
          />
        ));
      }))}
    </svg>
  );
});

function FooterInteractive({
  docs,
  titles,
  layout,
  width,
  geometry,
  tracks,
  trackCount,
  snapIndexes,
  pending,
  failed,
  partial,
  strip,
  containerRef,
  onFinePointerEnter,
}: {
  readonly docs: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
  readonly layout: SequenceLayout;
  readonly width: number;
  readonly geometry: FooterGeometry;
  readonly tracks: readonly BarcodeTrackVM[];
  readonly trackCount: number;
  readonly snapIndexes: readonly (readonly (BarcodeSnapIndex | null)[])[];
  readonly pending: boolean;
  readonly failed: number;
  readonly partial: boolean;
  readonly strip: ReactNode;
  readonly containerRef: (element: HTMLDivElement | null) => void;
  readonly onFinePointerEnter: () => void;
}) {
  const presentation = usePresentation();
  const scrub = useApp((state) => state.scrub);
  const passage = useApp((state) => state.footerPassage);
  const snapshot = useApp((state) => state.snapshot);
  const setScrub = useApp((state) => state.setScrub);
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const openReader = useApp((state) => state.openReader);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const pointerSample = useRef<{ readonly doc: string; readonly token: number } | null>(null);
  const frame = useRef<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverReady = useRef(false);
  const pointerTap = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null>(null);
  const docOrdinal = scrub ? docs.indexOf(scrub.doc) : -1;
  const progress = scrub && docOrdinal >= 0
    ? corpusProgress(layout, docOrdinal, scrub.token)
    : null;
  const crosshairX = progress && scrub && docOrdinal >= 0
    ? seriesXFromToken(docOrdinal, scrub.token, width, layout)
    : null;
  const title = scrub ? titles.get(scrub.doc) ?? scrub.doc : '';
  const status = footerStatusText(progress && scrub ? {
    compact: presentation.width === 'compact',
    partial,
    docOrdinal,
    docCount: docs.length,
    title,
    token: scrub.token,
    docTokenCount: layout.tokenCounts[docOrdinal] ?? 0,
    percent: progress.percent,
    pending,
    failed,
  } : null);
  const honestyQualifier = [
    partial ? 'partial corpus' : '',
    pending ? 'computing' : failed > 0
      ? `${failed} ${failed === 1 ? 'query failed' : 'queries failed'}`
      : '',
  ].filter(Boolean).join(' · ');
  const stripVisualHeight = geometry.seriesHeight
    + (trackCount > 0
      ? geometry.barcodeBandGap
        + trackCount * (geometry.barcodeTrackHeight + geometry.barcodeTrackGap)
      : 0);
  const stripHeight = Math.max(geometry.stripMinHeight, stripVisualHeight);
  const stripTop = stripHeight - stripVisualHeight;

  const schedule = useCallback((target: { readonly doc: string; readonly token: number }) => {
    pointerSample.current = target;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (pointerSample.current) setScrub(pointerSample.current);
    });
  }, [setScrub]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
  }, []);
  const attachSlider = useCallback((element: HTMLDivElement | null) => {
    sliderRef.current = element;
    containerRef(element);
  }, [containerRef]);

  const localPoint = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    const box = sliderRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    return {
      x: Math.max(0, Math.min(box.width - 0.001, event.clientX - box.left)),
      y: Math.max(0, event.clientY - box.top),
    };
  };
  const rawTarget = (x: number) => {
    const at = seriesTokenFromX(x, width, layout);
    const doc = at ? docs[at.d] : undefined;
    return at && doc ? { ...at, doc } : null;
  };
  const activationAt = (x: number, y: number): {
    readonly track: BarcodeTrackVM;
    readonly activation: BarcodeActivation;
  } | null => {
    const barcodeY = y - stripTop - geometry.seriesHeight - geometry.barcodeBandGap;
    const stride = geometry.barcodeTrackHeight + geometry.barcodeTrackGap;
    const row = stride > 0 ? Math.floor(barcodeY / stride) : -1;
    const rowOffset = stride > 0 ? barcodeY - row * stride : -1;
    const target = rawTarget(x);
    const track = row >= 0 ? tracks[row] : undefined;
    if (
      !target
      || !track
      || barcodeY < 0
      || rowOffset < 0
      || rowOffset >= geometry.barcodeTrackHeight
    ) return null;
    const exactIndexes = track.representation === 'exact' && snapIndexes.length === 0
      ? projectedBarcodeSnapIndexes(tracks)
      : snapIndexes;
    const activation = track.representation === 'exact'
      ? snapBarcodeIndex(exactIndexes[row]?.[target.d] ?? null, x, (d, token) =>
          seriesXFromTokenEdge(d, token, width, layout))
      : bucketActivationAt(track, target.doc, target.token);
    return activation ? { track, activation } : null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const current = scrub && docOrdinal >= 0
      ? { d: docOrdinal, token: scrub.token }
      : stepAlongSequence(0, 0, 0, layout);
    if (!current) return;
    let next: { readonly d: number; readonly token: number } | null = null;
    switch (event.key) {
      case 'ArrowLeft': next = stepAlongSequence(current.d, current.token, event.shiftKey ? -5 : -1, layout); break;
      case 'ArrowRight': next = stepAlongSequence(current.d, current.token, event.shiftKey ? 5 : 1, layout); break;
      case 'PageUp': {
        const ready = [...useApp.getState().trends.values()]
          .find((state) => state.status === 'ready');
        const bin = ready?.status === 'ready'
          ? trendBinAtToken(ready.trend, current.d, current.token)
          : null;
        next = stepAlongSequence(current.d, current.token, -Math.max(1, bin ? bin.span.end - bin.span.start : 1), layout);
        break;
      }
      case 'PageDown': {
        const ready = [...useApp.getState().trends.values()]
          .find((state) => state.status === 'ready');
        const bin = ready?.status === 'ready'
          ? trendBinAtToken(ready.trend, current.d, current.token)
          : null;
        next = stepAlongSequence(current.d, current.token, Math.max(1, bin ? bin.span.end - bin.span.start : 1), layout);
        break;
      }
      case 'Home': next = { d: current.d, token: 0 }; break;
      case 'End': next = { d: current.d, token: Math.max(0, (layout.tokenCounts[current.d] ?? 1) - 1) }; break;
      default: return;
    }
    event.preventDefault();
    const doc = next ? docs[next.d] : undefined;
    if (next && doc) setScrub({ doc, token: next.token });
  };

  return (
    <>
      <FooterPassage
        passage={passage}
        scrub={scrub}
        snapshot={snapshot?.snapshot ?? ''}
        title={title}
        crosshairX={crosshairX}
        coarse={presentation.pointer === 'coarse'}
        widthClass={presentation.width}
      />
      <div className="footer-reading-status" title={status}>{status}</div>
      <div
        id="corpus-footer-position"
        ref={attachSlider}
        className="footer-strip"
        role="slider"
        tabIndex={0}
        aria-label="Corpus footer position"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, layout.totalTokens - 1)}
        aria-valuenow={progress?.globalToken ?? 0}
        aria-valuetext={progress && scrub
          ? `${title} · token ${(scrub.token + 1).toLocaleString()} of ${(layout.tokenCounts[docOrdinal] ?? 0).toLocaleString()} · ${progress.percent}% of corpus${honestyQualifier ? ` · ${honestyQualifier}` : ''}`
          : 'no position'}
        style={{ height: stripHeight }}
        onKeyDown={onKeyDown}
        onDoubleClick={(event) => {
          const point = localPoint(event);
          if (
            !point
            || point.y < stripTop
            || point.y >= stripTop + geometry.seriesHeight
            || snapshot === null
          ) return;
          const target = rawTarget(point.x);
          if (!target) return;
          event.preventDefault();
          setScrub({ doc: target.doc, token: target.token });
          openReader({
            snapshot: snapshot.snapshot,
            doc: target.doc,
            token: target.token,
            from: 'footer',
          }, 'corpus-footer-position');
        }}
        onPointerEnter={(event) => {
          if (presentation.pointer === 'coarse' || event.pointerType !== 'mouse') return;
          onFinePointerEnter();
          hoverReady.current = false;
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
          const point = localPoint(event);
          const target = point ? rawTarget(point.x) : null;
          pointerSample.current = target ? { doc: target.doc, token: target.token } : null;
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null;
            hoverReady.current = true;
            if (pointerSample.current) schedule(pointerSample.current);
          }, FOOTER_HOVER_DWELL_MS);
        }}
        onPointerLeave={() => {
          hoverReady.current = false;
          pointerSample.current = null;
          if (hoverTimer.current !== null) {
            clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }
          if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
            frame.current = null;
          }
        }}
        onPointerMove={(event) => {
          const tap = pointerTap.current;
          if (tap?.pointerId === event.pointerId) {
            if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= 4) {
              tap.moved = true;
            }
            return;
          }
          if (presentation.pointer === 'coarse' || event.buttons !== 0) return;
          const point = localPoint(event);
          const target = point ? rawTarget(point.x) : null;
          if (!target) return;
          const sample = { doc: target.doc, token: target.token };
          if (hoverReady.current) schedule(sample);
          else pointerSample.current = sample;
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerTap.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
        }}
        onPointerUp={(event) => {
          const tap = pointerTap.current;
          if (!tap || tap.pointerId !== event.pointerId) return;
          pointerTap.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (tap.moved) return;
          const point = localPoint(event);
          if (!point) return;
          const activation = presentation.pointer !== 'coarse'
            && event.pointerType === 'mouse'
            ? activationAt(point.x, point.y)
            : null;
          if (activation) {
            setScrub({ doc: activation.activation.doc, token: activation.activation.token });
            centerKwicAt(
              activation.track.seriesId,
              activation.activation.doc,
              activation.activation.token,
              activation.activation.kind === 'bucket'
                ? { kind: 'bucket', count: activation.activation.bucketCount ?? 0 }
                : undefined,
            );
            return;
          }
          const target = rawTarget(point.x);
          if (target) setScrub({ doc: target.doc, token: target.token });
        }}
        onPointerCancel={(event) => {
          if (pointerTap.current?.pointerId === event.pointerId) {
            pointerTap.current = null;
          }
          hoverReady.current = false;
          pointerSample.current = null;
          if (hoverTimer.current !== null) {
            clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }
          if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
            frame.current = null;
          }
        }}
      >
        {strip}
        <div
          className="footer-progress-track"
          aria-hidden="true"
          style={{ top: stripTop }}
        >
          <div
            data-testid="footer-progress"
            data-progress={progress?.percent ?? 0}
            className="footer-progress-fill"
            style={{ transform: `scaleX(${progress?.ratio ?? 0})` }}
          />
        </div>
        {crosshairX !== null && (
          <div
            data-testid="footer-cursor"
            className="footer-cursor"
            aria-hidden="true"
            style={{
              top: stripTop,
              height: stripVisualHeight,
              transform: `translate3d(${crosshairX}px, 0, 0)`,
            }}
          />
        )}
      </div>
    </>
  );
}

export function WorkbenchFooter() {
  const presentation = usePresentation();
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const series = useApp((state) => state.series);
  const trends = useApp((state) => state.trends);
  const dispersion = useApp((state) => state.dispersion);
  const selectedDispersion = useApp((state) => state.selectedDispersion);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const focusedSeries = useApp((state) => state.focusedSeries);
  const measure = useApp((state) => state.trendMeasure);
  const coarse = presentation.pointer === 'coarse';
  const geometry = footerGeometryFor(presentation.width, coarse);
  const docs = snapshot?.readyDocs ?? [];
  const firstReady = [...trends.values()].find((state) => state.status === 'ready');
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
  const seriesOrder = useMemo(() => series.map((item) => item.id), [series]);
  const tracks = projectedBarcodeTracks(
    dispersion?.state.status === 'ready' ? dispersion.state.result : null,
    docs,
    seriesOrder,
  );
  const selectedDocs = linkedSelection?.ranges.map((range) => range.doc) ?? [];
  const selectedTracks = projectedBarcodeTracks(
    selectedDispersion?.state.status === 'ready' ? selectedDispersion.state.result : null,
    selectedDocs,
    seriesOrder,
  );
  const reservedTrackCount = series.length === 0 ? 0 : Math.max(series.length, tracks.length);
  const barcodeHeight = reservedTrackCount
    * (geometry.barcodeTrackHeight + geometry.barcodeTrackGap);
  const visible = snapshot !== null && docs.length > 0 && layout.totalTokens > 0;
  const blockSize = visible ? footerBlockSize(geometry, reservedTrackCount) : 0;
  useLayoutEffect(() => {
    if (!visible) {
      document.documentElement.style.removeProperty('--footer-block-size');
      return undefined;
    }
    document.documentElement.style.setProperty('--footer-block-size', `${blockSize}px`);
    return () => {
      document.documentElement.style.removeProperty('--footer-block-size');
    };
  }, [blockSize, visible]);
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
  const readySeries = useMemo<FooterSeries[]>(() => {
    if (series.some((item) => trends.get(item.id)?.status === 'pending')) return [];
    return series.flatMap((item) => {
      const state = trends.get(item.id);
      return state?.status === 'ready'
        ? [{
            id: item.id,
            styleSlot: item.styleSlot,
            trend: state.trend,
            values: trendDisplayValues(state.trend, measure),
          }]
        : [];
    });
  }, [measure, series, trends]);
  const pending = series.some((item) => {
    const state = trends.get(item.id);
    return !state || state.status === 'pending';
  });
  const failed = series.filter((item) => trends.get(item.id)?.status === 'error').length;
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const [snapArmed, setSnapArmed] = useState(false);
  const snapIndexes = !coarse && snapArmed
    ? projectedBarcodeSnapIndexes(tracks)
    : [];
  const enableSnap = useCallback(() => setSnapArmed(true), []);

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
          + (reservedTrackCount > 0 ? geometry.barcodeBandGap + barcodeHeight : 0),
      }}
    >
      <FooterSparkline
        series={readySeries}
        docs={docs}
        layout={layout}
        width={width}
        geometry={geometry}
        focusedSeries={focusedSeries}
      />
      {tracks.length > 0 && (
        <BarcodeBand
          view="series"
          docs={docs}
          tracks={tracks}
          selectedTracks={selectedTracks}
          linkedSelection={linkedSelection !== null}
          edgeX={edgeX}
          width={width}
          plotHeight={geometry.seriesHeight}
          rowPitch={0}
          bandGap={geometry.barcodeBandGap}
          trackHeight={geometry.barcodeTrackHeight}
          trackGap={geometry.barcodeTrackGap}
          slotOf={(id) => series.find((item) => item.id === id)?.styleSlot ?? 0}
          focusedSeries={focusedSeries}
          coarse={coarse}
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
        tracks={tracks}
        trackCount={reservedTrackCount}
        snapIndexes={snapIndexes}
        pending={pending}
        failed={failed}
        partial={(snapshot?.missingDocs.length ?? 0) > 0}
        strip={strip}
        containerRef={setContainer}
        onFinePointerEnter={enableSnap}
      />
    </aside>
  );
}
