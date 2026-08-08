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
}: {
  readonly row: KeynessRowV1;
  readonly side: 'a' | 'b';
  readonly view: KeynessViewV1;
}) {
  return (
    <section
      className="compare-row-detail"
      aria-label={`Compare detail: ${row.key}, side ${side.toUpperCase()}`}
    >
      <dl>
        <div><dt>term</dt><dd>{row.key}</dd></div>
        <div><dt>class</dt><dd>{row.class}</dd></div>
        <div><dt>count A</dt><dd className="selectable-stat">{number.format(row.countA)}</dd></div>
        <div><dt>count B</dt><dd className="selectable-stat">{number.format(row.countB)}</dd></div>
        <div><dt>rate A / 10k</dt><dd className="selectable-stat">{decimal.format(row.rateAper10k)}</dd></div>
        <div><dt>rate B / 10k</dt><dd className="selectable-stat">{decimal.format(row.rateBper10k)}</dd></div>
        <div><dt>log₂ ratio</dt><dd className="selectable-stat">{signed.format(row.logRatio)}</dd></div>
        <div><dt>signed G²</dt><dd className="selectable-stat">{signed.format(row.g2)}</dd></div>
        <div><dt>documents A</dt><dd className="selectable-stat">{number.format(row.rangeA)}</dd></div>
        <div><dt>documents B</dt><dd className="selectable-stat">{number.format(row.rangeB)}</dd></div>
        <div>
          <dt>active filters</dt>
          <dd>
            count ≥ {number.format(view.minCountTotal)} · documents ≥{' '}
            {number.format(view.minDocFreqTotal)} · {view.classes.join(' + ')}
          </dd>
        </div>
      </dl>
    </section>
  );
}
