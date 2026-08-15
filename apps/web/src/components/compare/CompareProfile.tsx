import type { KeynessDivergenceV1 } from '@texttrends/core';
import type { CSSProperties } from 'react';
import {
  compareProfile,
  compareProfileHasBar,
  compareProfilePercent,
  type CompareProfileFormat,
  type CompareProfileMetricV1,
} from '../../lib/compare-profile.ts';
import type { KeynessInventoryState } from '../../lib/store.ts';
import { InfoTooltip } from '../InfoTooltip.tsx';

const count = new Intl.NumberFormat('en-US');
const rate = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const index = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});
const bits = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

function formatMetric(
  value: number | null,
  format: CompareProfileFormat,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (format === 'count') return count.format(value);
  if (format === 'index') return index.format(value);
  return rate.format(value);
}

function readyResult(state: KeynessInventoryState | null) {
  return state?.state.status === 'ready' ? state.state.result : null;
}

/** The one whole-comparison measurement leads the otherwise two-sided profile. */
function DivergenceHeadline({
  divergence,
  sideLabelA,
  sideLabelB,
}: {
  readonly divergence: KeynessDivergenceV1 | null;
  readonly sideLabelA: string;
  readonly sideLabelB: string;
}) {
  const percent = divergence
    ? Math.min(100, Math.max(0, divergence.bits * 100))
    : 0;
  const style = { '--compare-divergence-width': `${percent}%` } as CSSProperties;
  return (
    <div className="compare-divergence">
      <div className="compare-divergence-heading">
        <span className="compare-divergence-label">
          vocabulary divergence
          <InfoTooltip
            id="compare-divergence-help"
            label="vocabulary divergence"
            explanation={`Jensen–Shannon divergence in bits between the two sides' word distributions: 0 means they use every word at identical rates, 1 means they share no word at all. It covers every distinct word in the selected token classes, not only the ranked terms below, and the sort and filter settings do not move it.`}
          />
        </span>
        <span className="compare-divergence-value selectable-stat">
          {divergence ? bits.format(divergence.bits) : '—'}
          <span className="compare-divergence-unit"> bits</span>
        </span>
      </div>
      <div
        className="compare-divergence-track"
        role="meter"
        aria-valuenow={divergence ? Number(divergence.bits.toFixed(3)) : 0}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-label={`Vocabulary divergence between ${sideLabelA} and ${sideLabelB}`}
      >
        <span className="compare-divergence-fill" style={style} />
      </div>
      <p className="compare-divergence-note">
        {divergence
          ? `0 identical · 1 no shared vocabulary · over ${count.format(divergence.types)} distinct words`
          : '0 identical · 1 no shared vocabulary'}
      </p>
    </div>
  );
}

function MetricRow({
  metric,
}: {
  readonly metric: CompareProfileMetricV1;
}) {
  const hasBar = compareProfileHasBar(metric);
  const styleA = {
    '--compare-bar-width': `${hasBar ? compareProfilePercent(metric.a, metric.b) : 0}%`,
  } as CSSProperties;
  const styleB = {
    '--compare-bar-width': `${hasBar ? compareProfilePercent(metric.b, metric.a) : 0}%`,
  } as CSSProperties;
  return (
    <tr className="compare-profile-row" data-metric={metric.key}>
      <td className="compare-profile-value selectable-stat" data-side="a">
        {formatMetric(metric.a, metric.format)}
      </td>
      <td className="compare-profile-plot" data-side="a" data-bar={hasBar || undefined} aria-hidden="true">
        {hasBar && <span className="compare-profile-bar" style={styleA} />}
      </td>
      <th scope="row" className="compare-profile-label">
        <span>{metric.label}</span>
        <InfoTooltip
          id={`compare-profile-${metric.key}-help`}
          label={metric.label}
          explanation={metric.explanation}
        />
      </th>
      <td className="compare-profile-plot" data-side="b" data-bar={hasBar || undefined} aria-hidden="true">
        {hasBar && <span className="compare-profile-bar" style={styleB} />}
      </td>
      <td className="compare-profile-value selectable-stat" data-side="b">
        {formatMetric(metric.b, metric.format)}
      </td>
    </tr>
  );
}

/**
 * Two-sided text profile above the keyness pyramid, mirrored on the same axis
 * so the header and the ranked table read as one surface.
 *
 * The ranking header owns the disclosure button and inserts this bounded panel
 * directly beneath itself. The ranking remains the place's primary surface;
 * the profile is what a reader opens after it.
 */
export function CompareProfile({
  inventoryA,
  inventoryB,
  divergence,
  sideLabelA,
  sideLabelB,
}: {
  readonly inventoryA: KeynessInventoryState | null;
  readonly inventoryB: KeynessInventoryState | null;
  readonly divergence: KeynessDivergenceV1 | null;
  readonly sideLabelA: string;
  readonly sideLabelB: string;
}) {
  const resultA = readyResult(inventoryA);
  const resultB = readyResult(inventoryB);
  const metrics = compareProfile(resultA, resultB);
  const pending = (inventoryA === null || inventoryA.state.status === 'pending')
    || (inventoryB === null || inventoryB.state.status === 'pending');
  const errored = inventoryA?.state.status === 'error'
    ? inventoryA.state.message
    : inventoryB?.state.status === 'error'
      ? inventoryB.state.message
      : null;

  return (
    <section
      id="compare-text-profile"
      className="compare-profile"
      aria-label="Text profile"
      aria-busy={pending || undefined}
    >
      <DivergenceHeadline
        divergence={divergence}
        sideLabelA={sideLabelA}
        sideLabelB={sideLabelB}
      />
      {errored && (
        <p className="compare-profile-status" data-error="">
          Couldn’t measure the text profile: {errored}
        </p>
      )}
      {resultA === null && resultB === null
        ? <p className="compare-profile-status">measuring…</p>
        : (
            <table className="compare-profile-grid">
              <caption className="visually-hidden">
                Two-sided text measurements. Each row names one measurement
                with its value on the left side first and the right side last.
              </caption>
              <thead>
                <tr className="compare-profile-row compare-profile-head">
                  <th scope="col" className="compare-profile-value" data-side="a">
                    {sideLabelA}
                  </th>
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <th scope="col" className="compare-profile-value" data-side="b">
                    {sideLabelB}
                  </th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => (
                  <MetricRow
                    key={metric.key}
                    metric={metric}
                  />
                ))}
              </tbody>
            </table>
          )}
      <p className="compare-profile-note">
        Bars compare the two sides on length-controlled measurements only. Raw
        totals are printed without a bar because they track how long each text
        is.
      </p>
    </section>
  );
}
