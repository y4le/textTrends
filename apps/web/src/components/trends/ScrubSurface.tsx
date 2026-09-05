import { useCallback, useEffect, useRef, useState } from 'react';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../../lib/store-instance.ts';
import {
  resolveCapturedBarcodeTarget,
  type BarcodeActivation,
  type BarcodeTrackVM,
} from '../../lib/barcode-view.ts';
import {
  bookTokenFromX,
  bookXFromToken,
  bookXFromTokenEdge,
  barcodeBandExtent,
  seriesXFromToken,
  seriesXFromTokenEdge,
  seriesTokenFromX,
  stepAlongSequence,
  trendBinAtToken,
  trendStageDocument,
  trendStageHit,
  type SequenceLayout,
  type TrendLabelBand,
  type TrendStagePointerIntent,
  type TrendStageSpec,
} from '../../lib/trend-geometry.ts';
import type { ScrubTarget, SeriesIntent } from '../../lib/app-state.ts';
import { nextTrendView, trendViewAccessibleName, type TrendView } from '../../lib/trend-view.ts';
import { commitRange, selectionTokenCount, type TokenRangeSelectionSpanV1 } from '../../lib/selection.ts';
import { type TrendGeometry } from '../../lib/trend-compact.ts';
import { shortcutAria, shortcutMatches } from '../../lib/shortcuts.ts';
import { pointerIntentFor } from '../../lib/pointer-capability.ts';
import { guideAnchorProps } from '../../lib/guide/anchors.ts';
import { occurrenceActivationProps } from '../../lib/guide/activation.ts';
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
} from '../../lib/touch-range-gesture.ts';
import {
  idleTrendDoubleTap,
  trendDoubleTapCancel,
  trendDoubleTapDown,
  trendDoubleTapMove,
  trendDoubleTapUp,
  type TrendDoubleTapState,
} from '../../lib/trend-double-tap.ts';
import { RANGE_CLEAR_SUPPRESSION_MS, rangeClearDecision } from '../../lib/range-clear-gesture.ts';
import {
  idleTrendTitleGesture,
  nextTrendTitleFocus,
  resetTrendTitleGesture,
  trendTitleDown,
  trendTitleMove,
  trendTitleUp,
  type TrendTitleEffect,
  type TrendTitleGesture,
} from '../../lib/trend-title-gesture.ts';
import type { CaptureBarcodePointer } from '../../lib/trend-surface.ts';

const TREND_TITLE_ARIA_KEYS = shortcutAria([
  'trend-title-previous',
  'trend-title-next',
  'trend-title-first',
  'trend-title-last',
  'trend-title-select',
  'trend-title-extend',
]);

interface RangePreview {
  readonly mode: 'pointer' | 'touch' | 'touch-anchor' | 'keyboard' | 'handle' | 'title';
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
export function ScrubSurface({
  containerRef,
  trendView,
  docs,
  titleByDoc,
  layout,
  trend,
  plotW,
  series,
  geometry,
  barcodeHeight,
  barcodeVisible,
  barcodeInteractive,
  rowPitch,
  rowDomain,
  labelBands,
  barcodeTracks,
  captureBarcode,
  hitSpec,
  coarse,
  onBarcodeActivate,
  barcodeBand,
  children,
}: {
  containerRef: (el: HTMLDivElement | null) => void;
  trendView: TrendView;
  docs: readonly string[];
  titleByDoc: ReadonlyMap<string, string>;
  layout: SequenceLayout;
  trend: NumericTrend;
  plotW: number;
  series: readonly SeriesIntent[];
  geometry: TrendGeometry;
  barcodeHeight: number;
  barcodeVisible: boolean;
  barcodeInteractive: boolean;
  rowPitch: number;
  rowDomain: readonly number[];
  labelBands: readonly TrendLabelBand[];
  barcodeTracks: readonly BarcodeTrackVM[];
  captureBarcode: CaptureBarcodePointer;
  hitSpec: TrendStageSpec;
  coarse: boolean;
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
  const activeTextCount = useApp(
    (s) => s.projectSession?.project.data.order.length ?? 0,
  );
  const [preview, setPreview] = useState<RangePreview | null>(null);
  const [rangeAnnouncement, setRangeAnnouncement] = useState('');
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const touchGesture = useRef<TouchRangeGesture>(beginTouchRangeGesture());
  const trendDoubleTap = useRef<TrendDoubleTapState>(idleTrendDoubleTap());
  const touchHoldTimer = useRef<{
    readonly pointerId: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const releasedTouchPointers = useRef(new Set<number>());
  const suppressDoubleClickUntil = useRef(0);
  const lastDirectPointerAt = useRef(0);
  const rangeHandleDrag = useRef<{
    readonly pointerId: number;
    readonly edge: 'start' | 'end';
    readonly fixed: ScrubTarget;
    head: ScrubTarget;
    moved: boolean;
  } | null>(null);
  const titleGesture = useRef<TrendTitleGesture>(idleTrendTitleGesture());
  const titleKeyboardAnchor = useRef<number | null>(null);
  const titleControlRefs = useRef(new Map<number, HTMLButtonElement>());
  const [titleFocusOrdinal, setTitleFocusOrdinal] = useState(() =>
    layout.tokenCounts.findIndex((count) => count > 0));

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
        : bookXFromToken(scrub.token, plotW, rowDomain[scrubDocOrdinal] ?? 0)
      : null;

  const targetFromPointer = (
    px: number,
    py: number,
    allowSnap = true,
    intent: TrendStagePointerIntent = 'locate',
  ): StagePointerTarget | null => {
    const hit = trendStageHit(px, py, hitSpec, intent);
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
      return null;
    }
    setLinkedSelection(selection);
    setPreview(null);
    const tokenCount = selectionTokenCount(selection);
    setRangeAnnouncement(
      `Range applied: ${tokenCount.toLocaleString()} token${tokenCount === 1 ? '' : 's'}.`,
    );
    return selection;
  };

  const wholeTextRange = (anchor: number, head: number): RangePreview | null => {
    const first = Math.min(anchor, head);
    const last = Math.max(anchor, head);
    const firstDoc = docs[first];
    const lastDoc = docs[last];
    const firstCount = docTokenCount[first] ?? 0;
    const lastCount = docTokenCount[last] ?? 0;
    if (!firstDoc || !lastDoc || firstCount <= 0 || lastCount <= 0) return null;
    return {
      mode: 'title',
      origin: { doc: firstDoc, token: 0 },
      head: { doc: lastDoc, token: lastCount - 1 },
    };
  };

  const commitWholeTextRange = (anchor: number, head: number) => {
    const range = wholeTextRange(anchor, head);
    if (!range) {
      setPreview((current) => current?.mode === 'title' ? null : current);
      return;
    }
    const selection = commitPreview(range);
    if (!selection) return;
    const first = selection.ranges[0];
    const last = selection.ranges.at(-1);
    if (!first || !last) return;
    if (selection.ranges.length === 1) {
      setRangeAnnouncement(`Selected whole text: ${titleByDoc.get(first.doc) ?? first.doc}.`);
      return;
    }
    setRangeAnnouncement(
      `Selected ${selection.ranges.length} texts: ${titleByDoc.get(first.doc) ?? first.doc} through ${titleByDoc.get(last.doc) ?? last.doc}.`,
    );
  };

  const applyTitleEffect = (effect: TrendTitleEffect) => {
    switch (effect.kind) {
      case 'preview': {
        const range = wholeTextRange(effect.anchor, effect.head);
        if (range) setPreview(range);
        return;
      }
      case 'commit': {
        commitWholeTextRange(effect.anchor, effect.head);
        if (effect.dragged) {
          suppressDoubleClickUntil.current = Date.now() + RANGE_CLEAR_SUPPRESSION_MS;
        }
        return;
      }
      case 'cancel':
        setPreview((current) => current?.mode === 'title' ? null : current);
        return;
      case 'none':
        return;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
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
    suppressDoubleClickUntil.current = 0;
    lastDirectPointerAt.current = 0;
    clearTouchHold();
    const reset = resetTouchRangeGesture(touchGesture.current);
    touchGesture.current = reset.state;
    trendDoubleTap.current = idleTrendDoubleTap();
    const titleReset = resetTrendTitleGesture(titleGesture.current);
    titleGesture.current = titleReset.state;
    titleKeyboardAnchor.current = null;
    setTitleFocusOrdinal((current) =>
      (docTokenCount[current] ?? 0) > 0
        ? current
        : docTokenCount.findIndex((count) => count > 0));
    applyTitleEffect(titleReset.effect);
    applyTouchRangeEffect(reset.effect);
  }, [snapshot?.snapshot, trend, trendView]);

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
    // Keep the hidden shortcut inert below two texts so an in-flight import
    // cannot collapse a separate-view preference held for the completed corpus.
    if (
      shortcutMatches(e, 'trend-toggle-view')
      && activeTextCount > 1
      && preview === null
    ) {
      e.preventDefault();
      const next = nextTrendView(trendView);
      setTrendView(next);
      setRangeAnnouncement(`Trend view: ${trendViewAccessibleName(next)}.`);
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
            rowDomain[ordinal] ?? 0,
          ),
          right: bookXFromTokenEdge(
            range.tokens.end,
            plotW,
            rowDomain[ordinal] ?? 0,
          ),
          top: ordinal * rowPitch,
          height: geometry.rowHeight + bandExtent,
        }];
      });
  const firstCommittedRange = linkedSelection?.ranges[0] ?? null;
  const lastCommittedRange = linkedSelection?.ranges.at(-1) ?? null;
  const committedRangeEndpoints = firstCommittedRange && lastCommittedRange
    ? {
        start: {
          doc: firstCommittedRange.doc,
          token: firstCommittedRange.tokens.start,
        },
        end: {
          doc: lastCommittedRange.doc,
          token: lastCommittedRange.tokens.end - 1,
        },
      }
    : null;
  const rangeHandleSpecs = coarse
    && committedRangeEndpoints
    && (preview === null || preview.mode === 'handle')
    && rangeBoxes.length > 0
      ? ([
          {
            edge: 'start' as const,
            x: rangeBoxes[0]!.left,
            top: rangeBoxes[0]!.top,
            bottom: rangeBoxes[0]!.top + rangeBoxes[0]!.height,
          },
          {
            edge: 'end' as const,
            x: rangeBoxes.at(-1)!.right,
            top: rangeBoxes.at(-1)!.top,
            bottom: rangeBoxes.at(-1)!.top + rangeBoxes.at(-1)!.height,
          },
        ])
      : [];
  const handleTargetAt = (clientX: number, clientY: number): ScrubTarget | null => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const px = Math.max(0, Math.min(plotW - 0.001, clientX - rect.left));
    if (trendView === 'series') {
      const target = seriesTokenFromX(px, plotW, layout);
      const doc = target ? docs[target.d] : undefined;
      return target && doc ? { doc, token: target.token } : null;
    }
    const py = Math.max(0, Math.min(rect.height - 0.001, clientY - rect.top));
    const d = Math.max(0, Math.min(docs.length - 1, Math.floor(py / rowPitch)));
    const doc = docs[d];
    const extent = docTokenCount[d] ?? 0;
    const domainToken = bookTokenFromX(px, plotW, rowDomain[d] ?? 0);
    return doc && domainToken !== null && extent > 0
      ? { doc, token: Math.min(domainToken, extent - 1) }
      : null;
  };
  const boundedHandleTarget = (
    edge: 'start' | 'end',
    fixed: ScrubTarget,
    target: ScrubTarget,
  ): ScrubTarget => {
    const fixedOrdinal = docs.indexOf(fixed.doc);
    const targetOrdinal = docs.indexOf(target.doc);
    if (fixedOrdinal < 0 || targetOrdinal < 0) return fixed;
    const fixedPosition = (layout.bases[fixedOrdinal] ?? 0) + fixed.token;
    const targetPosition = (layout.bases[targetOrdinal] ?? 0) + target.token;
    if (edge === 'start' && targetPosition > fixedPosition) return fixed;
    if (edge === 'end' && targetPosition < fixedPosition) return fixed;
    return target;
  };
  const describeRanges = (ranges: readonly TokenRangeSelectionSpanV1[]): string => {
    if (ranges.length === 0) return 'no tokens';
    if (ranges.length === 1) {
      const range = ranges[0]!;
      return `${titleByDoc.get(range.doc) ?? range.doc}, tokens ${range.tokens.start + 1}–${range.tokens.end}`;
    }
    const first = ranges[0]!;
    const last = ranges.at(-1)!;
    const count = selectionTokenCount({ snapshot: '', ranges });
    return `${titleByDoc.get(first.doc) ?? first.doc} token ${first.tokens.start + 1} → ${titleByDoc.get(last.doc) ?? last.doc} token ${last.tokens.end} · ${count.toLocaleString()} tokens across ${ranges.length} texts`;
  };
  const anchoredWaiting = preview?.mode === 'touch-anchor'
    && touchGesture.current.phase === 'anchored'
    && touchGesture.current.endpoint === null;
  const rangeStatus = preview
    ? anchoredWaiting
      ? `Range start set at ${describeRanges(shownRanges)} · tap another position`
      : `Selecting ${describeRanges(shownRanges)}`
    : '';
  const hiddenTitles = labelBands.some((band) => !band.titlePainted);

  const pointerTap = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly origin: StagePointerTarget;
    readonly pointerType: string;
    moved: boolean;
  } | null>(null);
  return (
    <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
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
          ...(activeTextCount > 1 ? ['trend-toggle-view' as const] : []),
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
          const rect = event.currentTarget.getBoundingClientRect();
          const hit = trendStageHit(
            event.clientX - rect.left,
            event.clientY - rect.top,
            hitSpec,
            'extend',
          );
          const decision = rangeClearDecision({
            zone: hit?.zone === 'plot'
              ? 'graph'
              : hit?.zone === 'barcode' ? 'barcode' : 'outside',
            interactiveTarget: event.target instanceof Element
              && event.target.closest('button, a, [role="button"]') !== null,
            now: Date.now(),
            suppressedUntil: suppressDoubleClickUntil.current,
            lastDirectPointerAt: lastDirectPointerAt.current,
          });
          if (decision.kind !== 'clear') return;
          event.preventDefault();
          clearTouchHold();
          const reset = resetTouchRangeGesture(touchGesture.current);
          touchGesture.current = reset.state;
          applyTouchRangeEffect(reset.effect);
          const cancelledPreview = preview !== null;
          setPreview(null);
          setLinkedSelection(null);
          if (linkedSelection !== null) setRangeAnnouncement('Range cleared.');
          else if (cancelledPreview) setRangeAnnouncement('Range selection cancelled.');
          suppressDoubleClickUntil.current = Date.now() + RANGE_CLEAR_SUPPRESSION_MS;
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          if (e.pointerType === 'touch') {
            trendDoubleTap.current = trendDoubleTapMove(trendDoubleTap.current, {
              pointerId: e.pointerId,
              clientX: e.clientX,
              clientY: e.clientY,
            });
            const before = touchGesture.current;
            if (before.phase === 'idle') return;
            const target = targetFromPointer(
              px,
              py,
              false,
              before.phase === 'ranging' || before.phase === 'anchored' ? 'extend' : 'locate',
            );
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
            const rangeTarget = targetFromPointer(px, py, false, 'extend');
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
          if (e.pointerType === 'touch') {
            lastDirectPointerAt.current = Date.now();
            // Sequential taps are recognized independently from the
            // concurrent two-contact range machine. Both taps must land in
            // the plot lane; barcodes, gaps, and range handles remain inert.
            const hit = trendStageHit(
              e.clientX - rect.left,
              e.clientY - rect.top,
              hitSpec,
              'extend',
            );
            const transition = trendDoubleTapDown(trendDoubleTap.current, {
              pointerId: e.pointerId,
              clientX: e.clientX,
              clientY: e.clientY,
              at: Date.now(),
              zone: hit?.zone === 'plot' ? 'plot' : 'other',
              clearable: linkedSelection !== null || preview !== null,
              interactiveTarget: e.target instanceof Element
                && e.target.closest('button, a, [role="button"]') !== null,
              touchPhase: touchGesture.current.phase,
            });
            trendDoubleTap.current = transition.state;
            if (transition.effect.kind === 'clear') {
              suppressDoubleClickUntil.current = Date.now() + RANGE_CLEAR_SUPPRESSION_MS;
              clearTouchHold();
              const cancelledPreview = preview !== null;
              setPreview(null);
              setLinkedSelection(null);
              if (linkedSelection !== null) setRangeAnnouncement('Range cleared.');
              else if (cancelledPreview) setRangeAnnouncement('Range selection cancelled.');
              // Consume the recognizing contact with the existing spent state
              // so its release cannot perform a second read after the clear.
              touchGesture.current = { phase: 'spent', heldPointerIds: [e.pointerId] };
              e.preventDefault();
              return;
            }
          }
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
            lastDirectPointerAt.current = Date.now();
            trendDoubleTap.current = trendDoubleTapUp(
              trendDoubleTap.current,
              e.pointerId,
              Date.now(),
            );
            if (touchHoldTimer.current?.pointerId === e.pointerId) clearTouchHold();
            const before = touchGesture.current;
            if (before.phase === 'idle') return;
            const rect = e.currentTarget.getBoundingClientRect();
            const target = targetFromPointer(
              e.clientX - rect.left,
              e.clientY - rect.top,
              false,
              before.phase === 'ranging' || before.phase === 'anchored' ? 'extend' : 'locate',
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
            suppressDoubleClickUntil.current = Date.now() + RANGE_CLEAR_SUPPRESSION_MS;
            commitPreview({ mode: 'pointer', origin: drag.origin, head: drag.head });
          } else {
            setScrub(drag.origin);
          }
        }}
        onPointerCancel={(e) => {
          if (e.pointerType === 'touch') {
            lastDirectPointerAt.current = Date.now();
            trendDoubleTap.current = trendDoubleTapCancel(
              trendDoubleTap.current,
              e.pointerId,
            );
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
        {barcodeVisible && barcodeTracks.length > 0 && (
          <div
            {...guideAnchorProps('dispersion-strip')}
            {...occurrenceActivationProps({ coarse, barcodeInteractive })}
            className="guide-dispersion-anchor"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: (trendView === 'series' ? geometry.seriesHeight : geometry.rowHeight)
                + geometry.barcodeBandGap,
              width: plotW,
              height: trendView === 'series'
                ? barcodeHeight
                : Math.max(0, docs.length - 1) * rowPitch + barcodeHeight,
              pointerEvents: 'none',
            }}
          />
        )}
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
        {rangeHandleSpecs.map((handle) => {
          const preferredLeft = handle.edge === 'start' ? handle.x - 40 : handle.x - 4;
          const left = Math.max(0, Math.min(plotW - 44, preferredLeft));
          const top = handle.edge === 'start'
            ? handle.top
            : Math.max(handle.top, handle.bottom - 44);
          const markerLeft = Math.max(2, Math.min(42, handle.x - left));
          return (
            <button
              key={handle.edge}
              type="button"
              className={`trend-range-handle trend-range-handle-${handle.edge}`}
              data-range-handle={handle.edge}
              aria-label={`Drag active scope ${handle.edge}`}
              style={{ left, top }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0 || !committedRangeEndpoints) return;
                trendDoubleTap.current = idleTrendDoubleTap();
                clearTouchHold();
                const reset = resetTouchRangeGesture(touchGesture.current);
                touchGesture.current = reset.state;
                const head = committedRangeEndpoints[handle.edge];
                rangeHandleDrag.current = {
                  pointerId: event.pointerId,
                  edge: handle.edge,
                  fixed: committedRangeEndpoints[handle.edge === 'start' ? 'end' : 'start'],
                  head,
                  moved: false,
                };
                event.currentTarget.dataset.dragging = 'true';
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Synthetic pointer events used by accessibility and browser
                  // regression tests have no native pointer to capture.
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                const drag = rangeHandleDrag.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const raw = handleTargetAt(event.clientX, event.clientY);
                if (raw) {
                  const head = boundedHandleTarget(drag.edge, drag.fixed, raw);
                  drag.head = head;
                  drag.moved = drag.moved
                    || head.doc !== committedRangeEndpoints?.[drag.edge].doc
                    || head.token !== committedRangeEndpoints?.[drag.edge].token;
                  if (drag.moved) {
                    setPreview({ mode: 'handle', origin: drag.fixed, head });
                  }
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={(event) => {
                const drag = rangeHandleDrag.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                rangeHandleDrag.current = null;
                delete event.currentTarget.dataset.dragging;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                if (drag.moved) {
                  suppressDoubleClickUntil.current = Date.now() + RANGE_CLEAR_SUPPRESSION_MS;
                  commitPreview({ mode: 'handle', origin: drag.fixed, head: drag.head });
                } else {
                  setPreview(null);
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerCancel={(event) => {
                if (rangeHandleDrag.current?.pointerId !== event.pointerId) return;
                rangeHandleDrag.current = null;
                delete event.currentTarget.dataset.dragging;
                setPreview(null);
                event.stopPropagation();
              }}
              onLostPointerCapture={(event) => {
                if (rangeHandleDrag.current?.pointerId !== event.pointerId) return;
                rangeHandleDrag.current = null;
                delete event.currentTarget.dataset.dragging;
                setPreview(null);
              }}
            >
              <span
                className="trend-range-handle-mark"
                style={{ left: markerLeft }}
                aria-hidden="true"
              />
            </button>
          );
        })}
        {scrubX !== null && (
          <div
            {...guideAnchorProps('chart-cursor')}
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
      <div
        className="trend-title-controls"
        role="group"
        aria-label="Select whole texts"
        aria-describedby={hiddenTitles ? 'trend-hidden-title-note' : undefined}
        style={{
          width: plotW,
          height: labelBands.reduce(
            (maximum, band) => Math.max(maximum, band.focusTop + band.focusHeight),
            0,
          ),
        }}
      >
        {labelBands.map((band) => {
          const doc = docs[band.d];
          const title = doc ? titleByDoc.get(doc) ?? doc : '';
          const disabled = !doc || (docTokenCount[band.d] ?? 0) <= 0;
          const bandWidth = Math.max(0, band.right - band.left);
          // A by-book label is left-aligned. Keep its touch target around the
          // rendered title rather than blocking vertical page scroll across
          // the row's full width. Combined labels use pan-y below.
          const targetWidth = trendView === 'series'
            ? bandWidth
            : band.titlePainted
              ? Math.min(bandWidth, Math.max(44, title.length * 7 + 12))
              : bandWidth;
          const titleTargetFromPointer = (clientX: number, clientY: number): number | null => {
            const rect = sliderRef.current?.getBoundingClientRect();
            if (!rect) return null;
            const ordinal = trendStageDocument(
              clientX - rect.left,
              clientY - rect.top,
              hitSpec,
            );
            return ordinal !== null && (docTokenCount[ordinal] ?? 0) > 0 ? ordinal : null;
          };
          return (
            <button
              key={doc ?? band.d}
              type="button"
              ref={(element) => {
                if (element) titleControlRefs.current.set(band.d, element);
                else titleControlRefs.current.delete(band.d);
              }}
              className="trend-title-control"
              data-trend-title-control={band.d}
              data-title-painted={String(band.titlePainted)}
              disabled={disabled}
              tabIndex={!disabled && band.d === titleFocusOrdinal ? 0 : -1}
              aria-keyshortcuts={TREND_TITLE_ARIA_KEYS}
              aria-label={`Text ${band.d + 1} of ${docs.length}: ${title} — select whole text`}
              title={title}
              style={{
                left: band.left,
                top: band.focusTop,
                width: targetWidth,
                height: band.focusHeight,
                pointerEvents: band.titlePainted ? undefined : 'none',
                touchAction: trendView === 'series' ? 'pan-y' : 'none',
              }}
              onFocus={() => setTitleFocusOrdinal(band.d)}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey || event.altKey) return;
                const move = event.key === 'Home'
                  ? 'first'
                  : event.key === 'End'
                    ? 'last'
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? 'previous'
                      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                        ? 'next'
                        : null;
                if (move === null) return;
                const enabled = docTokenCount.map((count) => count > 0);
                const next = nextTrendTitleFocus(band.d, move, enabled);
                if (next === null) return;
                event.preventDefault();
                event.stopPropagation();
                if (next !== band.d) {
                  setTitleFocusOrdinal(next);
                  titleControlRefs.current.get(next)?.focus();
                }
                if (event.shiftKey) {
                  if (next === band.d) return;
                  titleKeyboardAnchor.current ??= band.d;
                  commitWholeTextRange(titleKeyboardAnchor.current, next);
                } else {
                  titleKeyboardAnchor.current = null;
                }
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // Direct pointers commit on pointerup. A zero-detail click is
                // keyboard or assistive-technology activation.
                if (event.detail === 0) {
                  titleKeyboardAnchor.current = null;
                  commitWholeTextRange(band.d, band.d);
                }
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0 || disabled) return;
                trendDoubleTap.current = idleTrendDoubleTap();
                clearTouchHold();
                const touchReset = resetTouchRangeGesture(touchGesture.current);
                touchGesture.current = touchReset.state;
                applyTouchRangeEffect(touchReset.effect);
                pointerTap.current = null;
                pointerDrag.current = null;
                rangeHandleDrag.current = null;
                titleKeyboardAnchor.current = null;
                setTitleFocusOrdinal(band.d);
                setPreview(null);
                const transition = trendTitleDown(
                  event.pointerId,
                  band.d,
                  event.clientX,
                  event.clientY,
                );
                titleGesture.current = transition.state;
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Synthetic PointerEvents do not create native capture state.
                }
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                const transition = trendTitleMove(titleGesture.current, {
                  pointerId: event.pointerId,
                  ordinal: titleTargetFromPointer(event.clientX, event.clientY),
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
                titleGesture.current = transition.state;
                applyTitleEffect(transition.effect);
                if (transition.state.phase === 'pressed') {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPointerUp={(event) => {
                const moved = trendTitleMove(titleGesture.current, {
                  pointerId: event.pointerId,
                  ordinal: titleTargetFromPointer(event.clientX, event.clientY),
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
                titleGesture.current = moved.state;
                applyTitleEffect(moved.effect);
                const transition = trendTitleUp(titleGesture.current, event.pointerId);
                titleGesture.current = transition.state;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                applyTitleEffect(transition.effect);
                if (transition.effect.kind !== 'none') {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPointerCancel={(event) => {
                if (
                  titleGesture.current.phase !== 'pressed'
                  || titleGesture.current.pointerId !== event.pointerId
                ) return;
                const transition = resetTrendTitleGesture(titleGesture.current);
                titleGesture.current = transition.state;
                applyTitleEffect(transition.effect);
                event.stopPropagation();
              }}
              onLostPointerCapture={(event) => {
                if (
                  titleGesture.current.phase !== 'pressed'
                  || titleGesture.current.pointerId !== event.pointerId
                ) return;
                const transition = resetTrendTitleGesture(titleGesture.current);
                titleGesture.current = transition.state;
                applyTitleEffect(transition.effect);
              }}
            />
          );
        })}
      </div>
      {hiddenTitles && (
        <span id="trend-hidden-title-note" className="visually-hidden">
          Titles are hidden at this row height. Selection remains available from the keyboard.
        </span>
      )}
      {!barcodeVisible && barcodeTracks.length > 0 && (
        <span id="trend-hidden-barcode-note" className="visually-hidden">
          Occurrence rows are hidden at this row height. Occurrence totals and stepping remain
          available in the term legend.
        </span>
      )}
      {barcodeVisible && !barcodeInteractive && barcodeTracks.length > 0 && (
        <span id="trend-mini-barcode-note" className="visually-hidden">
          Occurrence rows are minimized at this row height. Their marks remain visible, but
          occurrence clicking is unavailable; totals and stepping remain in the term legend.
        </span>
      )}
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
