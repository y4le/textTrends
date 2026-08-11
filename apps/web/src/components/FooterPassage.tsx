import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import type { FooterPassageState, ScrubTarget } from '../lib/store.ts';
import {
  footerPassageDisplay,
  passageLayout,
  passageMarginTokens,
  passageTokenGeometry,
  type PassageWindowV1,
} from '../lib/footer-view.ts';
import {
  displayReaderText,
  segmentReaderMarks,
  type ReaderSegment,
} from '../lib/reader-marks.ts';
import { DEFAULT_SERIES_STYLE, seriesColor } from '../lib/series-style.ts';
import type { WidthClass } from '../lib/presentation.ts';

let textMeasureContext: CanvasRenderingContext2D | null = null;

function measuredTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined' || font === '') return 0;
  textMeasureContext ??= document.createElement('canvas').getContext('2d');
  if (!textMeasureContext) return 0;
  textMeasureContext.font = font;
  return textMeasureContext.measureText(text).width;
}

function splitAt(
  segments: readonly ReaderSegment[],
  boundaries: readonly number[],
): ReaderSegment[] {
  const cuts = [...new Set(boundaries)].sort((a, b) => a - b);
  const output: ReaderSegment[] = [];
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
}: {
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
}) {
  const openReader = useApp((state) => state.openReader);
  const retryPassage = useApp((state) => state.runFooterPassage);
  const focusedSeries = useApp((state) => state.focusedSeries);
  const beforeRef = useRef<HTMLSpanElement | null>(null);
  const passageRef = useRef<HTMLElement | null>(null);
  const [canvasFont, setCanvasFont] = useState('');
  const [containerWidth, setContainerWidth] = useState(0);
  const page = passage?.snapshot === snapshot ? passage.page : null;
  const display = useMemo(() => page ? displayReaderText(page.text) : '', [page]);
  const baseSegments = useMemo(() => page ? segmentReaderMarks(
    display.length,
    page.marks.map((mark) => ({
      seriesId: mark.seriesId,
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
  const view = footerPassageDisplay(passage, scrub, snapshot, passageMargin);
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
  const styled = (segment: ReaderSegment, key: string) => {
    const text = display.slice(segment.start, segment.end);
    if (segment.seriesIds.length === 0) return <span key={key}>{text}</span>;
    const tintId = segment.seriesIds[0]!;
    const lineId = segment.seriesIds.includes(focusedSeries ?? '')
      ? focusedSeries!
      : tintId;
    return (
      <span
        key={key}
        style={{
          background: `color-mix(in srgb, ${seriesColor(styles.get(tintId) ?? DEFAULT_SERIES_STYLE)} 22%, transparent)`,
          borderBlockEnd: `2px solid ${seriesColor(styles.get(lineId) ?? DEFAULT_SERIES_STYLE)}`,
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

  const openCurrent = () => openReader({
    snapshot,
    doc: scrub.doc,
    token: scrub.token,
    from: 'footer',
  }, 'footer-passage-node');
  const line = (
    <span
      className="footer-passage-text"
      style={{
        left: crosshairX,
        transform: `translateX(${(-(measuredLayout?.shiftPx ?? centerOffset)).toFixed(1)}px)`,
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
          onClick={openCurrent}
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
    'data-passage-first': windowData.firstVisibleToken,
    'data-passage-last': windowData.lastVisibleToken,
    'data-passage-for': windowData.forToken,
  } : {};

  return coarse && !stale ? (
    <button
      {...windowAttributes}
      ref={(element) => { passageRef.current = element; }}
      id="footer-passage-node"
      type="button"
      className="footer-passage footer-passage-coarse source-text"
      aria-label={`Open reader at ${title} token ${(scrub.token + 1).toLocaleString()}`}
      onClick={openCurrent}
    >
      {line}
    </button>
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
