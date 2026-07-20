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
 */

import { scaleLinear } from 'd3-scale';
import type { NumericTrend } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { slotColor, slotDash } from '../lib/series-style.ts';
import { binSpan, clampToSpan, spreadLabels } from '../lib/trend-geometry.ts';
import type { SeriesIntent } from '../lib/store.ts';

const WIDTH = 720;
const SERIES_HEIGHT = 180;
const TOP_PAD = 14; // room for the y-max direct label above the plot
const ROW_HEIGHT = 44;
const ROW_GAP = 22;
const LABEL_SPACE = 130;
const BOUNDARY_GAP = 2; // px of visual silence at each book boundary
const MIN_LABEL_GAP = 12;

interface ReadySeries {
  readonly intent: SeriesIntent;
  readonly trend: NumericTrend;
}

function shortTitle(doc: string): { n: string | null; title: string } {
  const m = /^(\d+) - (.*?)(?: - Arthur Conan Doyle)?$/.exec(doc);
  if (m) return { n: m[1]!, title: m[2]! };
  return { n: null, title: doc };
}

export function TrendPanel() {
  const series = useApp((s) => s.series);
  const trends = useApp((s) => s.trends);
  const trendView = useApp((s) => s.trendView);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const setFocus = useApp((s) => s.setFocus);
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
  const bins = docs.length === 0 ? 0 : geo.binIndex.length / docs.length;
  const bases = geo.sequenceBases ?? docs.map((_, d) => d * (geo.docTokenCount[d] ?? 0));
  const maxRate = Math.max(
    1e-9,
    ...ready.map((r) => Math.max(...Array.from(r.trend.ratePer10k))),
  );
  const strokeFor = (id: string) => (id === focusedSeries ? 2.5 : 1.5);

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
      {trendView === 'series' ? (
        <SeriesView
          ready={ready}
          docs={docs}
          bins={bins}
          bases={bases}
          maxRate={maxRate}
          strokeFor={strokeFor}
          onFocus={setFocus}
        />
      ) : (
        <ByBookView
          ready={ready}
          docs={docs}
          bins={bins}
          maxRate={maxRate}
          strokeFor={strokeFor}
          onFocus={setFocus}
        />
      )}
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
            const { n, title } = shortTitle(doc);
            const tokens = bookTokens(d);
            return (
              <tr key={doc} style={{ borderTop: '1px solid var(--rule)' }}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 400, paddingRight: '1ch', whiteSpace: 'nowrap' }}>
                  {n ? `${n} · ${title}` : title}
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
  bins,
  bases,
  maxRate,
  strokeFor,
  onFocus,
}: {
  ready: readonly ReadySeries[];
  docs: readonly string[];
  bins: number;
  bases: readonly number[];
  maxRate: number;
  strokeFor: (id: string) => number;
  onFocus: (id: string) => void;
}) {
  const geo = ready[0]!.trend;
  const totalTokens =
    docs.length === 0 ? 0 : (bases[docs.length - 1] ?? 0) + (geo.docTokenCount[docs.length - 1] ?? 0);
  const x = scaleLinear([0, Math.max(1, totalTokens)], [0, WIDTH]);
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
      width={WIDTH + LABEL_SPACE}
      height={height}
      role="img"
      aria-label={`Rates of ${ready.map((r) => r.intent.label).join(', ')} across ${docs.length} books in reading order`}
    >
      <line x1={0} y1={axisY} x2={WIDTH} y2={axisY} stroke="var(--rule-strong)" strokeWidth={1} />
      {docs.map((doc, d) => {
        const x0 = x(bases[d] ?? 0);
        const x1 = x((bases[d] ?? 0) + (geo.docTokenCount[d] ?? 0));
        const { n, title } = shortTitle(doc);
        const label = (x1 - x0) > 7 * (title.length + (n ? 4 : 0)) ? (n ? `${n} · ${title}` : title) : n ?? '·';
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
      <line x1={0} y1={y(maxRate)} x2={WIDTH} y2={y(maxRate)} stroke="var(--rule)" strokeWidth={1} />
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
            x1={WIDTH + 2}
            y1={endPoints[i]!}
            x2={WIDTH + 14}
            y2={labelY[i]!}
            stroke={slotColor(r.intent.styleSlot)}
            strokeWidth={1}
            strokeDasharray={slotDash(r.intent.styleSlot)}
          />
          <text
            x={WIDTH + 18}
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
      {/* Hover layer: one column per (book, bin) reporting every series */}
      {docs.map((doc, d) =>
        Array.from({ length: bins }, (_, b) => {
          const tokens = geo.docTokenCount[d] ?? 0;
          const { start, end } = binSpan(tokens, bins, b);
          const x0 = x((bases[d] ?? 0) + start);
          const w = Math.max(1, x((bases[d] ?? 0) + end) - x0);
          const { title } = shortTitle(doc);
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
  bins,
  maxRate,
  strokeFor,
  onFocus,
}: {
  ready: readonly ReadySeries[];
  docs: readonly string[];
  bins: number;
  maxRate: number;
  strokeFor: (id: string) => number;
  onFocus: (id: string) => void;
}) {
  const x = scaleLinear([0, bins], [0, WIDTH]);
  const y = scaleLinear([0, maxRate], [ROW_HEIGHT, 0]);
  const height = docs.length * (ROW_HEIGHT + ROW_GAP) + 4;

  return (
    <svg
      width={WIDTH + LABEL_SPACE}
      height={height}
      role="img"
      aria-label={`Rates of ${ready.map((r) => r.intent.label).join(', ')} within each of ${docs.length} books`}
    >
      {docs.map((doc, d) => {
        const rowY = d * (ROW_HEIGHT + ROW_GAP);
        const { n, title } = shortTitle(doc);
        return (
          <g key={doc}>
            <line x1={0} y1={rowY + ROW_HEIGHT} x2={WIDTH} y2={rowY + ROW_HEIGHT} stroke="var(--rule)" strokeWidth={1} />
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
            <text
              x={WIDTH + 6}
              y={rowY + ROW_HEIGHT - 2}
              fill="var(--fg)"
              fontSize="var(--text-xs)"
              fontFamily="var(--font-mono)"
            >
              {n ? `${n} · ` : ''}{title.slice(0, 16)}
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
