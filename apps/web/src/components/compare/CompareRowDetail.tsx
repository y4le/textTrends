import type { KeynessRowV1 } from '@texttrends/core';
import type { KeynessViewV1 } from '../../lib/store.ts';
import { formatRate } from '../../lib/rate-format.ts';
import { InfoTooltip } from '../InfoTooltip.tsx';

const number = new Intl.NumberFormat('en-US');
const signed = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  signDisplay: 'always',
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
  view,
  onClose,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly sideLabelA: string;
  readonly sideLabelB: string;
  readonly view: KeynessViewV1;
  readonly onClose: () => boolean;
}) {
  const favoredLabel = side === 'a' ? sideLabelA : sideLabelB;
  const measurementIdBase = `compare-row-${side}-${row.typeId}-measurement`;
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
    {
      key: 'range-a',
      label: `text range · ${sideLabelA}`,
      exact: number.format(row.rangeA),
      explanation: 'The number of texts on the left side containing at least one occurrence. A single-text side can only be zero or one.',
    },
    {
      key: 'range-b',
      label: `text range · ${sideLabelB}`,
      exact: number.format(row.rangeB),
      explanation: 'The number of texts on the right side containing at least one occurrence. A single-text side can only be zero or one.',
    },
    {
      key: 'log-ratio',
      label: 'log₂ ratio',
      exact: signed.format(row.logRatio),
      explanation: 'The smoothed rate ratio in powers of two, signed toward the left side. +1 means about twice the left-side rate; −1 means about twice the right-side rate.',
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
          <p>Overrepresented in {favoredLabel}</p>
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
        Included at count ≥ {number.format(view.minCountTotal)} · texts ≥{' '}
        {number.format(view.minDocFreqTotal)} · {view.classes.join(' + ')}
      </p>
    </section>
  );
}
