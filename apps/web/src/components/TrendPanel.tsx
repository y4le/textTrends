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

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { BarcodeStrip } from './BarcodeStrip.tsx';
import { slotColor, slotDash } from '../lib/series-style.ts';
import {
  binSpan,
  bookXFromToken,
  bookXFromTokenEdge,
  clampRangeHeadToOrigin,
  clampToSpan,
  linearMap,
  pointerTargetByBook,
  pointerTargetSeries,
  selectedTrendPathData,
  seriesXFromToken,
  seriesTokenFromX,
  seriesXFromTokenEdge,
  spreadLabels,
  stepAlongSequence,
  TREND_LABEL_SPACE,
  type SequenceLayout,
} from '../lib/trend-geometry.ts';
import type { ScrubTarget, SeriesIntent } from '../lib/store.ts';
import { topLevelBoundaryTokens } from '../lib/structure-view.ts';
import { recordChartCommit } from '../lib/e2e-probe.ts';
import { PassageLine } from './PassageLine.tsx';
import { commitRange } from '../lib/selection.ts';

const SERIES_HEIGHT = 180;
const TOP_PAD = 14; // room for the y-max direct label above the plot
const ROW_HEIGHT = 44;
const ROW_GAP = 22;
const LABEL_SPACE = TREND_LABEL_SPACE;
const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
const MIN_LABEL_GAP = 12;

interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
}

interface RangePreview {
  readonly mode: 'pointer' | 'keyboard';
  readonly origin: ScrubTarget;
  readonly head: ScrubTarget;
}

export function TrendPanel() {
  // Deliberately NO `scrub`/`passage` subscription here: those update once per
  // pointer animation frame, and this component's render rebuilds every path,
  // hover rect, label, and totals row. The ScrubSurface child owns the
  // per-frame state; this panel re-renders only on data/view/focus/resize
  // changes (the Phase B ruling's invariant).
  const series = useApp((s) => s.series);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const trends = useApp((s) => s.trends);
  const selectedTrends = useApp((s) => s.selectedTrends);
  const trendView = useApp((s) => s.trendView);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const structure = useApp((s) => s.structure);
  const sectionMarks = useApp((s) => s.sectionMarks);

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
      const next = Math.max(1, Math.round(width) - LABEL_SPACE);
      setPlotW((prev) => (prev === next ? prev : next));
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  if (series.length === 0) return null;

  const states = series.map((intent) => ({ intent, state: trends.get(intent.id) }));
  const pending = states.filter((s) => !s.state || s.state.status === 'pending');
  const failed = states.filter((s) => s.state?.status === 'error');
  const ready: ReadySeries[] = states.flatMap(({ intent, state }) =>
    state?.status === 'ready' ? [{ intent, trend: state.trend }] : [],
  );
  const selectedReady: ReadySeries[] = series.flatMap((intent) => {
    const state = selectedTrends.get(intent.id);
    return state?.status === 'ready' ? [{ intent, trend: state.trend }] : [];
  });

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
    ...selectedReady.map((r) => {
      let max = 0;
      for (let i = 0; i < r.trend.ratePer10k.length; i++) {
        if ((r.trend.binTokens[i] as number) > 0) {
          max = Math.max(max, r.trend.ratePer10k[i] as number);
        }
      }
      return max;
    }),
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
      <ScrubSurface
        containerRef={setContainerEl}
        trendView={trendView}
        docs={docs}
        titleByDoc={titleByDoc}
        layout={layout}
        bins={bins}
        plotW={plotW}
        series={series}
        focusedSeries={focusedSeries}
      >
        {trendView === 'series' ? (
          <SeriesView
            ready={ready}
            selected={selectedReady}
            docs={docs}
            titles={titles}
            bins={bins}
            bases={bases}
            maxRate={maxRate}
            plotW={plotW}
            sectionMarks={seriesMarks}
            strokeFor={strokeFor}
          />
        ) : (
          <ByBookView
            ready={ready}
            selected={selectedReady}
            docs={docs}
            titles={titles}
            bins={bins}
            maxRate={maxRate}
            plotW={plotW}
            sectionMarks={byBookMarks}
            sectionMarkDoc={focusedDocOrdinal}
            strokeFor={strokeFor}
          />
        )}
      </ScrubSurface>
      {/* The dispersion barcode: every occurrence (or an honest density
          cell) on the SAME concatenated reading-order axis as the series
          view — present in both layouts; in by-book mode it reads as the
          corpus summary strip. Resident-data redraws only (ruling §D). */}
      <BarcodeStrip
        docs={docs}
        edgeX={(d, t) => seriesXFromTokenEdge(d, t, plotW, layout)}
        xToDocToken={(px) => seriesTokenFromX(px, plotW, layout)}
        width={plotW}
        slotOf={(id) => series.find((s) => s.id === id)?.styleSlot ?? 0}
        labelOf={(id) => series.find((s) => s.id === id)?.label ?? id}
        focusedSeries={focusedSeries}
        axisLabel="occurrences · corpus reading order"
        seriesOrder={series.map((s) => s.id)}
      />
      <div
        className="horizontal-data-port"
        role="region"
        tabIndex={0}
        aria-label="Scrollable exact totals table"
      >
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
      </div>
    </section>
  );
}

/**
 * The per-frame half of the trend panel: the ONLY component that subscribes
 * to `scrub`/`passage` (which update once per pointer animation frame). It
 * owns the slider container (pointer + keyboard + ARIA), the moving chart
 * cursor — an absolutely-positioned overlay div, NOT an SVG line, so cursor
 * motion never re-renders the chart — and the passage/caption/hint area.
 *
 * The chart SVG arrives as `children`, created by the non-rendering outer
 * panel, so every scrub-frame render here hands React the SAME element and
 * the chart subtree is skipped entirely. The load-bearing invariant is
 * "TrendPanel does not subscribe to scrub/passage and its child element is
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
  bins,
  plotW,
  series,
  focusedSeries,
  children,
}: {
  containerRef: (el: HTMLDivElement | null) => void;
  trendView: 'series' | 'by-book';
  docs: readonly string[];
  titleByDoc: ReadonlyMap<string, string>;
  layout: SequenceLayout;
  bins: number;
  plotW: number;
  series: readonly SeriesIntent[];
  focusedSeries: string | null;
  children: React.ReactNode;
}) {
  const scrub = useApp((s) => s.scrub);
  const passage = useApp((s) => s.passage);
  const setScrub = useApp((s) => s.setScrub);
  const pinPassage = useApp((s) => s.pinPassage);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const openReader = useApp((s) => s.openReader);
  const [preview, setPreview] = useState<RangePreview | null>(null);

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

  const docTokenCount = layout.tokenCounts;
  const scrubDocOrdinal = scrub ? docs.indexOf(scrub.doc) : -1;
  const scrubX =
    scrub && scrubDocOrdinal >= 0
      ? trendView === 'series'
        ? seriesXFromToken(scrubDocOrdinal, scrub.token, plotW, layout)
        : bookXFromToken(scrub.token, plotW, docTokenCount[scrubDocOrdinal] ?? 0)
      : null;

  const targetFromPointer = (px: number, py: number): ScrubTarget | null => {
    const hit =
      trendView === 'series'
        ? pointerTargetSeries(px, py, plotW, SERIES_HEIGHT, layout)
        : pointerTargetByBook(px, py, plotW, ROW_HEIGHT, ROW_GAP, docTokenCount);
    return hit ? { doc: docs[hit.d]!, token: hit.token } : null;
  };

  const commitPreview = (range: RangePreview) => {
    const d = docs.indexOf(range.origin.doc);
    const selection = snapshot
      ? commitRange(
          snapshot.snapshot,
          range.origin.doc,
          range.origin.token,
          range.head.token,
          docTokenCount[d] ?? 0,
        )
      : null;
    if (selection) setLinkedSelection(selection);
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
    if ((e.key === 'p' || e.key === 'P') && preview === null) {
      if (scrub && scrubDocOrdinal >= 0) {
        e.preventDefault();
        pinPassage(scrub.doc, scrub.token);
      }
      return;
    }
    if ((e.key === 's' || e.key === 'S') && preview === null) {
      if (scrub && scrubDocOrdinal >= 0) {
        e.preventDefault();
        setPreview({ mode: 'keyboard', origin: scrub, head: scrub });
      }
      return;
    }
    if (preview?.mode === 'keyboard') {
      const d = docs.indexOf(preview.origin.doc);
      const count = docTokenCount[d] ?? 0;
      let head = preview.head.token;
      switch (e.key) {
        case 'ArrowLeft': head--; break;
        case 'ArrowRight': head++; break;
        case 'Home': head = 0; break;
        case 'End': head = count - 1; break;
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
        head: { doc: preview.origin.doc, token: Math.max(0, Math.min(count - 1, head)) },
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

  const passageServes =
    scrub !== null &&
    passage !== null &&
    snapshot !== null &&
    passage.snapshot === snapshot.snapshot &&
    passage.result.doc === scrub.doc &&
    scrub.token >= passage.result.tokens.start &&
    scrub.token < passage.result.tokens.end;
  const scrubTitle = scrub ? titleByDoc.get(scrub.doc) ?? scrub.doc : '';
  const scrubCaption = scrub && scrubDocOrdinal >= 0
    ? `${scrubTitle} · token ${(scrub.token + 1).toLocaleString()} of ${(docTokenCount[scrubDocOrdinal] ?? 0).toLocaleString()}`
    : '';

  // Cursor geometry per the Phase B ruling: series spans TOP_PAD..SERIES_HEIGHT;
  // by-book covers only the scrubbed row. transform (not left/top mutation)
  // so frame-to-frame motion is a compositor-friendly update.
  const cursorTop = trendView === 'series' ? TOP_PAD : scrubDocOrdinal * (ROW_HEIGHT + ROW_GAP);
  const cursorHeight = trendView === 'series' ? SERIES_HEIGHT - TOP_PAD : ROW_HEIGHT;

  const shownRange = preview
    ? {
        doc: preview.origin.doc,
        tokens: {
          start: Math.min(preview.origin.token, preview.head.token),
          end: Math.max(preview.origin.token, preview.head.token) + 1,
        },
      }
    : linkedSelection;
  const rangeDocOrdinal = shownRange ? docs.indexOf(shownRange.doc) : -1;
  const rangeBox = shownRange && rangeDocOrdinal >= 0
    ? trendView === 'series'
      ? {
          left: seriesXFromTokenEdge(rangeDocOrdinal, shownRange.tokens.start, plotW, layout),
          right: seriesXFromTokenEdge(rangeDocOrdinal, shownRange.tokens.end, plotW, layout),
          top: TOP_PAD,
          height: SERIES_HEIGHT - TOP_PAD,
        }
      : {
          left: bookXFromTokenEdge(
            shownRange.tokens.start,
            plotW,
            docTokenCount[rangeDocOrdinal] ?? 0,
          ),
          right: bookXFromTokenEdge(
            shownRange.tokens.end,
            plotW,
            docTokenCount[rangeDocOrdinal] ?? 0,
          ),
          top: rangeDocOrdinal * (ROW_HEIGHT + ROW_GAP),
          height: ROW_HEIGHT,
        }
    : null;
  const rangeStatus = preview
    ? `Selecting ${titleByDoc.get(preview.origin.doc) ?? preview.origin.doc}, tokens ${Math.min(preview.origin.token, preview.head.token) + 1}–${Math.max(preview.origin.token, preview.head.token) + 1}`
    : linkedSelection
      ? `Selected ${(linkedSelection.tokens.end - linkedSelection.tokens.start).toLocaleString()} tokens in ${titleByDoc.get(linkedSelection.doc) ?? linkedSelection.doc}`
      : 'Press S at the reading cursor to select a range';

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <div
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
        style={{ width: '100%', outline: 'none', position: 'relative', touchAction: 'none' }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const target = targetFromPointer(e.clientX - rect.left, e.clientY - rect.top);
          const drag = pointerDrag.current;
          if (drag?.pointerId === e.pointerId) {
            if (!target) return;
            const distance = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
            if (!drag.active && distance >= 4) drag.active = true;
            if (drag.active) {
              drag.head = clampRangeHeadToOrigin(drag.origin, target, docs, docTokenCount);
              setPreview({ mode: 'pointer', origin: drag.origin, head: drag.head });
            }
            return;
          }
          scheduleScrub(target);
        }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const origin = targetFromPointer(e.clientX - rect.left, e.clientY - rect.top);
          if (!origin) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointerDrag.current = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            origin,
            head: origin,
            active: false,
          };
          setPreview(null);
        }}
        onPointerUp={(e) => {
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
            pinPassage(drag.origin.doc, drag.origin.token);
          }
        }}
        onPointerCancel={(e) => {
          if (pointerDrag.current?.pointerId !== e.pointerId) return;
          pointerDrag.current = null;
          setPreview(null);
        }}
      >
        {children}
        {rangeBox && (
          <div
            aria-hidden="true"
            data-testid={preview ? 'selection-preview' : 'linked-selection'}
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
        )}
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
      {scrub && passageServes && scrubX !== null ? (
        <PassageLine
          passage={passage.result}
          token={scrub.token}
          crosshairX={scrubX}
          series={series}
          focusedSeries={focusedSeries}
          caption={scrubCaption}
          onOpenReader={() => {
            if (!snapshot) return;
            openReader({
              snapshot: passage.snapshot,
              doc: scrub.doc,
              token: scrub.token,
              from: 'passage',
            });
          }}
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
          token, shift+arrows by 5, PageUp/Down by bin · press P to pin · press S to select a range
        </p>
      )}
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
    </div>
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
  bins,
  bases,
  maxRate,
  plotW,
  sectionMarks,
  strokeFor,
}: {
  ready: readonly ReadySeries[];
  selected: readonly ReadySeries[];
  docs: readonly string[];
  titles: readonly string[];
  bins: number;
  bases: readonly number[];
  maxRate: number;
  plotW: number;
  sectionMarks: readonly number[];
  strokeFor: (id: string) => number;
}) {
  const geo = ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = linearMap(0, Math.max(1, totalTokens), 0, plotW);
  const y = linearMap(0, maxRate, SERIES_HEIGHT, TOP_PAD);
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
              opacity={selected.length > 0 ? 0.45 : 1}
            />
          );
        }),
      )}
      {selected.flatMap((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            bins,
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
      {/* The moving cursor is NOT here: it is ScrubSurface's overlay div, so
          scrubbing never re-renders this SVG. */}
      {__TT_E2E__ && <ChartCommitProbe view="series" />}
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
});

const ByBookView = memo(function ByBookView({
  ready,
  selected,
  docs,
  titles,
  bins,
  maxRate,
  plotW,
  sectionMarks,
  sectionMarkDoc,
  strokeFor,
}: {
  ready: readonly ReadySeries[];
  selected: readonly ReadySeries[];
  docs: readonly string[];
  titles: readonly string[];
  bins: number;
  maxRate: number;
  plotW: number;
  sectionMarks: readonly number[];
  sectionMarkDoc: number;
  strokeFor: (id: string) => number;
}) {
  const x = linearMap(0, bins, 0, plotW);
  const y = linearMap(0, maxRate, ROW_HEIGHT, 0);
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
                  opacity={selected.length > 0 ? 0.45 : 1}
                />
              );
            })}
            {selected.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                bins,
                (b) => x(b + 0.5),
                (rate) => rowY + y(rate),
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
      {/* Moving cursor lives in ScrubSurface's overlay div, not this SVG. */}
      {__TT_E2E__ && <ChartCommitProbe view="by-book" />}
    </svg>
  );
});
