import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
import { formatRate } from '../../lib/rate-format.ts';
import { seriesColor } from '../../lib/series-style.ts';
import type {
  TrendRangeCompareVM,
  TrendRangeDirection,
} from '../../lib/trend-range-compare.ts';

const integer = new Intl.NumberFormat('en-US');
const multiple = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function undefinedDirection(direction: Extract<TrendRangeDirection, { kind: 'undefined' }>): string {
  switch (direction.reason) {
    case 'whole-corpus': return 'range leaves no corpus remainder';
    case 'empty-range': return 'range has no measured tokens';
    case 'no-occurrences': return 'no occurrences';
    case 'snapshot-mismatch': return 'results do not share document geometry';
  }
}

function axisPoint(contrast: number): number {
  return 100 - contrast * 96;
}

function contrastLabel(contrast: number, insideRate: number, outsideRate: number): string {
  if (contrast === -1) return 'absent in range';
  if (contrast === 1) return 'only in range';
  if (contrast === 0) return 'same rate';
  const ratio = contrast > 0 ? insideRate / outsideRate : outsideRate / insideRate;
  if (ratio < 1.05) return 'about the same rate';
  return contrast > 0
    ? `${multiple.format(ratio)}× denser in range`
    : `${multiple.format(ratio)}× denser in rest`;
}

function DirectionPlot({
  direction,
  insideRate,
  outsideRate,
  color,
}: {
  readonly direction: TrendRangeDirection;
  readonly insideRate: number;
  readonly outsideRate: number;
  readonly color: string;
}) {
  if (direction.kind === 'undefined') {
    return <span className="trend-range-undefined">{undefinedDirection(direction)}</span>;
  }
  const point = axisPoint(direction.contrast);
  const toward = direction.contrast > 0 ? 'range' : direction.contrast < 0 ? 'rest' : 'neither side';
  const label = contrastLabel(direction.contrast, insideRate, outsideRate);
  const evidence = direction.evidenced
    ? 'solid mark; pooled expected count reaches five on both sides'
    : `thin mark; smaller pooled expected count is ${formatRate(direction.expectedMin)}`;
  const aria = `${label}; direction toward ${toward}; ${evidence}`;
  return (
    <span
      className="trend-range-direction"
      role="img"
      data-direction-side={toward === 'neither side' ? 'even' : toward}
      data-evidenced={direction.evidenced || undefined}
      aria-label={aria}
      title={aria}
    >
      <svg viewBox="0 0 200 28" width={200} height={28} aria-hidden="true">
        <line x1={4} y1={14} x2={196} y2={14} stroke="var(--rule)" strokeWidth={1} />
        <line x1={100} y1={3} x2={100} y2={25} stroke="var(--rule-strong)" strokeWidth={1} />
        <line
          x1={100}
          y1={14}
          x2={point}
          y2={14}
          stroke={color}
          strokeWidth={direction.evidenced ? 10 : 1}
          strokeDasharray={direction.evidenced ? undefined : '2 2'}
          strokeOpacity={0.8}
        />
      </svg>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

export function TrendRangeCompare({ vm }: { readonly vm: TrendRangeCompareVM }) {
  return (
    <section
      className="trend-organ"
      data-trend-organ="range"
      aria-labelledby="trend-range-heading"
    >
      <header className="trend-organ-header">
        <div>
          <h2 id="trend-range-heading" tabIndex={-1}>selected range / rest of corpus</h2>
          <p>
            tracked terms only · rates per {integer.format(TREND_RATE_DENOMINATOR)} tokens · direction compares observed rates
          </p>
        </div>
      </header>
      <div className="trend-range-port horizontal-data-port" role="region" tabIndex={0} aria-label="Selected range comparison">
        <table className="trend-range-table">
          <caption className="visually-hidden">
            Rates for tracked terms inside the selected range and in the rest of the corpus, with a fixed negative-one to positive-one observed-rate contrast.
          </caption>
          <thead>
            <tr>
              <th scope="col">term</th>
              <th scope="col">range /10k</th>
              <th scope="col">direction</th>
              <th scope="col">rest /10k</th>
            </tr>
          </thead>
          <tbody>
            {vm.rows.map((row) => {
              if (row.status !== 'ready') {
                return (
                  <tr key={row.series.id}>
                    <th scope="row">{row.series.label}</th>
                    <td colSpan={3} className="trend-range-status" data-error={row.status === 'error' || undefined}>
                      {row.status === 'pending' ? 'comparing…' : row.message}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.series.id}>
                  <th scope="row">{row.series.label}</th>
                  <td className="trend-range-rate selectable-stat">{formatRate(row.inside.rate)}</td>
                  <td className="trend-range-effect">
                    <DirectionPlot
                      direction={row.direction}
                      insideRate={row.inside.rate}
                      outsideRate={row.outside.rate}
                      color={seriesColor(row.series.style)}
                    />
                  </td>
                  <td className="trend-range-rate selectable-stat">{formatRate(row.outside.rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="trend-organ-note">
        Solid marks require at least five pooled expected occurrences on both sides; thin marks flag sparse comparisons.
      </p>
    </section>
  );
}
