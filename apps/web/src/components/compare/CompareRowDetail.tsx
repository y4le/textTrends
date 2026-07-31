import type { KeynessRowV1 } from '@texttrends/core';
import type { KeynessViewV1 } from '../../lib/store.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const signed = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  signDisplay: 'always',
});

export function CompareRowDetail({
  row,
  side,
  view,
  onEvidence,
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
  readonly onEvidence: () => void;
}) {
  return (
    <section
      className="compare-row-detail"
      aria-label={`Compare detail: ${row.key}, side ${side.toUpperCase()}`}
    >
      <dl>
        <div><dt>term</dt><dd>{row.key}</dd></div>
        <div><dt>class</dt><dd>{row.class}</dd></div>
        <div><dt>count A</dt><dd>{number.format(row.countA)}</dd></div>
        <div><dt>count B</dt><dd>{number.format(row.countB)}</dd></div>
        <div><dt>rate A / 10k</dt><dd>{decimal.format(row.rateAper10k)}</dd></div>
        <div><dt>rate B / 10k</dt><dd>{decimal.format(row.rateBper10k)}</dd></div>
        <div><dt>log₂ ratio</dt><dd>{signed.format(row.logRatio)}</dd></div>
        <div><dt>signed G²</dt><dd>{signed.format(row.g2)}</dd></div>
        <div><dt>documents A</dt><dd>{number.format(row.rangeA)}</dd></div>
        <div><dt>documents B</dt><dd>{number.format(row.rangeB)}</dd></div>
        <div>
          <dt>active filters</dt>
          <dd>
            count ≥ {number.format(view.minCountTotal)} · documents ≥{' '}
            {number.format(view.minDocFreqTotal)} · {view.classes.join(' + ')}
          </dd>
        </div>
      </dl>
      <p className="compare-row-note">
        Evidence is restricted to side {side.toUpperCase()} for this projection.
      </p>
      <div className="compare-row-actions">
        <button type="button" onClick={onEvidence}>
          show evidence
        </button>
      </div>
    </section>
  );
}
