import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import type { FooterPassageState, ScrubTarget } from '../lib/store.ts';
import {
  footerPassageDisplay,
  passageLayout,
  passageMarginTokens,
  passageTokenAtTextOffset,
  passageTokenGeometry,
  type PassageWindowV1,
} from '../lib/footer-view.ts';
import {
  displaySourceText,
  segmentMarks,
  type MarkSegment,
} from '../lib/marks-view.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import type { WidthClass } from '../lib/presentation.ts';

let textMeasureContext: CanvasRenderingContext2D | null = null;
const NATIVE_SCROLL_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function measuredTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined' || font === '') return 0;
  textMeasureContext ??= document.createElement('canvas').getContext('2d');
  if (!textMeasureContext) return 0;
  textMeasureContext.font = font;
  return textMeasureContext.measureText(text).width;
}

function splitAt(
  segments: readonly MarkSegment<string>[],
  boundaries: readonly number[],
): MarkSegment<string>[] {
  const cuts = [...new Set(boundaries)].sort((a, b) => a - b);
  const output: MarkSegment<string>[] = [];
  for (const segment of segments) {
    let start = segment.start;
    for (const cut of cuts) {
      if (cut <= start || cut >= segment.end) continue;
      output.push({ ...segment, start, end: cut });
      start = cut;
    }
    output.push({ ...segment, start });
  }
  return output;
}

interface FooterPassageProps {
  readonly passage: FooterPassageState | null;
  readonly scrub: ScrubTarget | null;
  readonly snapshot: string;
  readonly title: string;
  readonly crosshairXForToken: (doc: string, token: number) => number | null;
  readonly coarse: boolean;
  readonly widthClass: WidthClass;
  readonly onPassageMarginChange: (tokens: number) => void;
  readonly onVisibleTokensChange: (tokens: number) => void;
  readonly onPassageWindowChange: (window: PassageWindowV1 | null) => void;
}

/** One clipped, selectable line of authenticated source text. This is a
 * transient readout. */
export function FooterPassage({
  passage,
  scrub,
  snapshot,
  title,
  crosshairXForToken,
  coarse,
  widthClass,
  onPassageMarginChange,
  onVisibleTokensChange,
  onPassageWindowChange,
}: FooterPassageProps) {
  const openReader = useApp((state) => state.openReader);
  const retryPassage = useApp((state) => state.runFooterPassage);
  const setScrub = useApp((state) => state.setScrub);
  const beforeRef = useRef<HTMLSpanElement | null>(null);
  const passageRef = useRef<HTMLElement | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollDrivenToken = useRef<number | null>(null);
  const programmaticScrollLeft = useRef<number | null>(null);
  const suppressOpenUntil = useRef(0);
  const nativeScrollIntentUntil = useRef(0);
  const scrollPointerStart = useRef<{
    readonly id: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const residentPageKey = useRef('');
  const [canvasFont, setCanvasFont] = useState('');
  const [containerWidth, setContainerWidth] = useState(0);
  const page = passage?.snapshot === snapshot ? passage.page : null;
  const display = useMemo(() => page ? displaySourceText(page.text) : '', [page]);
  const baseSegments = useMemo(() => page ? segmentMarks(
    display.length,
    page.marks.map((mark) => ({
      value: mark.seriesId,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
  ) : [], [display.length, page]);

  useLayoutEffect(() => {
    if (!beforeRef.current) return;
    const style = getComputedStyle(beforeRef.current);
    const next = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setCanvasFont((current) => current === next ? current : next);
  }, [coarse, page, widthClass]);

  useLayoutEffect(() => {
    const element = passageRef.current;
    if (!element) return undefined;
    const publish = () => setContainerWidth((current) => {
      const next = Math.max(0, element.clientWidth);
      return current === next ? current : next;
    });
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [coarse, page, widthClass]);

  const tokenGeometry = useMemo(() => (
    page && canvasFont !== '' && display !== ''
      ? passageTokenGeometry(
          display,
          page.tokenStartsUtf16,
          page.tokenEndsUtf16,
          (text) => measuredTextWidth(text, canvasFont),
        )
      : null
  ), [canvasFont, display, page]);

  const passageMargin = useMemo(() => tokenGeometry
    ? passageMarginTokens(tokenGeometry, containerWidth)
    : 0, [containerWidth, tokenGeometry]);
  // Native scrolling may legitimately enter the prefetch margin while a
  // replacement page is in flight. Keep that authenticated resident source
  // interactive; the store still uses the measured margin to request early.
  const view = footerPassageDisplay(passage, scrub, snapshot);
  const stale = view?.stale ?? false;
  const crosshairX = view
    ? crosshairXForToken(view.page.doc, view.token)
    : scrub ? crosshairXForToken(scrub.doc, scrub.token) : null;
  const relativeToken = page && view ? view.token - page.tokens.start : -1;
  const centerStart = relativeToken >= 0 ? page?.tokenStartsUtf16[relativeToken] ?? 0 : 0;
  const centerEnd = relativeToken >= 0 ? page?.tokenEndsUtf16[relativeToken] ?? 0 : 0;
  const segments = useMemo(
    () => splitAt(baseSegments, [centerStart, centerEnd]),
    [baseSegments, centerEnd, centerStart],
  );

  const viewToken = view?.token ?? -1;
  const measuredLayout = useMemo(() => (
    page && tokenGeometry && containerWidth > 0 && viewToken >= 0
      ? passageLayout(
          page,
          snapshot,
          viewToken,
          containerWidth,
          tokenGeometry,
          (token) => crosshairXForToken(page.doc, token) ?? 0,
        )
      : null
  ), [containerWidth, crosshairXForToken, page, snapshot, tokenGeometry, viewToken]);

  useLayoutEffect(() => {
    onPassageMarginChange(passageMargin);
    onPassageWindowChange(measuredLayout?.window ?? null);
    if (measuredLayout) onVisibleTokensChange(measuredLayout.visibleTokens);
  }, [
    measuredLayout,
    onPassageMarginChange,
    onPassageWindowChange,
    onVisibleTokensChange,
    passageMargin,
  ]);

  useEffect(() => () => onPassageWindowChange(null), [onPassageWindowChange]);

  const centerOffset = useMemo(() => measuredTextWidth(
    display.slice(0, centerStart),
    canvasFont,
  ) + measuredTextWidth(
    display.slice(centerStart, centerEnd),
    canvasFont,
  ) / 2, [canvasFont, centerEnd, centerStart, display]);
  const nativeScrollLeft = !stale && crosshairX !== null
    ? (measuredLayout?.shiftPx ?? centerOffset) - crosshairX
    : null;
  const pageKey = page
    ? `${page.doc}:${page.tokens.start}:${page.tokens.end}`
    : '';

  useLayoutEffect(() => {
    const element = passageRef.current;
    if (element === null || nativeScrollLeft === null) return;
    const sameResidentPage = residentPageKey.current === pageKey;
    const followsNativeScroll = scrollDrivenToken.current === viewToken;
    residentPageKey.current = pageKey;
    if (sameResidentPage && followsNativeScroll) return;
    // An external cross-document scrub supersedes any scroll-derived update
    // queued by the previously resident source page.
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
    if (!followsNativeScroll) nativeScrollIntentUntil.current = 0;
    scrollDrivenToken.current = null;
    // Passage text lives in a real horizontal scrollport for both touch and
    // precise pointers. Recenter when the reading target changes, then leave
    // subsequent touch, wheel, and trackpad panning entirely to the browser.
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = Math.max(0, Math.min(maximum, nativeScrollLeft));
    programmaticScrollLeft.current = next;
    element.scrollLeft = next;
  }, [nativeScrollLeft, pageKey, viewToken]);

  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, []);

  const markNativeScrollIntent = useCallback(() => {
    // Cover the browser-owned momentum tail; each subsequent wheel/pointer
    // gesture refreshes the window.
    nativeScrollIntentUntil.current = Date.now() + 2_000;
  }, []);

  const syncScrubToScroll = useCallback((element: HTMLElement) => {
    const programmed = programmaticScrollLeft.current;
    if (programmed !== null && Math.abs(element.scrollLeft - programmed) <= 0.75) {
      // WebKit may emit more than one scroll event for the same assignment.
      // Keep the target authenticated until a genuinely divergent native
      // scroll arrives; clearing after the first event misclassifies the
      // second and suppresses an immediate, intentional Reader tap.
      return;
    }
    programmaticScrollLeft.current = null;
    if (Date.now() < nativeScrollIntentUntil.current) {
      suppressOpenUntil.current = Date.now() + 350;
    }
    if (!tokenGeometry || !page || crosshairX === null) return;
    const relative = passageTokenAtTextOffset(
      tokenGeometry,
      element.scrollLeft + crosshairX,
    );
    if (relative === null) return;
    const token = page.tokens.start + relative;
    scrollDrivenToken.current = token;
    if (token === scrub?.token) return;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const latest = scrollDrivenToken.current;
      if (latest !== null) {
        setScrub(
          { doc: page.doc, token: latest },
          { kind: 'drift', origin: 'scrub' },
        );
      }
    });
  }, [crosshairX, page, scrub?.token, setScrub, tokenGeometry]);

  if (scrub === null || crosshairX === null) {
    return <div className="footer-passage footer-passage-message">scrub the corpus strip to read</div>;
  }
  if (page === null) {
    if (
      passage?.state.status === 'error'
      && passage.snapshot === snapshot
      && passage.doc === scrub.doc
    ) {
      return (
        <div className="footer-passage footer-passage-message" role="status">
          source unavailable ·{' '}
          <button type="button" className="footer-passage-retry" onClick={retryPassage}>
            retry
          </button>
        </div>
      );
    }
    return <div className="footer-passage footer-passage-message">loading source…</div>;
  }

  const styles = new Map(passage?.tracks.map((track) => [track.seriesId, track.style]));
  const styled = (segment: MarkSegment<string>, key: string) => {
    const text = display.slice(segment.start, segment.end);
    if (segment.values.length === 0) return <span key={key}>{text}</span>;
    const tintId = segment.values[0]!;
    return (
      <span
        key={key}
        style={{
          background: `color-mix(in srgb, ${seriesColor(styles.get(tintId) ?? DEFAULT_SERIES_STYLE)} 22%, transparent)`,
          borderBlockEnd: `2px solid ${seriesColor(styles.get(tintId) ?? DEFAULT_SERIES_STYLE)}`,
        }}
      >
        {text}
      </span>
    );
  };
  const before = segments.filter((segment) => segment.end <= centerStart);
  const center = segments.filter(
    (segment) => segment.start >= centerStart && segment.end <= centerEnd,
  );
  const after = segments.filter((segment) => segment.start >= centerEnd);
  const centerContent = center.map((segment, index) => styled(segment, `c:${index}`));

  const openCurrent = (honorScrollSuppression: boolean) => {
    if (honorScrollSuppression && Date.now() < suppressOpenUntil.current) return;
    openReader({
      snapshot,
      doc: scrub.doc,
      token: scrub.token,
      from: 'footer',
      anchor: 'position',
    }, 'footer-passage-node');
  };
  const line = (
    <span
      className="footer-passage-text"
      style={{
        left: stale ? crosshairX : 0,
        transform: stale
          ? `translateX(${(-(measuredLayout?.shiftPx ?? centerOffset)).toFixed(1)}px)`
          : undefined,
      }}
    >
      <span ref={beforeRef}>
        {before.map((segment, index) => styled(segment, `b:${index}`))}
      </span>
      {coarse || stale ? (
        <span>{centerContent}</span>
      ) : (
        <button
          id="footer-passage-node"
          type="button"
          className="footer-passage-node"
          aria-label={`Open reader at ${title} token ${(scrub.token + 1).toLocaleString()}`}
          onClick={() => { openCurrent(true); }}
        >
          {centerContent}
        </button>
      )}
      <span>{after.map((segment, index) => styled(segment, `a:${index}`))}</span>
    </span>
  );

  const stateClass = stale ? ' footer-passage-stale' : '';
  const errorRetry = passage?.state.status === 'error' ? (
    <button
      type="button"
      className="footer-passage-retry footer-passage-retry-overlay"
      onClick={retryPassage}
    >
      source unavailable · retry
    </button>
  ) : null;
  const windowData = measuredLayout?.window;
  const windowAttributes = windowData ? {
    'data-passage-page-start': windowData.pageTokens.start,
    'data-passage-page-end': windowData.pageTokens.end,
    'data-passage-first': windowData.firstVisibleToken,
    'data-passage-last': windowData.lastVisibleToken,
    'data-passage-for': windowData.forToken,
  } : {};

  return !stale ? (
    <div
      {...windowAttributes}
      ref={(element) => { passageRef.current = element; }}
      id={coarse ? 'footer-passage-node' : undefined}
      className={`footer-passage footer-passage-scrollable source-text${
        coarse ? ' footer-passage-coarse' : ''
      }`}
      role={coarse ? 'button' : undefined}
      tabIndex={coarse ? 0 : undefined}
      aria-label={coarse
        ? `Open reader at ${title} token ${(scrub.token + 1).toLocaleString()}`
        : undefined}
      onClick={coarse ? () => { openCurrent(true); } : undefined}
      onPointerDown={(event) => {
        if (!event.isPrimary) return;
        scrollPointerStart.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        const start = scrollPointerStart.current;
        if (
          event.buttons !== 0
          && start?.id === event.pointerId
          && (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4)
        ) {
          markNativeScrollIntent();
        }
      }}
      onPointerUp={(event) => {
        if (scrollPointerStart.current?.id === event.pointerId) {
          scrollPointerStart.current = null;
        }
      }}
      onPointerCancel={(event) => {
        if (scrollPointerStart.current?.id === event.pointerId) {
          scrollPointerStart.current = null;
          markNativeScrollIntent();
        }
      }}
      onWheel={markNativeScrollIntent}
      onScroll={(event) => { syncScrubToScroll(event.currentTarget); }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          if (NATIVE_SCROLL_KEYS.has(event.key)) {
            markNativeScrollIntent();
          }
          return;
        }
        event.preventDefault();
        openCurrent(false);
      }}
    >
      <span
        className="footer-passage-scroll-content"
        style={{
          width: Math.max(
            containerWidth,
            tokenGeometry?.textWidth ?? 0,
          ),
        }}
      >
        {line}
      </span>
    </div>
  ) : (
    <div
      {...windowAttributes}
      ref={(element) => { passageRef.current = element; }}
      className={`footer-passage source-text${stateClass}`}
      aria-busy={passage?.state.status === 'pending'}
    >
      {line}
      {errorRetry}
    </div>
  );
}
