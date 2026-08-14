import {
  bookDetailRegionId,
  bookGrowthHeadingId,
  bookInventoryHeadingId,
  bookRhythmHeadingId,
  type BookDetailVM,
} from '../../lib/corpus-view.ts';
import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
import type { CatalogTotalValue } from '../../lib/catalog-totals.ts';
import { rhythmDescription } from '../../lib/corpus-dashboard-view.ts';
import { formatRate } from '../../lib/rate-format.ts';
import { useApp } from '../../lib/store-instance.ts';
import { OnlyBookButton } from './OnlyBookButton.tsx';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

function termCountValue(result: CatalogTotalValue | undefined): string {
  if (!result || result.status === 'pending') return 'pending';
  if (result.status === 'error') return `error — ${result.message}`;
  if (result.status === 'unavailable') return 'unavailable';
  return `${number.format(result.count)} · ${formatRate(result.rate)} per ${number.format(TREND_RATE_DENOMINATOR)} tokens`;
}

function RhythmDetailMark({ view }: { readonly view: BookDetailVM }) {
  if (view.rhythm.length === 0) return <>—</>;
  const max = Math.max(
    1,
    ...view.rhythm.map((bin) => Number.isFinite(bin.mean) ? bin.mean : 0),
  );
  return (
    <span
      className="book-rhythm-mark"
      role="img"
      aria-label={rhythmDescription(view.rhythm, value)}
    >
      {view.rhythm.map((bin, index) => (
        <span
          key={index}
          title={`bin ${index + 1}: mean ${value(bin.mean)} tokens`}
          style={{
            height: Number.isFinite(bin.mean) ? Math.max(1, bin.mean / max * 48) : 1,
            opacity: bin.tokens === 0 ? 0.4 : 0.75,
          }}
        />
      ))}
    </span>
  );
}

export function BookDetail({
  view,
  measurementScope,
  termCounts,
  onClose,
  onScopeMessage,
}: {
  readonly view: BookDetailVM;
  readonly measurementScope: 'full text' | 'active range';
  readonly termCounts: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: CatalogTotalValue | undefined;
  }[];
  readonly onClose: () => void;
  readonly onScopeMessage: (message: string | null) => void;
}) {
  const setPlace = useApp((s) => s.setPlace);
  const stats = view.stats;
  const inventoryHeadingId = bookInventoryHeadingId(view.doc);
  const growthHeadingId = bookGrowthHeadingId(view.doc);
  const rhythmHeadingId = bookRhythmHeadingId(view.doc);
  return (
    <section
      id={bookDetailRegionId(view.doc)}
      className="book-detail"
      role="region"
      aria-label={`Text detail: ${view.title}`}
    >
      <header className="book-detail-header">
        <h3>{view.title}</h3>
        <OnlyBookButton doc={view.doc} onMessage={onScopeMessage} />
        <button
          type="button"
          aria-label={`Close text detail for ${view.title}`}
          onClick={onClose}
        >
          close
        </button>
      </header>

      <section aria-labelledby={inventoryHeadingId}>
        <h4 id={inventoryHeadingId}>Measurements</h4>
        <p className="book-detail-scope">These measurements describe the {measurementScope}.</p>
        <dl className="book-detail-stats">
          {[
            ['selected / full tokens', `${number.format(stats.selectedTokens)} / ${number.format(stats.fullTokens)}`],
            ['lexical / numeral tokens', `${number.format(stats.lexicalTokens)} / ${number.format(stats.numeralTokens)}`],
            ['types', number.format(stats.types)],
            ['hapax', number.format(stats.hapax)],
            ['sentences / paragraphs', `${number.format(stats.sentences)} / ${number.format(stats.paragraphs)}`],
            ['sentence mean / median / p90', `${value(stats.sentenceMean)} / ${value(stats.sentenceMedian)} / ${value(stats.sentenceP90)}`],
            ['paragraph mean', value(stats.paragraphMean)],
            ['TTR', `${value(stats.ttr)} (descriptive and length-dependent)`],
            ['MATTR', `${value(stats.mattr)}${stats.mattrIsPlainTtr ? ' (plain TTR in a short run)' : ''}`],
            ['UTF-16 span', number.format(stats.charsUtf16)],
          ].map(([label, exact]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="selectable-stat">{exact}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby={`${inventoryHeadingId}-terms`}>
        <h4 id={`${inventoryHeadingId}-terms`}>Term counts</h4>
        {termCounts.length === 0
          ? <p>No active terms. Add a term to compare exact counts in this text.</p>
          : (
              <dl className="book-detail-stats">
                {termCounts.map((term) => (
                  <div key={term.id}>
                    <dt>{term.label}</dt>
                    <dd className="selectable-stat">{termCountValue(term.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
      </section>


      <section aria-labelledby={growthHeadingId}>
        <h4 id={growthHeadingId}>Vocabulary growth</h4>
        <p>
          Vocabulary growth is a corpus-level curve and is not attributed to an individual text.
          Text-level types, TTR, and MATTR are reported above.
        </p>
      </section>

      <section aria-labelledby={rhythmHeadingId}>
        <h4 id={rhythmHeadingId}>Sentence rhythm</h4>
        <RhythmDetailMark view={view} />
        {view.rhythm.length > 0 && (
          <details>
            <summary>exact rhythm values</summary>
            <table aria-label={`Sentence rhythm for ${view.title}`}>
              <thead><tr><th scope="col">bin</th><th scope="col">sentences</th><th scope="col">mean</th><th scope="col">selected tokens</th></tr></thead>
              <tbody>
                {view.rhythm.map((bin, index) => (
                  <tr key={index}>
                    <th className="selectable-stat" scope="row">{index + 1}</th>
                    <td className="selectable-stat">{number.format(bin.sentences)}</td>
                    <td className="selectable-stat">{value(bin.mean)}</td>
                    <td className="selectable-stat">{number.format(bin.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <nav aria-label={`Vocabulary destination for ${view.title}`}>
        <button type="button" onClick={() => setPlace('vocabulary')}>
          Open Vocabulary
        </button>
      </nav>
    </section>
  );
}
