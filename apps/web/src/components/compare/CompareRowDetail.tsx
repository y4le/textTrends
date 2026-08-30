import type { KeynessRowV1, KeynessSideTotalsV1 } from '@texttrends/core';
import {
  effectiveKeynessMinDocFreqForParts,
  type KeynessViewV1,
} from '../../lib/store.ts';
import { formatRate } from '../../lib/rate-format.ts';
import { InfoTooltip } from '../InfoTooltip.tsx';

const number = new Intl.NumberFormat('en-US');
const signed = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  signDisplay: 'always',
});
const proportion = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface Measurement {
  readonly key: string;
  readonly label: string;
  readonly exact: string;
  readonly explanation?: string;
}

export function CompareRowDetail({
  row,
  side,
  sideLabelA,
  sideLabelB,
  totalsA,
  totalsB,
  view,
  onClose,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly sideLabelA: string;
  readonly sideLabelB: string;
  readonly totalsA: KeynessSideTotalsV1 | null;
  readonly totalsB: KeynessSideTotalsV1 | null;
  readonly view: KeynessViewV1;
  readonly onClose: () => boolean;
}) {
  const favoredLabel = side === 'a' ? sideLabelA : sideLabelB;
  const measurementIdBase = `compare-row-${side}-${row.typeId}-measurement`;
  const appliedMinimumParts = effectiveKeynessMinDocFreqForParts(
    view,
    totalsA?.documents ?? 1,
    totalsB?.documents ?? 1,
  );
  // Range counts texts, so it says nothing on a side that IS one text — there
  // it can only be 0 or 1, and printing it invites reading a tautology as a
  // finding. Dispersion takes its place wherever the side has parts to
  // disperse across.
  const multiTextA = (totalsA?.documents ?? 0) > 1;
  const multiTextB = (totalsB?.documents ?? 0) > 1;
  const measurements: readonly Measurement[] = [
    {
      key: 'count-a',
      label: `count · ${sideLabelA}`,
      exact: number.format(row.countA),
      explanation: 'Exact occurrences of this indexed form on the left comparison side, within the selected token classes.',
    },
    {
      key: 'count-b',
      label: `count · ${sideLabelB}`,
      exact: number.format(row.countB),
      explanation: 'Exact occurrences of this indexed form on the right comparison side, within the selected token classes.',
    },
    {
      key: 'rate-a',
      label: `rate / 10k · ${sideLabelA}`,
      exact: formatRate(row.rateAper10k),
      explanation: 'Occurrences on the left side per 10,000 selected-class tokens. This normalizes for sides with different lengths.',
    },
    {
      key: 'rate-b',
      label: `rate / 10k · ${sideLabelB}`,
      exact: formatRate(row.rateBper10k),
      explanation: 'Occurrences on the right side per 10,000 selected-class tokens. This normalizes for sides with different lengths.',
    },
    ...(multiTextA
      ? [{
          key: 'range-a',
          label: `text range · ${sideLabelA}`,
          exact: `${number.format(row.rangeA)} of ${number.format(totalsA?.documents ?? 0)}`,
          explanation: 'The number of texts on the left side containing at least one occurrence.',
        }]
      : []),
    ...(multiTextB
      ? [{
          key: 'range-b',
          label: `text range · ${sideLabelB}`,
          exact: `${number.format(row.rangeB)} of ${number.format(totalsB?.documents ?? 0)}`,
          explanation: 'The number of texts on the right side containing at least one occurrence.',
        }]
      : []),
    ...(row.dpA === null
      ? []
      : [{
          key: 'dp-a',
          label: `dispersion · ${sideLabelA}`,
          exact: proportion.format(row.dpA),
          explanation: 'Gries’ deviation of proportions across the left side’s texts: 0 means the occurrences are spread exactly in proportion to how long each text is, and values near 1 mean they are concentrated in one text. A high keyness score with high dispersion is characteristic of one text rather than of the whole side.',
        }]),
    ...(row.dpB === null
      ? []
      : [{
          key: 'dp-b',
          label: `dispersion · ${sideLabelB}`,
          exact: proportion.format(row.dpB),
          explanation: 'Gries’ deviation of proportions across the right side’s texts: 0 means the occurrences are spread exactly in proportion to how long each text is, and values near 1 mean they are concentrated in one text.',
        }]),
    {
      key: 'log-ratio',
      label: 'log₂ ratio',
      exact: signed.format(row.logRatio),
      explanation: 'The smoothed rate ratio in powers of two, signed toward the left side. +1 means about twice the left-side rate; −1 means about twice the right-side rate.',
    },
    {
      key: 'log-ratio-interval',
      label: '95% interval',
      exact: `${signed.format(row.logRatioLow)} … ${signed.format(row.logRatioHigh)}`,
      explanation: 'The range the log₂ ratio is consistent with, given how many occurrences it was built from. A wide interval means a small count produced the effect; an interval that spans 0 means the evidence does not settle which side favours this word. This is one word’s precision, not a filter to apply down the whole table — keeping only the words whose intervals miss 0 would be exactly the kind of picking that makes intervals misleading.',
    },
    {
      key: 'g2',
      label: 'signed G²',
      exact: signed.format(row.g2),
      explanation: 'A likelihood-ratio evidence score, signed toward the left side. Larger absolute values indicate stronger evidence, not an effect size or confidence interval.',
    },
    {
      key: 'class',
      label: 'token class',
      exact: row.class,
      explanation: 'The tokenizer classification used to include this form in the comparison.',
    },
    {
      key: 'combined-count',
      label: 'combined count',
      exact: number.format(row.countA + row.countB),
      explanation: 'The total occurrences on both comparison sides before the minimum-count filter is applied.',
    },
  ];

  return (
    <section
      className="compare-row-detail"
      aria-label={`Compare detail: ${row.key}, side ${side.toUpperCase()}`}
    >
      <header className="compare-row-detail-heading">
        <div>
          <h4>{row.key}</h4>
          <p>
            Overrepresented in {favoredLabel}
            {row.logRatioLow <= 0 && row.logRatioHigh >= 0
              ? ' — but the interval below spans 0, so the direction is not settled'
              : ''}
          </p>
        </div>
        <button
          type="button"
          aria-label={`Close comparison detail for ${row.key}`}
          onClick={onClose}
        >
          close
        </button>
      </header>
      <dl className="compare-row-stats">
        {measurements.map((measurement) => (
          <div key={measurement.key}>
            <dt className="compare-row-measurement-label">
              <span>{measurement.label}</span>
              {measurement.explanation && (
                <InfoTooltip
                  id={`${measurementIdBase}-${measurement.key}-help`}
                  label={measurement.label}
                  explanation={measurement.explanation}
                />
              )}
            </dt>
            <dd className="selectable-stat">{measurement.exact}</dd>
          </div>
        ))}
      </dl>
      <p className="compare-row-filters">
        Included at count ≥ {number.format(view.minCountTotal)} ·{' '}
        {view.mode === 'selection-rest' ? 'comparison parts' : 'texts'} ≥{' '}
        {number.format(appliedMinimumParts)} · {view.classes.join(' + ')}
      </p>
    </section>
  );
}
