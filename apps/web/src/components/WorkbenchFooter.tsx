/**
 * Global corpus-order reading instrument. Passage, sparkline, progress, and
 * barcode share one declared-sequence token axis. It is absent in Reader and
 * keeps reading position transient.
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
  type ReactNode,
} from 'react';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { occurrenceNavigationText } from '../lib/store.ts';
import {
  advanceFooterShuttle,
  corpusProgress,
  FOOTER_SHUTTLE_DEFAULT_VISIBLE_TOKENS,
  footerBlockSize,
  footerGeometryFor,
  footerShuttleRate,
  footerStatusText,
  nextPassageToken,
  sequenceLayoutFor,
  type FooterGeometry,
  type PassageWindowV1,
} from '../lib/footer-view.ts';
import { trendDisplayValues } from '../lib/trend-display.ts';
import {
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  seriesTokenFromX,
  seriesDocFromGlobal,
  seriesXFromToken,
  seriesXFromTokenEdge,
  stepAlongSequence,
  trendBinSpan,
  type SequenceLayout,
} from '../lib/trend-geometry.ts';
import {
  projectedBarcodeSnapIndexes,
  projectedBarcodeTracks,
} from '../lib/trend-stage.ts';
import {
  barcodeReaderTarget,
  captureBarcodePointerTarget,
  resolveCapturedBarcodeTarget,
  type BarcodeTrackVM,
  type CapturedBarcodeTarget,
} from '../lib/barcode-view.ts';
import { slotColor, slotDash } from '../lib/series-style.ts';
import { usePresentation } from './PresentationProvider.tsx';
import { BarcodeBand } from './BarcodeStrip.tsx';
import { FooterPassage } from './FooterPassage.tsx';
import {
  rootShortcutAllowed,
  shortcutAria,
  shortcutMatches,
} from '../lib/shortcuts.ts';
import { pointerIntentFor, type PointerIntent } from '../lib/pointer-capability.ts';

const BOUNDARY_GAP = 1;
const FOOTER_HOVER_DWELL_MS = 120;
const FOOTER_SHUTTLE_ARIA_INTERVAL_MS = 1_000;

type FooterKeyboardEvent = KeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent;

function nativeEnterTarget(target: EventTarget | null): boolean {
  const element = target as (EventTarget & { closest?: (selector: string) => unknown }) | null;
  return typeof element?.closest === 'function'
    && element.closest('button, a[href], [role="button"], [role="link"]') !== null;
}

function keyboardReturnFocusId(target: EventTarget | null): string {
  const element = target as (EventTarget & { id?: string }) | null;
  return element?.id || 'place-trends-heading';
}

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
  pending,
  failed,
  partial,
  strip,
  containerRef,
  globalShortcuts,
}: {
  readonly docs: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
  readonly layout: SequenceLayout;
  readonly width: number;
  readonly geometry: FooterGeometry;
  readonly tracks: readonly BarcodeTrackVM[];
  readonly trackCount: number;
  readonly pending: boolean;
  readonly failed: number;
  readonly partial: boolean;
  readonly strip: ReactNode;
  readonly containerRef: (element: HTMLDivElement | null) => void;
  readonly globalShortcuts: boolean;
}) {
  const presentation = usePresentation();
  const scrub = useApp((state) => state.scrub);
  const passage = useApp((state) => state.footerPassage);
  const snapshot = useApp((state) => state.snapshot);
  const setScrub = useApp((state) => state.setScrub);
  const setFooterPassageMargin = useApp((state) => state.setFooterPassageMargin);
  const centerKwicAt = useApp((state) => state.centerKwicAt);
  const openReader = useApp((state) => state.openReader);
  const occurrenceNavigation = useApp((state) => state.occurrenceNavigation);
  const series = useApp((state) => state.series);
  const stepOccurrence = useApp((state) => state.stepOccurrence);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const keyHandlerRef = useRef<(event: FooterKeyboardEvent) => void>(() => undefined);
  const docsRef = useRef(docs);
  const layoutRef = useRef(layout);
  docsRef.current = docs;
  layoutRef.current = layout;
  const pointerSample = useRef<{ readonly doc: string; readonly token: number } | null>(null);
  const frame = useRef<number | null>(null);
  const shuttleFrame = useRef<number | null>(null);
  const suppressDoubleClickUntil = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverReady = useRef(false);
  const lastPointerIntent = useRef<PointerIntent>('direct');
  const snapIndexCache = useRef<{
    readonly tracks: readonly BarcodeTrackVM[];
    readonly indexes: ReturnType<typeof projectedBarcodeSnapIndexes>;
  } | null>(null);
  const [visiblePassageTokens, setVisiblePassageTokens] = useState(
    FOOTER_SHUTTLE_DEFAULT_VISIBLE_TOKENS,
  );
  const visiblePassageTokensRef = useRef(visiblePassageTokens);
  visiblePassageTokensRef.current = visiblePassageTokens;
  const [shuttleOffsetPx, setShuttleOffsetPx] = useState<number | null>(null);
  const shuttleRate = shuttleOffsetPx === null
    ? null
    : footerShuttleRate(shuttleOffsetPx, visiblePassageTokens);
  const ariaScrubLatest = useRef(scrub);
  const ariaScrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ariaShuttleActive = useRef(false);
  const [ariaScrub, setAriaScrub] = useState(scrub);
  const passageWindow = useRef<PassageWindowV1 | null>(null);
  const queuedPageDirection = useRef<1 | -1 | null>(null);
  const [keyboardStatus, setKeyboardStatus] = useState('');
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation, series);
  const pointerTap = useRef<{
    readonly pointerId: number;
    readonly pointerType: string;
    readonly x: number;
    readonly y: number;
    readonly barcode: CapturedBarcodeTarget | null;
    readonly anchorTarget: { readonly doc: string; readonly token: number } | null;
    moved: boolean;
    mode: 'tap' | 'shuttle';
    offsetPx: number;
    position: number | null;
    lastFrameAt: number | null;
  } | null>(null);
  const docOrdinal = scrub ? docs.indexOf(scrub.doc) : -1;
  const progress = scrub && docOrdinal >= 0
    ? corpusProgress(layout, docOrdinal, scrub.token)
    : null;
  const crosshairX = progress && scrub && docOrdinal >= 0
    ? seriesXFromToken(docOrdinal, scrub.token, width, layout)
    : null;
  const title = scrub ? titles.get(scrub.doc) ?? scrub.doc : '';
  const announcedScrub = shuttleRate === null ? scrub : (ariaScrub ?? scrub);
  const ariaDocOrdinal = announcedScrub ? docs.indexOf(announcedScrub.doc) : -1;
  const ariaProgress = announcedScrub && ariaDocOrdinal >= 0
    ? corpusProgress(layout, ariaDocOrdinal, announcedScrub.token)
    : null;
  const ariaTitle = announcedScrub
    ? titles.get(announcedScrub.doc) ?? announcedScrub.doc
    : '';
  const baseStatus = footerStatusText(progress && scrub ? {
    compact: presentation.width === 'compact',
    partial,
    docOrdinal,
    docCount: docs.length,
    title,
    token: scrub.token,
    docTokenCount: layout.tokenCounts[docOrdinal] ?? 0,
    percent: progress.percent,
    pending: pending || passage?.state.status === 'pending',
    failed,
  } : null);
  const shuttleStatus = shuttleRate === null
    ? ''
    : Math.abs(shuttleRate) < 0.05
      ? ' · reading paused · drag farther to set pace'
      : ` · reading ${shuttleRate > 0 ? '→' : '←'} ${Math.abs(shuttleRate).toFixed(1)} tokens/s · release to pause`;
  const status = `${baseStatus}${shuttleStatus}${keyboardStatus ? ` · ${keyboardStatus}` : ''}${occurrenceStatus ? ` · ${occurrenceStatus}` : ''}`;
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

  const setAbsoluteScrub = useCallback((target: { readonly doc: string; readonly token: number }) => {
    queuedPageDirection.current = null;
    setKeyboardStatus('');
    setScrub(target);
  }, [setScrub]);

  useEffect(() => {
    passageWindow.current = null;
    queuedPageDirection.current = null;
    setKeyboardStatus('');
  }, [snapshot?.snapshot]);

  useEffect(() => {
    if (occurrenceNavigation?.state.status !== 'ready') return;
    passageWindow.current = null;
    queuedPageDirection.current = null;
    setKeyboardStatus('');
  }, [occurrenceNavigation]);

  const schedule = useCallback((target: { readonly doc: string; readonly token: number }) => {
    pointerSample.current = target;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (pointerSample.current) setAbsoluteScrub(pointerSample.current);
    });
  }, [setAbsoluteScrub]);

  useEffect(() => {
    ariaScrubLatest.current = scrub;
    if (shuttleRate === null) {
      if (ariaScrubTimer.current !== null) {
        clearTimeout(ariaScrubTimer.current);
        ariaScrubTimer.current = null;
      }
      if (ariaShuttleActive.current) setAriaScrub(scrub);
      ariaShuttleActive.current = false;
      return;
    }
    if (!ariaShuttleActive.current) setAriaScrub(scrub);
    ariaShuttleActive.current = true;
    ariaScrubTimer.current ??= setTimeout(() => {
      ariaScrubTimer.current = null;
      setAriaScrub(ariaScrubLatest.current);
    }, FOOTER_SHUTTLE_ARIA_INTERVAL_MS);
  }, [scrub, shuttleRate]);

  const stopShuttle = useCallback(() => {
    if (shuttleFrame.current !== null) {
      cancelAnimationFrame(shuttleFrame.current);
      shuttleFrame.current = null;
    }
    setShuttleOffsetPx(null);
  }, []);

  const runShuttle = useCallback(() => {
    if (shuttleFrame.current !== null) return;
    const tick = (at: number) => {
      shuttleFrame.current = null;
      const tap = pointerTap.current;
      if (!tap || tap.mode !== 'shuttle' || tap.position === null) return;
      const rate = footerShuttleRate(tap.offsetPx, visiblePassageTokensRef.current);
      const firstFrame = tap.lastFrameAt === null;
      const elapsed = firstFrame ? 0 : at - tap.lastFrameAt!;
      tap.lastFrameAt = at;
      const previousPosition = tap.position;
      const next = advanceFooterShuttle(layoutRef.current, tap.position, rate, elapsed);
      if (next) {
        tap.position = next.position;
        const doc = docsRef.current[next.docOrdinal];
        const current = useApp.getState().scrub;
        if (doc && (current?.doc !== doc || current.token !== next.token)) {
          setAbsoluteScrub({ doc, token: next.token });
        }
      }
      if (
        rate !== 0
        && (firstFrame || next?.position !== previousPosition)
        && pointerTap.current?.mode === 'shuttle'
      ) {
        shuttleFrame.current = requestAnimationFrame(tick);
      }
    };
    shuttleFrame.current = requestAnimationFrame(tick);
  }, [setAbsoluteScrub]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (shuttleFrame.current !== null) cancelAnimationFrame(shuttleFrame.current);
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (ariaScrubTimer.current !== null) clearTimeout(ariaScrubTimer.current);
  }, []);
  const attachSlider = useCallback((element: HTMLDivElement | null) => {
    sliderRef.current = element;
    containerRef(element);
  }, [containerRef]);

  const localPoint = (event: MouseEvent<HTMLDivElement>) => {
    const box = sliderRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    return {
      x: Math.max(0, Math.min(box.width - 0.001, event.clientX - box.left)),
      y: event.clientY - box.top,
    };
  };
  const rawTarget = (x: number) => {
    const at = seriesTokenFromX(x, width, layout);
    const doc = at ? docs[at.d] : undefined;
    return at && doc ? { ...at, doc } : null;
  };
  const captureBarcodeAt = (
    x: number,
    y: number,
    allowExactSnap: boolean,
  ): CapturedBarcodeTarget | null => {
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
    let exactIndexes: ReturnType<typeof projectedBarcodeSnapIndexes> = [];
    if (allowExactSnap && track.representation === 'exact') {
      const cached = snapIndexCache.current;
      if (cached?.tracks === tracks) {
        exactIndexes = cached.indexes;
      } else {
        exactIndexes = projectedBarcodeSnapIndexes(tracks);
        snapIndexCache.current = { tracks, indexes: exactIndexes };
      }
    }
    return captureBarcodePointerTarget(
      tracks,
      exactIndexes,
      {
        trackRow: row,
        docOrdinal: target.d,
        doc: target.doc,
        rawToken: target.token,
        px: x,
      },
      (d, token) => seriesXFromTokenEdge(d, token, width, layout),
      allowExactSnap,
    );
  };
  const pointerTargetAt = (
    x: number,
    y: number,
    allowExactSnap: boolean,
  ) => {
    const raw = rawTarget(x);
    if (!raw) return null;
    const captured = captureBarcodeAt(x, y, allowExactSnap);
    const snapped = captured?.exactActivation;
    return snapped ? { ...raw, doc: snapped.doc, token: snapped.token } : raw;
  };
  const observePrecisePointer = (pointerType: string): boolean => {
    const intent = pointerIntentFor(pointerType);
    lastPointerIntent.current = intent;
    return intent === 'precise';
  };

  const advancePassagePage = useCallback((window: PassageWindowV1, direction: 1 | -1) => {
    const live = useApp.getState();
    const current = live.scrub;
    if (
      !current
      || live.snapshot?.snapshot !== window.snapshot
      || current.doc !== window.doc
      || current.token !== window.forToken
    ) return false;
    const currentOrdinal = docsRef.current.indexOf(current.doc);
    if (currentOrdinal < 0) return false;
    const proposal = nextPassageToken(window, direction);
    const next = stepAlongSequence(
      currentOrdinal,
      current.token,
      proposal - current.token,
      layoutRef.current,
    );
    const doc = next ? docsRef.current[next.d] : undefined;
    if (!next || !doc || (doc === current.doc && next.token === current.token)) {
      setKeyboardStatus(direction === 1 ? 'end of corpus' : 'start of corpus');
      return true;
    }
    setKeyboardStatus('');
    setScrub({ doc, token: next.token });
    return true;
  }, [setScrub]);

  const stepPassagePage = useCallback((direction: 1 | -1) => {
    const window = passageWindow.current;
    if (window && advancePassagePage(window, direction)) return;
    if (!useApp.getState().scrub) {
      const seed = seriesDocFromGlobal(
        direction === 1 ? 0 : layoutRef.current.totalTokens - 1,
        layoutRef.current,
      );
      const doc = seed ? docsRef.current[seed.d] : undefined;
      if (seed && doc) setAbsoluteScrub({ doc, token: seed.token });
      return;
    }
    queuedPageDirection.current = direction;
  }, [advancePassagePage, setAbsoluteScrub]);

  const publishPassageWindow = useCallback((window: PassageWindowV1 | null) => {
    passageWindow.current = window;
    const queued = queuedPageDirection.current;
    if (!window || queued === null) return;
    if (advancePassagePage(window, queued)) queuedPageDirection.current = null;
  }, [advancePassagePage]);

  const passageCrosshairX = useCallback((doc: string, token: number) => {
    const ordinal = docsRef.current.indexOf(doc);
    return ordinal >= 0
      ? seriesXFromToken(ordinal, token, width, layoutRef.current)
      : null;
  }, [layout, width]);

  const onKeyDown = (event: FooterKeyboardEvent) => {
    const current = scrub && docOrdinal >= 0
      ? { d: docOrdinal, token: scrub.token }
      : stepAlongSequence(0, 0, 0, layout);
    if (!current) return;
    if (
      shortcutMatches(event, 'footer-occurrence-next')
      || shortcutMatches(event, 'footer-occurrence-previous')
    ) {
      event.preventDefault();
      setKeyboardStatus('');
      stepOccurrence(shortcutMatches(event, 'footer-occurrence-next') ? 1 : -1);
      return;
    }
    const fineDirection = shortcutMatches(event, 'footer-token-previous')
      ? -1
      : shortcutMatches(event, 'footer-token-next')
        ? 1
        : null;
    if (fineDirection !== null) {
      event.preventDefault();
      const next = stepAlongSequence(current.d, current.token, fineDirection, layout);
      const doc = next ? docs[next.d] : undefined;
      if (!next || !doc || (next.d === current.d && next.token === current.token)) {
        setKeyboardStatus(fineDirection === 1 ? 'end of corpus' : 'start of corpus');
      } else {
        setAbsoluteScrub({ doc, token: next.token });
      }
      return;
    }
    if (shortcutMatches(event, 'footer-page-previous')) {
      event.preventDefault();
      stepPassagePage(-1);
      return;
    }
    if (shortcutMatches(event, 'footer-page-next')) {
      event.preventDefault();
      stepPassagePage(1);
      return;
    }
    if (shortcutMatches(event, 'footer-corpus-start')) {
      const next = seriesDocFromGlobal(0, layout);
      const doc = next ? docs[next.d] : undefined;
      event.preventDefault();
      if (next && doc) setAbsoluteScrub({ doc, token: next.token });
      return;
    }
    if (shortcutMatches(event, 'footer-corpus-end')) {
      const next = seriesDocFromGlobal(layout.totalTokens - 1, layout);
      const doc = next ? docs[next.d] : undefined;
      event.preventDefault();
      if (next && doc) setAbsoluteScrub({ doc, token: next.token });
      return;
    }
    if (shortcutMatches(event, 'footer-open-reader')) {
      if (event.repeat || snapshot === null) return;
      event.preventDefault();
      const doc = docs[current.d];
      if (!doc) return;
      openReader({
        snapshot: snapshot.snapshot,
        doc,
        token: current.token,
        from: 'footer',
      }, keyboardReturnFocusId(event.target));
    }
  };
  keyHandlerRef.current = onKeyDown;

  useEffect(() => {
    if (!globalShortcuts) return undefined;
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!rootShortcutAllowed(event)) return;
      const target = event.target as (EventTarget & {
        closest?: (selector: string) => unknown;
      }) | null;
      if (target?.closest?.('[data-shortcut-context="footer"]')) return;
      // Enter remains the native activation key for links and buttons. The
      // Trends scrubber is a div slider, so Enter can still open Reader when
      // no keyboard range is consuming it locally.
      if (event.key === 'Enter' && nativeEnterTarget(event.target)) return;
      keyHandlerRef.current(event);
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [globalShortcuts]);

  return (
    <div
      className="footer-interactive"
      data-shortcut-context="footer"
      onDoubleClick={(event) => {
        if (Date.now() < suppressDoubleClickUntil.current) {
          event.preventDefault();
          return;
        }
        if ((event.target as Element).closest('button, a')) return;
        const point = localPoint(event);
        if (!point || snapshot === null) return;
        const captured = captureBarcodeAt(
          point.x,
          point.y,
          lastPointerIntent.current === 'precise',
        );
        const resolution = captured
          ? resolveCapturedBarcodeTarget(tracks, captured)
          : null;
        const raw = rawTarget(point.x);
        const target = barcodeReaderTarget(resolution, raw);
        if (!target) return;
        event.preventDefault();
        // Preserve the clicked reading position when Back restores the footer;
        // Reader navigation itself intentionally uses the same exact target.
        setAbsoluteScrub({ doc: target.doc, token: target.token });
        if (
          resolution?.kind === 'activation'
          && resolution.activation.kind === 'bucket'
        ) {
          // Supersede the two constituent click activations: the Reader and
          // Concordance should settle on the same honest raw corpus point.
          centerKwicAt(resolution.track.seriesId, target.doc, target.token);
        }
        openReader({
          snapshot: snapshot.snapshot,
          doc: target.doc,
          token: target.token,
          from: 'footer',
        }, 'corpus-footer-position');
      }}
    >
      <FooterPassage
        passage={passage}
        scrub={scrub}
        snapshot={snapshot?.snapshot ?? ''}
        title={title}
        crosshairXForToken={passageCrosshairX}
        coarse={presentation.coarseAvailable}
        widthClass={presentation.width}
        onPassageMarginChange={setFooterPassageMargin}
        onVisibleTokensChange={setVisiblePassageTokens}
        onPassageWindowChange={publishPassageWindow}
      />
      <div className="footer-reading-status" title={status}>{status}</div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {[keyboardStatus, occurrenceStatus].filter(Boolean).join(' · ')}
      </span>
      <div
        id="corpus-footer-position"
        ref={attachSlider}
        className="footer-strip"
        role="slider"
        aria-roledescription="corpus reading position"
        aria-keyshortcuts={shortcutAria([
          'footer-page-previous',
          'footer-page-next',
          'footer-token-previous',
          'footer-token-next',
          'footer-occurrence-previous',
          'footer-occurrence-next',
          'footer-corpus-start',
          'footer-corpus-end',
          'footer-open-reader',
        ])}
        tabIndex={0}
        aria-label="Corpus footer position"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, layout.totalTokens - 1)}
        aria-valuenow={progress?.globalToken ?? 0}
        aria-valuetext={ariaProgress && announcedScrub
          ? `${ariaTitle} · token ${(announcedScrub.token + 1).toLocaleString()} of ${(layout.tokenCounts[ariaDocOrdinal] ?? 0).toLocaleString()} · ${ariaProgress.percent}% of corpus${honestyQualifier ? ` · ${honestyQualifier}` : ''}${shuttleRate === null ? '' : ` · reading ${shuttleRate >= 0 ? 'forward' : 'backward'} at ${Math.abs(shuttleRate).toFixed(1)} tokens per second`}`
          : 'no position'}
        data-shuttling={shuttleRate === null ? undefined : 'true'}
        style={{ height: stripHeight }}
        onKeyDown={onKeyDown}
        onPointerEnter={(event) => {
          if (!observePrecisePointer(event.pointerType)) return;
          hoverReady.current = false;
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
          const point = localPoint(event);
          const target = point ? pointerTargetAt(point.x, point.y, true) : null;
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
          const precise = observePrecisePointer(event.pointerType);
          const tap = pointerTap.current;
          if (tap?.pointerId === event.pointerId) {
            if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= 4) {
              tap.moved = true;
            }
            if (
              tap.moved
              && tap.pointerType === 'mouse'
              && tap.anchorTarget !== null
            ) {
              if (tap.mode === 'tap') {
                tap.mode = 'shuttle';
                const d = docs.indexOf(tap.anchorTarget.doc);
                tap.position = d >= 0
                  ? (layout.bases[d] ?? 0) + tap.anchorTarget.token + 0.5
                  : null;
                tap.lastFrameAt = null;
                pointerSample.current = null;
                if (frame.current !== null) {
                  cancelAnimationFrame(frame.current);
                  frame.current = null;
                }
                setAbsoluteScrub(tap.anchorTarget);
              }
              tap.offsetPx = event.clientX - tap.x;
              setShuttleOffsetPx(tap.offsetPx);
              runShuttle();
              event.preventDefault();
            }
            return;
          }
          if (!precise || event.buttons !== 0) return;
          const point = localPoint(event);
          const target = point
            ? pointerTargetAt(point.x, point.y, true)
            : null;
          if (!target) return;
          const sample = { doc: target.doc, token: target.token };
          if (hoverReady.current) schedule(sample);
          else pointerSample.current = sample;
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          const precise = observePrecisePointer(event.pointerType);
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = localPoint(event);
          pointerTap.current = {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            x: event.clientX,
            y: event.clientY,
            barcode: point && precise
              ? captureBarcodeAt(point.x, point.y, true)
              : null,
            anchorTarget: point ? rawTarget(point.x) : null,
            moved: false,
            mode: 'tap',
            offsetPx: 0,
            position: null,
            lastFrameAt: null,
          };
        }}
        onPointerUp={(event) => {
          const tap = pointerTap.current;
          if (!tap || tap.pointerId !== event.pointerId) return;
          pointerTap.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (tap.mode === 'shuttle') {
            stopShuttle();
            suppressDoubleClickUntil.current = Date.now() + 500;
            event.preventDefault();
            return;
          }
          if (tap.moved) return;
          const resolution = tap.barcode
            ? resolveCapturedBarcodeTarget(tracks, tap.barcode)
            : null;
          if (resolution?.kind === 'activation') {
            const { activation, track } = resolution;
            setAbsoluteScrub({ doc: activation.doc, token: activation.token });
            centerKwicAt(
              track.seriesId,
              activation.doc,
              activation.token,
              activation.kind === 'bucket'
                ? { kind: 'bucket', count: activation.bucketCount ?? 0 }
                : undefined,
            );
            return;
          }
          if (resolution?.kind === 'scrub') {
            setAbsoluteScrub({ doc: resolution.doc, token: resolution.token });
            return;
          }
          const point = localPoint(event);
          if (!point) return;
          const target = rawTarget(point.x);
          if (target) setAbsoluteScrub({ doc: target.doc, token: target.token });
        }}
        onPointerCancel={(event) => {
          if (pointerTap.current?.pointerId === event.pointerId) {
            pointerTap.current = null;
            stopShuttle();
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
        onLostPointerCapture={(event) => {
          if (pointerTap.current?.pointerId === event.pointerId) {
            pointerTap.current = null;
            stopShuttle();
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
    </div>
  );
}

export function WorkbenchFooter({
  globalShortcuts = false,
}: {
  readonly globalShortcuts?: boolean;
}) {
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
  const coarse = presentation.coarseAvailable;
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
        pending={pending}
        failed={failed}
        partial={(snapshot?.missingDocs.length ?? 0) > 0}
        strip={strip}
        containerRef={setContainer}
        globalShortcuts={globalShortcuts}
      />
    </aside>
  );
}
