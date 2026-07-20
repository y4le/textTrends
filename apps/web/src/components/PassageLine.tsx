/**
 * The reading line beneath the trend chart: one clipped line of the actual
 * book text, centered so the scrubbed token's visual midpoint sits under the
 * chart crosshair — slide in small steps and you are reading the book.
 *
 * Honesty rules:
 * - The passage text is rendered as TEXT NODES only, never markup.
 * - The display transform (line breaks/tabs → spaces) replaces single code
 *   units so every mark offset stays valid; the source text is untouched.
 * - Occurrence marks tint the background and underline in the series color;
 *   the glyphs keep the normal AA foreground — color is identity, not ink.
 * - Centering uses MEASURED pixel widths of the rendered prefix and center
 *   token (monospace does not make every glyph one cell).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { PassageResult } from '@texttrends/core';
import { slotColor } from '../lib/series-style.ts';
import type { SeriesIntent } from '../lib/store.ts';

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly seriesIds: readonly string[];
}

/** Non-overlapping segments from (possibly overlapping) mark spans. */
export function segmentMarks(
  length: number,
  marks: readonly { readonly seriesId: string; readonly start: number; readonly end: number }[],
  extraBoundaries: readonly number[],
): Segment[] {
  const bounds = new Set<number>([0, length, ...extraBoundaries]);
  for (const m of marks) {
    bounds.add(Math.max(0, Math.min(length, m.start)));
    bounds.add(Math.max(0, Math.min(length, m.end)));
  }
  const sorted = [...bounds].filter((b) => b >= 0 && b <= length).sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start === end) continue;
    const covering = marks.filter((m) => m.start <= start && m.end >= end);
    // Deterministic order: first-marked wins the tint.
    out.push({ start, end, seriesIds: covering.map((m) => m.seriesId) });
  }
  return out;
}

/** Single code-unit substitutions only (offsets must survive): every
 *  Unicode line break the segmenter recognizes, plus tabs. */
const DISPLAY_WS = /[\n\r\t\u0085\u2028\u2029]/g;

export function PassageLine({
  passage,
  token,
  crosshairX,
  series,
  focusedSeries,
  caption,
}: {
  passage: PassageResult;
  /** Document-local scrubbed token — must lie within passage.tokens. */
  token: number;
  crosshairX: number;
  series: readonly SeriesIntent[];
  focusedSeries: string | null;
  caption: string;
}) {
  const preRef = useRef<HTMLSpanElement | null>(null);
  const centerRef = useRef<HTMLSpanElement | null>(null);
  const [centerOffset, setCenterOffset] = useState(0);

  const rel = token - passage.tokens.start;
  const centerStart = passage.tokenStartsUtf16[rel] ?? 0;
  const centerEnd = passage.tokenEndsUtf16[rel] ?? 0;

  useLayoutEffect(() => {
    const pre = preRef.current;
    const center = centerRef.current;
    if (!pre || !center) return;
    setCenterOffset(pre.getBoundingClientRect().width + center.getBoundingClientRect().width / 2);
  }, [passage, token]);

  const display = passage.text.replace(DISPLAY_WS, ' ');
  const slotOf = new Map(series.map((s) => [s.id, s.styleSlot]));
  const segments = segmentMarks(
    display.length,
    passage.marks.map((m) => ({ seriesId: m.seriesId, start: m.charsUtf16.start, end: m.charsUtf16.end })),
    [centerStart, centerEnd],
  );

  const styled = (seg: Segment, key: number) => {
    if (seg.seriesIds.length === 0) {
      return <span key={key}>{display.slice(seg.start, seg.end)}</span>;
    }
    const tintId = seg.seriesIds[0]!;
    const lineId = seg.seriesIds.includes(focusedSeries ?? '') ? focusedSeries! : tintId;
    const tint = slotColor(slotOf.get(tintId) ?? 0);
    const line = slotColor(slotOf.get(lineId) ?? 0);
    return (
      <span
        key={key}
        style={{
          background: `color-mix(in srgb, ${tint} 22%, transparent)`,
          borderBottom: `2px solid ${line}`,
        }}
      >
        {display.slice(seg.start, seg.end)}
      </span>
    );
  };

  const before = segments.filter((s) => s.end <= centerStart);
  const center = segments.filter((s) => s.start >= centerStart && s.end <= centerEnd);
  const after = segments.filter((s) => s.start >= centerEnd);

  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          height: '1.7em',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
          whiteSpace: 'pre',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: crosshairX,
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--rule-strong)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: crosshairX,
            top: '0.2em',
            transform: `translateX(${(-centerOffset).toFixed(1)}px)`,
            willChange: 'transform',
          }}
        >
          <span ref={preRef}>{before.map(styled)}</span>
          <span ref={centerRef}>{center.map(styled)}</span>
          <span>{after.map(styled)}</span>
        </div>
      </div>
      <p
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-muted)',
          margin: 'var(--space-1) 0 0',
        }}
      >
        {caption}
      </p>
    </div>
  );
}
