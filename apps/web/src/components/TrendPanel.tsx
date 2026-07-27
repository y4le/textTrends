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
 * Both views share one y-scale (rate/10k across every term and book) so
 * magnitude comparison stays honest. Values are unsmoothed. Series identity
 * is color + dash + chips/direct labels — never color alone. The plot holds
 * until every non-failed series resolves so the shared scale never jumps.
 * Exact values live in the per-book summary table (counts and rates are
 * summed/recomputed, never averaged from bin rates).
 *
 * The chart spans its container's full width (the app gives it the viewport)
 * via a measured ResizeObserver width; the axis position under the pointer /
 * keyboard scrubber drives the PassageLine beneath — the actual book text at
 * that position, occurrence marks in series colors. Pointer motion is
 * rAF-coalesced and deduplicated; the store fetches passage blocks and
 * navigates locally inside them.
 */

import { scaleLinear } from 'd3-scale';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { slotColor, slotDash } from '../lib/series-style.ts';
import {
  binSpan,
  bookXFromToken,
  bookXFromTokenEdge,
  clampToSpan,
  pointerTargetByBook,
  pointerTargetSeries,
  seriesXFromToken,
  seriesXFromTokenEdge,
  spreadLabels,
  stepAlongSequence,
  type SequenceLayout,
} from '../lib/trend-geometry.ts';
import type { ScrubTarget, SeriesIntent } from '../lib/store.ts';
import { topLevelBoundaryTokens } from '../lib/structure-view.ts';
import { PassageLine } from './PassageLine.tsx';

const SERIES_HEIGHT = 180;
const TOP_PAD = 14; // room for the y-max direct label above the plot
const ROW_HEIGHT = 44;
const ROW_GAP = 22;
const LABEL_SPACE = 130;
const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
const MIN_LABEL_GAP = 12;
const MIN_PLOT_WIDTH = 320;

interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
}

export function TrendPanel() {
  const series = useApp((s) => s.series);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const trends = useApp((s) => s.trends);
  const trendView = useApp((s) => s.trendView);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const setFocus = useApp((s) => s.setFocus);
  const scrub = useApp((s) => s.scrub);
  const passage = useApp((s) => s.passage);
  const setScrub = useApp((s) => s.setScrub);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const structure = useApp((s) => s.structure);
  const sectionMarks = useApp((s) => s.sectionMarks);

  // Callback ref, not a RefObject: the container mounts only after the trend
  // results settle, so a mount-time effect would observe nothing.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [plotW, setPlotW] = useState(720);
  useLayoutEffect(() => {
    if (!containerEl) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width) return; // ignore zero/unavailable observations
      const next = Math.max(MIN_PLOT_WIDTH, Math.round(width) - LABEL_SPACE);
      setPlotW((prev) => (prev === next ? prev : next));
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  // rAF-coalesced pointer scrubbing: the latest pointer sample wins the frame.
  const pointerSample = useRef<ScrubTarget | null>(null);
  const frame = useRef<number | null>(null);
  const scheduleScrub = useCallback(
    (target: ScrubTarget | null) => {
      if (!target) return;
      pointerSample.current = target;
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

  if (series.length === 0) return null;

  const states = series.map((intent) => ({ intent, state: trends.get(intent.id) }));
  const pending = states.filter((s) => !s.state || s.state.status === 'pending');
  const failed = states.filter((s) => s.state?.status === 'error');
  const ready: ReadySeries[] = states.flatMap(({ intent, state }) =>
    state?.status === 'ready' ? [{ intent, trend: state.trend }] : [],
  );

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
        {failed.map((f) => f.intent.label).join(', ')}: query failed
      </p>
    ) : null;
  }

  // Geometry is identical across series (same snapshot, selection, bins) —
  // take it from the first ready result.
  const geo = ready[0]!.trend;
  const docs = geo.order;
  // Presentation titles come from the project's document metadata — doc ids
  // are opaque identity (user projects use UUIDs). Ordinals are reading-order.
  const titleByDoc = new Map((project?.data.docs ?? []).map((d) => [d.doc, d.meta.title]));
  const titles = docs.map((doc) => titleByDoc.get(doc) ?? doc);
  const bins = docs.length === 0 ? 0 : geo.binIndex.length / docs.length;
  // The store always requests declared-sequence coordinates, so the kernel
  // always returns sequenceBases — a null here is an invariant violation, and
  // the old ad-hoc fallback (d * count[d]) was NOT a prefix sum and would have
  // silently mislaid every x-position had it ever run.
  if (!geo.sequenceBases) throw new Error('trend result missing sequenceBases (declared-sequence is the only requested coordinate)');
  const bases = geo.sequenceBases;
  const layout: SequenceLayout = {
    bases,
    tokenCounts: geo.docTokenCount,
    totalTokens:
      docs.length === 0
        ? 0
        : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0),
  };
  const maxRate = Math.max(
    1e-9,
    ...ready.map((r) => Math.max(...Array.from(r.trend.ratePer10k))),
  );
  const strokeFor = (id: string) => (id === focusedSeries ? 2.5 : 1.5);

  // Chapter boundary rules (opt-in): the top-level chapter starts of the ONE
  // focused document, marked within its span only — parent-root topology, no
  // barcode of deeper headings, no per-section recomputation. Only used when
  // the outline result echoes the currently-focused doc and it is on the axis.
  const focusedDocOrdinal = focusedDoc ? docs.indexOf(focusedDoc) : -1;
  const boundaryTokens =
    sectionMarks &&
    focusedDocOrdinal >= 0 &&
    structure?.doc === focusedDoc &&
    structure.state.status === 'ready'
      ? topLevelBoundaryTokens(structure.state.result.rows)
      : [];
  const seriesMarks = boundaryTokens.map((t) =>
    seriesXFromTokenEdge(focusedDocOrdinal, t, plotW, layout),
  );
  const byBookMarks = boundaryTokens.map((t) =>
    bookXFromTokenEdge(t, plotW, geo.docTokenCount[focusedDocOrdinal] ?? 0),
  );

  const scrubDocOrdinal = scrub ? docs.indexOf(scrub.doc) : -1;
  const scrubX =
    scrub && scrubDocOrdinal >= 0
      ? trendView === 'series'
        ? seriesXFromToken(scrubDocOrdinal, scrub.token, plotW, layout)
        : bookXFromToken(scrub.token, plotW, geo.docTokenCount[scrubDocOrdinal] ?? 0)
      : null;

  const targetFromPointer = (px: number, py: number): ScrubTarget | null => {
    const hit =
      trendView === 'series'
        ? pointerTargetSeries(px, py, plotW, SERIES_HEIGHT, layout)
        : pointerTargetByBook(px, py, plotW, ROW_HEIGHT, ROW_GAP, geo.docTokenCount);
    return hit ? { doc: docs[hit.d]!, token: hit.token } : null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const current: ScrubTarget =
      scrub && scrubDocOrdinal >= 0
        ? scrub
        : { doc: docs.find((_, d) => (geo.docTokenCount[d] ?? 0) > 0) ?? '', token: 0 };
    const d = docs.indexOf(current.doc);
    if (d < 0) return;
    const tc = geo.docTokenCount[d] ?? 0;
    const binWidth = tc === 0 ? 1 : Math.ceil(tc / bins);
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

  // Per-book / corpus exact totals (sums of counts and denominators — never
  // averages of rates).
  const bookCount = (t: NumericTrend, d: number) => {
    let c = 0;
    for (let b = 0; b < bins; b++) c += t.count[d * bins + b] as number;
    return c;
  };
  const bookTokens = (d: number) => {
    let n = 0;
    for (let b = 0; b < bins; b++) n += geo.binTokens[d * bins + b] as number;
    return n;
  };
  const totalTokens = docs.reduce((s, _, d) => s + bookTokens(d), 0);

  const methodLine = `rate per 10k tokens · ${bins} equal-token bins per book · unsmoothed · books token-proportional in declared order`;

  const passageServes =
    scrub !== null &&
    passage !== null &&
    passage.doc === scrub.doc &&
    scrub.token >= passage.tokens.start &&
    scrub.token < passage.tokens.end;
  const scrubTitle = scrub ? titleByDoc.get(scrub.doc) ?? scrub.doc : '';
  const scrubCaption = scrub && scrubDocOrdinal >= 0
    ? `${scrubTitle} · token ${(scrub.token + 1).toLocaleString()} of ${(geo.docTokenCount[scrubDocOrdinal] ?? 0).toLocaleString()}`
    : '';

  return (
    <section>
      <h2
        style={{
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 400,
          color: 'var(--fg-muted)',
          margin: '0 0 var(--space-2)',
        }}
      >
        {methodLine}
        {failed.length > 0 && (
          <span style={{ color: 'var(--accent-text)' }}>
            {' '}· failed: {failed.map((f) => f.intent.label).join(', ')}
          </span>
        )}
      </h2>
      <div
        ref={setContainerEl}
        role="slider"
        tabIndex={0}
        aria-label="Reading position scrubber"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, layout.totalTokens - 1)}
        aria-valuenow={
          scrub && scrubDocOrdinal >= 0 ? (bases[scrubDocOrdinal] ?? 0) + scrub.token : 0
        }
        aria-valuetext={scrubCaption || 'no position'}
        onKeyDown={onKeyDown}
        style={{ width: '100%', outline: 'none' }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          scheduleScrub(targetFromPointer(e.clientX - rect.left, e.clientY - rect.top));
        }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          scheduleScrub(targetFromPointer(e.clientX - rect.left, e.clientY - rect.top));
        }}
      >
        {trendView === 'series' ? (
          <SeriesView
            ready={ready}
            docs={docs}
            titles={titles}
            bins={bins}
            bases={bases}
            maxRate={maxRate}
            plotW={plotW}
            scrubX={scrubX}
            sectionMarks={seriesMarks}
            strokeFor={strokeFor}
            onFocus={setFocus}
          />
        ) : (
          <ByBookView
            ready={ready}
            docs={docs}
            titles={titles}
            bins={bins}
            maxRate={maxRate}
            plotW={plotW}
            scrubX={scrubX}
            scrubDocOrdinal={scrubDocOrdinal}
            sectionMarks={byBookMarks}
            sectionMarkDoc={focusedDocOrdinal}
            strokeFor={strokeFor}
            onFocus={setFocus}
          />
        )}
        {scrub && passageServes && scrubX !== null ? (
          <PassageLine
            passage={passage}
            token={scrub.token}
            crosshairX={scrubX}
            series={series}
            focusedSeries={focusedSeries}
            caption={scrubCaption}
          />
        ) : scrub ? (
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--fg-muted)',
              minHeight: '3.2em',
              margin: 'var(--space-2) 0 0',
            }}
          >
            {scrubCaption} · loading text…
          </p>
        ) : (
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--fg-muted)',
              minHeight: '3.2em',
              margin: 'var(--space-2) 0 0',
            }}
          >
            hover or focus the chart to read the text at any position — arrows step by
            token, shift+arrows by 5, PageUp/Down by bin
          </p>
        )}
      </div>
      <table
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          borderCollapse: 'collapse',
          marginTop: 'var(--space-3)',
        }}
      >
        <caption style={{ textAlign: 'left', color: 'var(--fg-muted)', paddingBottom: 'var(--space-1)' }}>
          Exact totals by book (count · rate per 10k tokens)
        </caption>
        <thead>
          <tr style={{ color: 'var(--fg-muted)' }}>
            <th scope="col" style={{ textAlign: 'left', fontWeight: 400 }}>book</th>
            <th scope="col" style={{ textAlign: 'right', fontWeight: 400, padding: '0 1ch' }}>tokens</th>
            {ready.map((r) => (
              <th key={r.intent.id} scope="col" colSpan={2} style={{ textAlign: 'right', fontWeight: 400, padding: '0 1ch' }}>
                {r.intent.label}
              </th>
            ))}
          </tr>
          <tr style={{ color: 'var(--fg-muted)' }}>
            <th aria-hidden="true" />
            <th aria-hidden="true" />
            {ready.map((r) => (
              <SubHeads key={r.intent.id} />
            ))}
          </tr>
        </thead>
        <tbody>
          {docs.map((doc, d) => {
            const title = titles[d] ?? doc;
            const tokens = bookTokens(d);
            return (
              <tr key={doc} style={{ borderTop: '1px solid var(--rule)' }}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 400, paddingRight: '1ch', whiteSpace: 'nowrap' }}>
                  {`${d + 1} · ${title}`}
                </th>
                <td style={{ textAlign: 'right', padding: '0 1ch', color: 'var(--fg-muted)' }}>
                  {tokens.toLocaleString()}
                </td>
                {ready.map((r) => {
                  const c = bookCount(r.trend, d);
                  return (
                    <Cells key={r.intent.id} count={c} rate={tokens === 0 ? 0 : (c / tokens) * 10_000} />
                  );
                })}
              </tr>
            );
          })}
          <tr style={{ borderTop: '1px solid var(--rule-strong)' }}>
            <th scope="row" style={{ textAlign: 'left', fontWeight: 400, paddingRight: '1ch' }}>corpus</th>
            <td style={{ textAlign: 'right', padding: '0 1ch', color: 'var(--fg-muted)' }}>
              {totalTokens.toLocaleString()}
            </td>
            {ready.map((r) => {
              const c = docs.reduce((s, _, d) => s + bookCount(r.trend, d), 0);
              return (
                <Cells key={r.intent.id} count={c} rate={totalTokens === 0 ? 0 : (c / totalTokens) * 10_000} />
              );
            })}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function SubHeads() {
  return (
    <>
      <th scope="col" style={{ textAlign: 'right', fontWeight: 400, padding: '0 0 0 1ch' }}>n</th>
      <th scope="col" style={{ textAlign: 'right', fontWeight: 400, padding: '0 1ch 0 0.5ch' }}>/10k</th>
    </>
  );
}

function Cells({ count, rate }: { count: number; rate: number }) {
  return (
    <>
      <td style={{ textAlign: 'right', padding: '0 0 0 1ch' }}>{count}</td>
      <td style={{ textAlign: 'right', padding: '0 1ch 0 0.5ch' }}>{rate.toFixed(1)}</td>
    </>
  );
}

function SeriesView({
  ready,
  docs,
  titles,
  bins,
  bases,
  maxRate,
  plotW,
  scrubX,
  sectionMarks,
  strokeFor,
  onFocus,
}: {
  ready: readonly ReadySeries[];
  docs: readonly string[];
  titles: readonly string[];
  bins: number;
  bases: readonly number[];
  maxRate: number;
  plotW: number;
  scrubX: number | null;
  sectionMarks: readonly number[];
  strokeFor: (id: string) => number;
  onFocus: (id: string) => void;
}) {
  const geo = ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = scaleLinear([0, Math.max(1, totalTokens)], [0, plotW]);
  const y = scaleLinear([0, maxRate], [SERIES_HEIGHT, TOP_PAD]);
  const axisY = SERIES_HEIGHT;
  const height = SERIES_HEIGHT + 34;

  // One path segment per (series, doc) — the break at every boundary is
  // mandatory; connecting them would invent data.
  const pointX = (d: number, b: number) => {
    const tokens = geo.docTokenCount[d] ?? 0;
    const { start, end } = binSpan(tokens, bins, b);
    return x((bases[d] ?? 0) + (start + end) / 2);
  };

  const endPoints = ready.map((r) => {
    const d = docs.length - 1;
    const lastRate = d < 0 ? 0 : (r.trend.ratePer10k[d * bins + (bins - 1)] as number);
    return y(lastRate);
  });
  const labelY = spreadLabels(endPoints, TOP_PAD + 4, SERIES_HEIGHT - 2, MIN_LABEL_GAP);

  return (
    <svg
      width={plotW + LABEL_SPACE}
      height={height}
      role="img"
      aria-label={`Rates of ${ready.map((r) => r.intent.label).join(', ')} across ${docs.length} books in reading order`}
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
            <text
              x={(x0 + x1) / 2}
              y={axisY + 14}
              textAnchor="middle"
              fill="var(--fg-muted)"
              fontSize="var(--text-xs)"
              fontFamily="var(--font-mono)"
            >
              {label}
              <title>{title}</title>
            </text>
          </g>
        );
      })}
      {/* y extent, direct-labeled at the max gridline — no axis chrome */}
      <line x1={0} y1={y(maxRate)} x2={plotW} y2={y(maxRate)} stroke="var(--rule)" strokeWidth={1} />
      <text x={0} y={y(maxRate) - 3} fill="var(--fg-muted)" fontSize="var(--text-xs)" fontFamily="var(--font-mono)">
        {maxRate.toFixed(1)}/10k
      </text>
      {ready.map((r) =>
        docs.map((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          const path = Array.from({ length: bins }, (_, b) => {
            const rate = r.trend.ratePer10k[d * bins + b] as number;
            // Keep the visual boundary silence (gap applies only when the
            // span can contain it — narrow/empty books collapse safely).
            const clamped = clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP);
            return `${b === 0 ? 'M' : 'L'}${clamped.toFixed(1)},${y(rate).toFixed(1)}`;
          }).join(' ');
          return (
            <path
              key={`${r.intent.id}:${doc}`}
              d={path}
              fill="none"
              stroke={slotColor(r.intent.styleSlot)}
              strokeWidth={strokeFor(r.intent.id)}
              strokeDasharray={slotDash(r.intent.styleSlot)}
              strokeLinecap={slotDash(r.intent.styleSlot) === '1 3' ? 'round' : 'butt'}
              style={{ cursor: 'pointer' }}
              onClick={() => onFocus(r.intent.id)}
            />
          );
        }),
      )}
      {/* Direct end labels, collision-spread, foreground text + colored leader */}
      {ready.map((r, i) => (
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
            style={{ cursor: 'pointer' }}
            onClick={() => onFocus(r.intent.id)}
          >
            {r.intent.label}
          </text>
        </g>
      ))}
      {/* Chapter boundary rules for the focused document (opt-in, top-level
          only) — dashed and behind the scrubber so the reading cursor stays
          legible. */}
      {sectionMarks.map((mx, i) => (
        <line
          key={`chapter-${i}`}
          x1={mx}
          y1={TOP_PAD}
          x2={mx}
          y2={axisY}
          stroke="var(--rule-strong)"
          strokeWidth={1}
          strokeDasharray="2 3"
          pointerEvents="none"
        />
      ))}
      {scrubX !== null && (
        <line
          x1={scrubX}
          y1={TOP_PAD}
          x2={scrubX}
          y2={axisY}
          stroke="var(--fg-muted)"
          strokeWidth={1}
          pointerEvents="none"
        />
      )}
      {/* Hover layer: one column per (book, bin) reporting every series */}
      {docs.map((doc, d) =>
        Array.from({ length: bins }, (_, b) => {
          const tokens = geo.docTokenCount[d] ?? 0;
          const { start, end } = binSpan(tokens, bins, b);
          const x0 = x((bases[d] ?? 0) + start);
          const w = Math.max(1, x((bases[d] ?? 0) + end) - x0);
          const title = titles[d] ?? doc;
          const lines = ready
            .map((r) => {
              const iRow = d * bins + b;
              return `${r.intent.label}: ${r.trend.count[iRow]}× (${(r.trend.ratePer10k[iRow] as number).toFixed(1)}/10k)`;
            })
            .join('\n');
          return (
            <rect key={`${doc}:${b}`} x={x0} y={0} width={w} height={axisY} fill="transparent">
              <title>{`${title}, bin ${b + 1}/${bins}\n${lines}`}</title>
            </rect>
          );
        }),
      )}
    </svg>
  );
}

function ByBookView({
  ready,
  docs,
  titles,
  bins,
  maxRate,
  plotW,
  scrubX,
  scrubDocOrdinal,
  sectionMarks,
  sectionMarkDoc,
  strokeFor,
  onFocus,
}: {
  ready: readonly ReadySeries[];
  docs: readonly string[];
  titles: readonly string[];
  bins: number;
  maxRate: number;
  plotW: number;
  scrubX: number | null;
  scrubDocOrdinal: number;
  sectionMarks: readonly number[];
  sectionMarkDoc: number;
  strokeFor: (id: string) => number;
  onFocus: (id: string) => void;
}) {
  const x = scaleLinear([0, bins], [0, plotW]);
  const y = scaleLinear([0, maxRate], [ROW_HEIGHT, 0]);
  const height = docs.length * (ROW_HEIGHT + ROW_GAP) + 4;

  return (
    <svg
      width={plotW + LABEL_SPACE}
      height={height}
      role="img"
      aria-label={`Rates of ${ready.map((r) => r.intent.label).join(', ')} within each of ${docs.length} books`}
    >
      {docs.map((doc, d) => {
        const rowY = d * (ROW_HEIGHT + ROW_GAP);
        const title = titles[d] ?? doc;
        return (
          <g key={doc}>
            <line x1={0} y1={rowY + ROW_HEIGHT} x2={plotW} y2={rowY + ROW_HEIGHT} stroke="var(--rule)" strokeWidth={1} />
            {ready.map((r) => {
              const path = Array.from({ length: bins }, (_, b) => {
                const rate = r.trend.ratePer10k[d * bins + b] as number;
                return `${b === 0 ? 'M' : 'L'}${x(b + 0.5).toFixed(1)},${(rowY + y(rate)).toFixed(1)}`;
              }).join(' ');
              return (
                <path
                  key={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={slotColor(r.intent.styleSlot)}
                  strokeWidth={strokeFor(r.intent.id)}
                  strokeDasharray={slotDash(r.intent.styleSlot)}
                  strokeLinecap={slotDash(r.intent.styleSlot) === '1 3' ? 'round' : 'butt'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onFocus(r.intent.id)}
                />
              );
            })}
            {sectionMarkDoc === d &&
              sectionMarks.map((mx, i) => (
                <line
                  key={`chapter-${i}`}
                  x1={mx}
                  y1={rowY}
                  x2={mx}
                  y2={rowY + ROW_HEIGHT}
                  stroke="var(--rule-strong)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  pointerEvents="none"
                />
              ))}
            {scrubX !== null && scrubDocOrdinal === d && (
              <line
                x1={scrubX}
                y1={rowY}
                x2={scrubX}
                y2={rowY + ROW_HEIGHT}
                stroke="var(--fg-muted)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
            <text
              x={plotW + 6}
              y={rowY + ROW_HEIGHT - 2}
              fill="var(--fg)"
              fontSize="var(--text-xs)"
              fontFamily="var(--font-mono)"
            >
              {`${d + 1} · `}{title.slice(0, 16)}
              <title>{title}</title>
            </text>
            {Array.from({ length: bins }, (_, b) => {
              const lines = ready
                .map((r) => {
                  const iRow = d * bins + b;
                  return `${r.intent.label}: ${r.trend.count[iRow]}× (${(r.trend.ratePer10k[iRow] as number).toFixed(1)}/10k)`;
                })
                .join('\n');
              return (
                <rect
                  key={b}
                  x={x(b)}
                  y={rowY}
                  width={Math.max(1, x(1) - x(0))}
                  height={ROW_HEIGHT}
                  fill="transparent"
                >
                  <title>{`${title}, bin ${b + 1}/${bins}\n${lines}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
