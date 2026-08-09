import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import type { FooterPassageState, ScrubTarget } from '../lib/store.ts';
import {
  displayReaderText,
  segmentReaderMarks,
  type ReaderSegment,
} from '../lib/reader-marks.ts';
import { slotColor } from '../lib/series-style.ts';
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
  crosshairX,
  coarse,
  widthClass,
}: {
  readonly passage: FooterPassageState | null;
  readonly scrub: ScrubTarget | null;
  readonly snapshot: string;
  readonly title: string;
  readonly crosshairX: number | null;
  readonly coarse: boolean;
  readonly widthClass: WidthClass;
}) {
  const openReader = useApp((state) => state.openReader);
  const retryPassage = useApp((state) => state.runFooterPassage);
  const focusedSeries = useApp((state) => state.focusedSeries);
  const beforeRef = useRef<HTMLSpanElement | null>(null);
  const [canvasFont, setCanvasFont] = useState('');
  const page = passage?.state.status === 'ready'
    && scrub !== null
    && passage.snapshot === snapshot
    && passage.doc === scrub.doc
    && scrub.token >= passage.state.page.tokens.start
    && scrub.token < passage.state.page.tokens.end
    ? passage.state.page
    : null;
  const display = useMemo(() => page ? displayReaderText(page.text) : '', [page]);
  const baseSegments = useMemo(() => page ? segmentReaderMarks(
    display.length,
    page.marks.map((mark) => ({
      seriesId: mark.seriesId,
      start: mark.charsUtf16.start,
      end: mark.charsUtf16.end,
    })),
  ) : [], [display.length, page]);

  const relativeToken = page && scrub ? scrub.token - page.tokens.start : -1;
  const centerStart = relativeToken >= 0 ? page?.tokenStartsUtf16[relativeToken] ?? 0 : 0;
  const centerEnd = relativeToken >= 0 ? page?.tokenEndsUtf16[relativeToken] ?? 0 : 0;
  const segments = useMemo(
    () => splitAt(baseSegments, [centerStart, centerEnd]),
    [baseSegments, centerEnd, centerStart],
  );

  useLayoutEffect(() => {
    if (!beforeRef.current) return;
    const style = getComputedStyle(beforeRef.current);
    const next = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setCanvasFont((current) => current === next ? current : next);
  }, [coarse, page, widthClass]);

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

  const slots = new Map(passage?.tracks.map((track) => [track.seriesId, track.styleSlot]));
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
          background: `color-mix(in srgb, ${slotColor(slots.get(tintId) ?? 0)} 22%, transparent)`,
          borderBlockEnd: `2px solid ${slotColor(slots.get(lineId) ?? 0)}`,
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
        transform: `translateX(${(-centerOffset).toFixed(1)}px)`,
      }}
    >
      <span ref={beforeRef}>
        {before.map((segment, index) => styled(segment, `b:${index}`))}
      </span>
      {coarse ? (
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

  return coarse ? (
    <button
      id="footer-passage-node"
      type="button"
      className="footer-passage footer-passage-coarse source-text"
      aria-label={`Open reader at ${title} token ${(scrub.token + 1).toLocaleString()}`}
      onClick={openCurrent}
    >
      {line}
    </button>
  ) : (
    <div className="footer-passage source-text">{line}</div>
  );
}
