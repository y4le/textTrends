import { memo, useEffect } from 'react';
import type { WorkspaceTrendMeasureV1 } from '@texttrends/core';
import {
  findSeriesHaloStrokeWidth,
  findSeriesStrokeWidth,
  GHOST_SERIES_OPACITY,
  ghostSeriesStrokeWidth,
  seriesColor,
  seriesDash,
  seriesLinecap,
} from '../../lib/series-style.ts';
import {
  bookXFromTokenEdge,
  barcodeBandExtent,
  clampToSpan,
  linearMap,
  selectedTrendPathData,
  trendBinSpan,
  trendRowsForDoc,
  type TrendLabelBand,
} from '../../lib/trend-geometry.ts';
import { type TrendView } from '../../lib/trend-view.ts';
import { recordChartCommit } from '../../lib/e2e-probe.ts';
import { type TrendGeometry } from '../../lib/trend-compact.ts';
import { formatTrendDisplayValue, trendMeasureUnit } from '../../lib/trend-display.ts';
import type { DisplayedSeries } from '../../lib/trend-chart-view.ts';

const BOUNDARY_GAP = 2; // px of visual silence at each book boundary

function accessibleTrendSeries(ready: readonly DisplayedSeries[]): string {
  const foreground = ready.filter((item) => !item.ghost).map((item) => item.intent.label);
  const context = ready.filter((item) => item.ghost).map((item) => item.intent.label);
  if (context.length === 0) return foreground.join(', ');
  if (foreground.length === 0) {
    return `${context.join(', ')} as de-emphasized context while Find awaits a query`;
  }
  return `Find ${foreground.join(', ')}, with ${context.join(', ')} as de-emphasized context`;
}

/** E2E-only commit counter (dead code in production builds): an effect with no
 *  dependency array fires after EVERY commit of its owning subtree, which is
 *  exactly the "did the chart re-render on scrub?" probe the regression test
 *  needs. Never incremented during render. */
function ChartCommitProbe({ view }: { view: TrendView }) {
  useEffect(() => {
    recordChartCommit(view);
  });
  return null;
}

export const SeriesView = memo(function SeriesView({
  ready,
  selected,
  docs,
  titles,
  bases,
  maxValue,
  dataMaxValue,
  measure,
  plotW,
  strokeFor,
  geometry,
  barcodeHeight,
  labelBands,
}: {
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  bases: readonly number[];
  maxValue: number;
  dataMaxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  barcodeHeight: number;
  labelBands: readonly TrendLabelBand[];
}) {
  const foregroundReady = ready.filter((item) => !item.ghost);
  const rawReady = foregroundReady.length > 0 ? foregroundReady : ready;
  const hasGhostContext = ready.some((item) => item.ghost);
  const geo = foregroundReady[0]?.trend ?? ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = linearMap(0, Math.max(1, totalTokens), 0, plotW);
  const y = linearMap(0, maxValue, geometry.seriesHeight, geometry.topPad);
  const axisY = geometry.seriesHeight;
  const barcodeBottom = axisY + barcodeBandExtent(geometry.barcodeBandGap, barcodeHeight);
  const height = labelBands[0]
    ? labelBands[0].top + labelBands[0].height
    : barcodeBottom + 8;

  // One path segment per (series, doc) — the break at every boundary is
  // mandatory; connecting them would invent data.
  const pointX = (d: number, b: number) => {
    const { start, end } = trendBinSpan(geo, d, b);
    return x((bases[d] ?? 0) + (start + end) / 2);
  };
  const spanX = (d: number, b: number) => {
    const { start, end } = trendBinSpan(geo, d, b);
    const x0 = x(bases[d] ?? 0);
    const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
    return {
      start: clampToSpan(
        x((bases[d] ?? 0) + start),
        x0,
        x1,
        d > 0 ? BOUNDARY_GAP : 0,
        BOUNDARY_GAP,
      ),
      end: clampToSpan(
        x((bases[d] ?? 0) + end),
        x0,
        x1,
        d > 0 ? BOUNDARY_GAP : 0,
        BOUNDARY_GAP,
      ),
    };
  };

  return (
    <svg
      data-trend-view="series"
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${accessibleTrendSeries(ready)} across ${docs.length} texts in reading order`}
    >
      <line
        data-trend-axis="series"
        x1={0}
        y1={axisY}
        x2={plotW}
        y2={axisY}
        stroke="var(--rule-strong)"
        strokeWidth={1}
      />
      {docs.map((doc, d) => {
        const band = labelBands[d];
        const x0 = band?.left ?? x(bases[d] ?? 0);
        const x1 = band?.right ?? x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
        const title = titles[d] ?? doc;
        const n = String(d + 1);
        const label = (x1 - x0) > 7 * (title.length + 4) ? `${n} · ${title}` : n;
        return (
          <g key={doc}>
            {d > 0 && (
              <line x1={x0} y1={0} x2={x0} y2={axisY} stroke="var(--rule)" strokeWidth={1} />
            )}
            {band && (
              <text
                data-trend-row-title={d}
                x={(x0 + x1) / 2}
                y={band.top + 14}
                textAnchor="middle"
                fill="var(--fg-muted)"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-mono)"
                aria-hidden="true"
              >
                {label}
                <title>{title}</title>
              </text>
            )}
          </g>
        );
      })}
      {/* The direct-labeled y extent helps compare a combined multi-book
          sequence. With one text it is redundant chrome above the graph. */}
      {docs.length > 1 && (
        <g data-trend-y-extent>
          <line x1={0} y1={y(maxValue)} x2={plotW} y2={y(maxValue)} stroke="var(--rule)" strokeWidth={1} />
          <text x={0} y={y(maxValue) - 3} fill="var(--fg-muted)" fontSize="var(--text-xs)" fontFamily="var(--font-mono)">
            {formatTrendDisplayValue(dataMaxValue, measure)}{trendMeasureUnit(measure)}
          </text>
        </g>
      )}
      {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && rawReady.flatMap((r) =>
        docs.flatMap((doc, d) => {
          const x0 = x(bases[d] ?? 0);
          const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
          return selectedTrendPathData(
            r.trend,
            doc,
            r.rawValues,
            (b) => clampToSpan(pointX(d, b), x0, x1, d > 0 ? BOUNDARY_GAP : 0, BOUNDARY_GAP),
            y,
            (b) => spanX(d, b),
          ).map((path, index) => (
            <path
              key={`raw:${r.intent.id}:${doc}:${index}`}
              data-raw-series-path={r.intent.id}
              d={path}
              fill="none"
              stroke={seriesColor(r.intent.style)}
              strokeWidth={1}
              strokeDasharray={seriesDash(r.intent.style)}
              opacity={r.ghost ? 0.1 : 0.2}
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
            (b) => spanX(d, b),
          ).map((path, index) => (
            <g key={`${r.intent.id}:${doc}:${index}`}>
              {!r.ghost && hasGhostContext && (
                <path
                  data-series-find-halo={r.intent.id}
                  d={path}
                  fill="none"
                  stroke="var(--bg)"
                  strokeWidth={findSeriesHaloStrokeWidth(strokeFor(r.intent.id))}
                  strokeDasharray={seriesDash(r.intent.style)}
                  strokeLinecap={seriesLinecap(r.intent.style)}
                  opacity={0.92}
                  pointerEvents="none"
                />
              )}
              <path
                data-series-path={r.intent.id}
                data-series-ghost={r.ghost || undefined}
                data-series-find-foreground={!r.ghost && hasGhostContext || undefined}
                d={path}
                fill="none"
                stroke={seriesColor(r.intent.style)}
                strokeWidth={r.ghost
                  ? ghostSeriesStrokeWidth(strokeFor(r.intent.id))
                  : hasGhostContext
                    ? findSeriesStrokeWidth(strokeFor(r.intent.id))
                    : strokeFor(r.intent.id)}
                strokeDasharray={seriesDash(r.intent.style)}
                strokeLinecap={seriesLinecap(r.intent.style)}
                opacity={r.ghost ? GHOST_SERIES_OPACITY : selected.length > 0 ? 0.45 : 1}
                pointerEvents={r.ghost ? 'none' : undefined}
              />
            </g>
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
            (b) => spanX(d, b),
          ).map((path, i) => (
            <path
              key={`selected:${r.intent.id}:${doc}:${i}`}
              data-selected-overlay={r.intent.id}
              d={path}
              fill="none"
              stroke={seriesColor(r.intent.style)}
              strokeWidth={strokeFor(r.intent.id) + 1.5}
              strokeDasharray={seriesDash(r.intent.style)}
              strokeLinecap="round"
              pointerEvents="none"
            />
          ));
        }),
      )}
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
          const lines = foregroundReady
            .map((r) => {
              const iRow = rows.start + b;
              const displayed = r.values[iRow];
              const formatted = displayed !== undefined && Number.isFinite(displayed)
                ? `${formatTrendDisplayValue(displayed, measure)}${trendMeasureUnit(measure)}`
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

export const ByBookView = memo(function ByBookView({
  view,
  ready,
  selected,
  docs,
  titles,
  maxValue,
  measure,
  plotW,
  strokeFor,
  geometry,
  labelBands,
  rowPitch,
  rowDomain,
}: {
  view: Exclude<TrendView, 'series'>;
  ready: readonly DisplayedSeries[];
  selected: readonly DisplayedSeries[];
  docs: readonly string[];
  titles: readonly string[];
  maxValue: number;
  measure: WorkspaceTrendMeasureV1;
  plotW: number;
  strokeFor: (id: string) => number;
  geometry: TrendGeometry;
  labelBands: readonly TrendLabelBand[];
  rowPitch: number;
  rowDomain: readonly number[];
}) {
  const foregroundReady = ready.filter((item) => !item.ghost);
  const rawReady = foregroundReady.length > 0 ? foregroundReady : ready;
  const hasGhostContext = ready.some((item) => item.ghost);
  const geo = foregroundReady[0]?.trend ?? ready[0]!.trend;
  const y = linearMap(0, maxValue, geometry.rowHeight, 0);
  const height = docs.length * rowPitch + 4;
  const pointX = (d: number, b: number) => {
    const span = trendBinSpan(geo, d, b);
    return bookXFromTokenEdge((span.start + span.end) / 2, plotW, rowDomain[d] ?? 0);
  };
  const spanX = (d: number, b: number) => {
    const span = trendBinSpan(geo, d, b);
    const domain = rowDomain[d] ?? 0;
    return {
      start: bookXFromTokenEdge(span.start, plotW, domain),
      end: bookXFromTokenEdge(span.end, plotW, domain),
    };
  };

  return (
    <svg
      data-trend-view={view}
      width={plotW}
      height={height}
      role="img"
      aria-label={`${measure.kind === 'count' ? 'Counts' : 'Rates'} of ${accessibleTrendSeries(ready)} within each of ${docs.length} texts${view === 'by-book-scaled' ? '; shared token scale, shorter texts end early' : '; each text fills an equal-width row'}`}
    >
      {docs.map((doc, d) => {
        const rowBase = d * rowPitch;
        const rowY = rowBase;
        const title = titles[d] ?? doc;
        const tokens = geo.docTokenCount[d] ?? 0;
        const domain = rowDomain[d] ?? 0;
        const rowEnd = bookXFromTokenEdge(tokens, plotW, domain);
        const titleFontSize = geometry.rowGap >= 14 ? 11 : 9;
        const titleBandTop = labelBands[d]?.top ?? rowBase + rowPitch - geometry.rowGap;
        const titleBaseline = titleBandTop + Math.max(7, Math.min(15, geometry.rowGap - 3));
        return (
          <g key={doc}>
            {labelBands[d]?.titlePainted !== false && (
              <text
                data-trend-row-title={d}
                x={0}
                y={titleBaseline}
                fill="var(--fg-muted)"
                fontFamily="var(--font-mono)"
                fontSize={titleFontSize}
                pointerEvents="none"
                aria-hidden="true"
              >
                {title}
              </text>
            )}
            <line
              data-trend-row-axis={d}
              x1={0}
              y1={rowY + geometry.rowHeight}
              x2={rowEnd}
              y2={rowY + geometry.rowHeight}
              stroke="var(--rule)"
              strokeWidth={1}
            />
            {view === 'by-book-scaled' && tokens > 0 && tokens < domain && (
              <line
                data-trend-row-end={d}
                x1={rowEnd}
                y1={rowY}
                x2={rowEnd}
                y2={rowY + geometry.rowHeight}
                stroke="var(--rule-strong)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
            {measure.kind === 'rate' && measure.smoothing !== 0 && measure.showRaw && rawReady.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.rawValues,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
                (b) => spanX(d, b),
              ).map((path, index) => (
                <path
                  key={`raw:${r.intent.id}:${index}`}
                  data-raw-series-path={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={seriesColor(r.intent.style)}
                  strokeWidth={1}
                  strokeDasharray={seriesDash(r.intent.style)}
                  opacity={r.ghost ? 0.1 : 0.2}
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
                (b) => spanX(d, b),
              ).map((path, index) => (
                <g key={`${r.intent.id}:${index}`}>
                  {!r.ghost && hasGhostContext && (
                    <path
                      data-series-find-halo={r.intent.id}
                      d={path}
                      fill="none"
                      stroke="var(--bg)"
                      strokeWidth={findSeriesHaloStrokeWidth(strokeFor(r.intent.id))}
                      strokeDasharray={seriesDash(r.intent.style)}
                      strokeLinecap={seriesLinecap(r.intent.style)}
                      opacity={0.92}
                      pointerEvents="none"
                    />
                  )}
                  <path
                    data-series-path={r.intent.id}
                    data-series-ghost={r.ghost || undefined}
                    data-series-find-foreground={!r.ghost && hasGhostContext || undefined}
                    d={path}
                    fill="none"
                    stroke={seriesColor(r.intent.style)}
                    strokeWidth={r.ghost
                      ? ghostSeriesStrokeWidth(strokeFor(r.intent.id))
                      : hasGhostContext
                        ? findSeriesStrokeWidth(strokeFor(r.intent.id))
                        : strokeFor(r.intent.id)}
                    strokeDasharray={seriesDash(r.intent.style)}
                    strokeLinecap={seriesLinecap(r.intent.style)}
                    opacity={r.ghost ? GHOST_SERIES_OPACITY : selected.length > 0 ? 0.45 : 1}
                    pointerEvents={r.ghost ? 'none' : undefined}
                  />
                </g>
              )),
            )}
            {selected.flatMap((r) =>
              selectedTrendPathData(
                r.trend,
                doc,
                r.values,
                (b) => pointX(d, b),
                (value) => rowY + y(value),
                (b) => spanX(d, b),
              ).map((path, i) => (
                <path
                  key={`selected:${r.intent.id}:${i}`}
                  data-selected-overlay={r.intent.id}
                  d={path}
                  fill="none"
                  stroke={seriesColor(r.intent.style)}
                  strokeWidth={strokeFor(r.intent.id) + 1.5}
                  strokeDasharray={seriesDash(r.intent.style)}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )),
            )}
            {Array.from({ length: trendRowsForDoc(geo, d).count }, (_, b) => {
              const rows = trendRowsForDoc(geo, d);
              const span = trendBinSpan(geo, d, b);
              if (span.end <= span.start) return null;
              const lines = foregroundReady
                .map((r) => {
                  const iRow = rows.start + b;
                  const displayed = r.values[iRow];
                  const formatted = displayed !== undefined && Number.isFinite(displayed)
                    ? `${formatTrendDisplayValue(displayed, measure)}${trendMeasureUnit(measure)}`
                    : 'gap';
                  return `${r.intent.label}: ${r.trend.count[iRow]}× (${formatted})`;
                })
                .join('\n');
              return (
                <rect
                  key={b}
                  data-trend-hit-row={d}
                  x={bookXFromTokenEdge(span.start, plotW, domain)}
                  y={rowY}
                  width={Math.max(
                    1,
                    bookXFromTokenEdge(span.end, plotW, domain)
                      - bookXFromTokenEdge(span.start, plotW, domain),
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
      {__TT_E2E__ && <ChartCommitProbe view={view} />}
    </svg>
  );
});
