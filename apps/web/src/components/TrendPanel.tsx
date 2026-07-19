/**
 * Trend small multiples — one row per document, shared rate scale, unsmoothed
 * equal-token bins with a bin-resolution barcode beneath each. Tufte:
 * hairline rules, direct labels, no legend, no chrome. (Exact per-occurrence
 * barcodes and axis-hover excerpts land when the occurrences op and a
 * token→char excerpt request are exposed through the client — the honest
 * version needs char offsets this panel does not yet have.)
 */

import { scaleLinear } from 'd3-scale';
import { useApp } from '../lib/store-instance.ts';

const WIDTH = 720;
const ROW_HEIGHT = 44;
const BARCODE_HEIGHT = 8;
const GAP = 26;
const LABEL_GAP = 4;

export function TrendPanel() {
  const trend = useApp((s) => s.trend);
  const kwic = useApp((s) => s.kwic);
  const term = useApp((s) => s.term);
  if (!trend) return null;

  const docs = trend.order;
  const bins = trend.binIndex.length / docs.length;
  const maxRate = Math.max(1e-9, ...Array.from(trend.ratePer10k));
  const x = scaleLinear([0, bins], [0, WIDTH]);
  const y = scaleLinear([0, maxRate], [ROW_HEIGHT, 0]);
  const height = docs.length * (ROW_HEIGHT + BARCODE_HEIGHT + GAP) + 10;

  return (
    <section>
      <h2
        style={{
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-mono)',
          color: 'var(--fg-muted)',
          margin: '0 0 var(--space-2)',
        }}
      >
        {term} · rate per 10k tokens · {bins} equal-token bins per book
        {kwic ? ` · ${kwic.total} occurrences` : ''}
      </h2>
      <svg
        width={WIDTH + 150}
        height={height}
        role="img"
        aria-label={`Trend of ${term} across ${docs.length} documents`}
      >
        {docs.map((doc, d) => {
          const rowY = d * (ROW_HEIGHT + BARCODE_HEIGHT + GAP);
          const rows = Array.from({ length: bins }, (_, b) => {
            const i = d * bins + b;
            return {
              bin: b,
              rate: trend.ratePer10k[i] as number,
              count: trend.count[i] as number,
            };
          });
          const path = rows
            .map(
              (r, i) =>
                `${i === 0 ? 'M' : 'L'}${x(r.bin + 0.5).toFixed(1)},${(rowY + y(r.rate)).toFixed(1)}`,
            )
            .join(' ');
          const total = rows.reduce((s, r) => s + r.count, 0);
          return (
            <g key={doc}>
              <line
                x1={0}
                y1={rowY + ROW_HEIGHT}
                x2={WIDTH}
                y2={rowY + ROW_HEIGHT}
                stroke="var(--rule)"
                strokeWidth={1}
              />
              <path d={path} fill="none" stroke="var(--series-focus)" strokeWidth={1.25} />
              {rows.map((r) => (
                <rect
                  key={r.bin}
                  x={x(r.bin)}
                  y={rowY}
                  width={Math.max(1, x(1) - x(0))}
                  height={ROW_HEIGHT + BARCODE_HEIGHT}
                  fill="transparent"
                >
                  <title>{`bin ${r.bin + 1}: ${r.count}× (${r.rate.toFixed(1)}/10k)`}</title>
                </rect>
              ))}
              {rows
                .filter((r) => r.count > 0)
                .map((r) => (
                  <rect
                    key={`bc-${r.bin}`}
                    x={x(r.bin)}
                    y={rowY + ROW_HEIGHT + 2}
                    width={1.5}
                    height={BARCODE_HEIGHT - 2}
                    fill="var(--series-1)"
                  />
                ))}
              <text
                x={WIDTH + LABEL_GAP}
                y={rowY + ROW_HEIGHT - 2}
                fill="var(--fg)"
                fontSize="var(--text-xs)"
                fontFamily="var(--font-mono)"
              >
                {doc.replace(/ - Arthur Conan Doyle$/, '').replace(/^\d+ - /, '').slice(0, 20)} · {total}
              </text>
            </g>
          );
        })}
      </svg>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', margin: 'var(--space-1) 0 0' }}>
        Barcode marks bins containing at least one hit (bin presence, not exact
        positions — exact occurrence ticks are coming). Chart values are in the
        table below.
      </p>
      <details style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', marginTop: 'var(--space-1)' }}>
        <summary>Data table (accessible alternative)</summary>
        <table style={{ fontFamily: 'var(--font-mono)', borderCollapse: 'collapse' }}>
          <caption style={{ textAlign: 'left' }}>
            Per-bin values for “{term}” by book: count · rate per 10k tokens ·
            tokens in bin (the chart plots the rate)
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left', fontWeight: 400 }}>book</th>
              {Array.from({ length: bins }, (_, b) => (
                <th key={b} scope="col" style={{ fontWeight: 400, padding: '0 2px' }}>{b + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((doc, d) => (
              <tr key={doc}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 400, paddingRight: '1ch' }}>
                  {doc.replace(/ - Arthur Conan Doyle$/, '').slice(0, 20)}
                </th>
                {Array.from({ length: bins }, (_, b) => {
                  const i = d * bins + b;
                  return (
                    <td key={b} style={{ textAlign: 'right', padding: '0 4px', whiteSpace: 'nowrap' }}>
                      {trend.count[i]} · {(trend.ratePer10k[i] as number).toFixed(1)} · {trend.binTokens[i]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
