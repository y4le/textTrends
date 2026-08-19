import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
import { seriesColor, seriesDash, seriesLinecap } from '../../lib/series-style.ts';
import {
  trendMatrixRateLabel,
  type TrendMatrixCell,
  type TrendMatrixVM,
} from '../../lib/trend-matrix.ts';

const MICRO_WIDTH = 84;
const MICRO_HEIGHT = 30;
const integer = new Intl.NumberFormat('en-US');

function cellDescription(cell: TrendMatrixCell, title: string): string {
  if (cell.status === 'pending') return `${title}: trend pending`;
  if (cell.status === 'error') return `${title}: trend failed, ${cell.message}`;
  if (cell.status === 'unavailable') return `${title}: unavailable in this trend result`;
  if (cell.status === 'empty') return `${title}: no indexed tokens`;
  const shape = cell.dispersion === null
    ? ''
    : `; ${cell.dispersion} across the current bins`;
  const position = cell.position === null
    ? ''
    : `; occurrence mass toward the ${cell.position}`;
  return `${title}: ${trendMatrixRateLabel(cell.relativeToPeak, cell.count)}${shape}${position}`;
}

function histogramPath(
  cell: Extract<TrendMatrixCell, { status: 'ready' }>,
  scale: number,
): string {
  if (scale <= 0) return '';
  return cell.profile.map((bin) => {
    if (bin.rate <= 0) return '';
    const x0 = Math.max(0, Math.min(MICRO_WIDTH, bin.start * MICRO_WIDTH));
    const x1 = Math.max(x0, Math.min(MICRO_WIDTH, bin.end * MICRO_WIDTH));
    const height = Math.max(1, bin.rate / scale * (MICRO_HEIGHT - 2));
    const y = MICRO_HEIGHT - height;
    return `M${x0.toFixed(2)} ${MICRO_HEIGHT}V${y.toFixed(2)}H${x1.toFixed(2)}V${MICRO_HEIGHT}Z`;
  }).join('');
}

function MatrixCell({
  cell,
  title,
  scale,
  color,
}: {
  readonly cell: TrendMatrixCell;
  readonly title: string;
  readonly scale: number;
  readonly color: string;
}) {
  const label = cellDescription(cell, title);
  if (cell.status !== 'ready') {
    return (
      <td
        className="trend-matrix-cell trend-matrix-cell-status"
        data-status={cell.status}
        aria-label={label}
        title={label}
      >
        {cell.status === 'pending' ? '…' : cell.status === 'error' ? '!' : '—'}
      </td>
    );
  }
  const path = histogramPath(cell, scale);
  return (
    <td
      className="trend-matrix-cell"
      data-status={cell.count === 0 ? 'zero' : 'measured'}
      aria-label={label}
      title={label}
    >
      <svg
        viewBox={`0 0 ${MICRO_WIDTH} ${MICRO_HEIGHT}`}
        width={MICRO_WIDTH}
        height={MICRO_HEIGHT}
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1={0}
          y1={MICRO_HEIGHT - 0.5}
          x2={MICRO_WIDTH}
          y2={MICRO_HEIGHT - 0.5}
          stroke="var(--rule)"
          strokeWidth={1}
        />
        {path !== '' && <path d={path} fill={color} fillOpacity={0.72} />}
      </svg>
    </td>
  );
}

export function TrendMatrix({
  vm,
  titleByDoc,
  graphShowsCounts,
  pendingRange,
}: {
  readonly vm: TrendMatrixVM;
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly graphShowsCounts: boolean;
  readonly pendingRange: boolean;
}) {
  const titles = vm.docs.map((doc) => titleByDoc.get(doc) ?? doc);
  return (
    <section
      className="trend-organ"
      data-trend-organ="matrix"
      data-range-pending={pendingRange || undefined}
      aria-labelledby="trend-matrix-heading"
    >
      <header className="trend-organ-header">
        <div>
          <h2 id="trend-matrix-heading">distribution by book</h2>
          <p>
            whole corpus · per term: shared bin-height scale; home compares whole-book rates · marks are unsmoothed
            {graphShowsCounts
              ? ` · rates per ${integer.format(TREND_RATE_DENOMINATOR)}; the graph above shows counts`
              : ''}
          </p>
        </div>
        <p className="trend-organ-pending" role="status" aria-atomic="true">
          {pendingRange ? 'comparing selected range…' : ''}
        </p>
      </header>
      <div
        className="trend-matrix-port horizontal-data-port"
        role="region"
        tabIndex={0}
        aria-label="Scrollable term by book distribution matrix"
      >
        <table className="trend-matrix-table">
          <caption className="visually-hidden">
            Whole-corpus term distribution by book. Cell marks use canonical rates per 10,000 tokens and are scaled independently for each term row.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="trend-matrix-corner">term</th>
              {vm.docs.map((doc, index) => (
                <th key={doc} scope="col" title={titles[index]}>
                  <span className="trend-matrix-book-number">{index + 1}</span>
                  <span className="trend-matrix-book-title">{titles[index]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vm.rows.map((row) => {
              const color = seriesColor(row.series.style);
              const home = row.peakDoc === null
                ? row.status === 'pending' ? 'measuring…' : row.status === 'error' ? 'unavailable' : 'no occurrences'
                : `home · ${titleByDoc.get(row.peakDoc) ?? row.peakDoc}`;
              return (
                <tr key={row.series.id}>
                  <th scope="row">
                    <span className="trend-matrix-term">
                      <svg viewBox="0 0 24 4" width={24} height={4} aria-hidden="true">
                        <line
                          x1={0}
                          y1={2}
                          x2={24}
                          y2={2}
                          stroke={color}
                          strokeWidth={2}
                          strokeDasharray={seriesDash(row.series.style)}
                          strokeLinecap={seriesLinecap(row.series.style)}
                        />
                      </svg>
                      <span>{row.series.label}</span>
                    </span>
                    <span className="trend-matrix-home" title={home}>{home}</span>
                  </th>
                  {row.cells.map((cell, index) => (
                    <MatrixCell
                      key={cell.doc}
                      cell={cell}
                      title={titles[index] ?? cell.doc}
                      scale={row.microScale}
                      color={color}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="trend-organ-note">
        Shape and relative density only; exact per-book totals remain in Inputs. Current-bin DPnorm reads as even through 0.2, varied through 0.5, then clumped.
      </p>
    </section>
  );
}
