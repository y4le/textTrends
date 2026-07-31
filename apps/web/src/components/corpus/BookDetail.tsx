import {
  bookDetailRegionId,
  bookGrowthHeadingId,
  bookInventoryHeadingId,
  bookRhythmHeadingId,
  type BookDetailVM,
} from '../../lib/corpus-view.ts';
import { rhythmDescription } from '../../lib/corpus-dashboard-view.ts';
import { useApp } from '../../lib/store-instance.ts';
import { StructurePanel } from '../StructurePanel.tsx';
import { GrowthCurve } from './GrowthCurve.tsx';
import { OnlyBookButton } from './OnlyBookButton.tsx';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

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
  growth,
  onClose,
  onScopeMessage,
}: {
  readonly view: BookDetailVM;
  readonly growth: Parameters<typeof GrowthCurve>[0]['growth'] | null;
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
      aria-label={`Book detail: ${view.title}`}
    >
      <header className="book-detail-header">
        <h3>{view.title}</h3>
        <OnlyBookButton doc={view.doc} onMessage={onScopeMessage} />
        <button
          type="button"
          aria-label={`Close book detail for ${view.title}`}
          onClick={onClose}
        >
          close
        </button>
      </header>

      <section aria-labelledby={inventoryHeadingId}>
        <h4 id={inventoryHeadingId}>Inventory</h4>
        <dl className="book-detail-stats">
          {[
            ['selected / full tokens', `${number.format(stats.selectedTokens)} / ${number.format(stats.fullTokens)}`],
            ['lexical / numeral tokens', `${number.format(stats.lexicalTokens)} / ${number.format(stats.numeralTokens)}`],
            ['types', number.format(stats.types)],
            ['hapax', number.format(stats.hapax)],
            ['sentences / paragraphs', `${number.format(stats.sentences)} / ${number.format(stats.paragraphs)}`],
            ['sentence mean / median / p90', `${value(stats.sentenceMean)} / ${value(stats.sentenceMedian)} / ${value(stats.sentenceP90)}`],
            ['paragraph mean', value(stats.paragraphMean)],
            ['TTR', value(stats.ttr)],
            ['MATTR', `${value(stats.mattr)}${stats.mattrIsPlainTtr ? ' (plain TTR in a short run)' : ''}`],
            ['UTF-16 span', number.format(stats.charsUtf16)],
          ].map(([label, exact]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{exact}</dd>
            </div>
          ))}
        </dl>
      </section>

      <StructurePanel headingAs="h4" showDocumentControl={false} />

      <section aria-labelledby={growthHeadingId}>
        <h4 id={growthHeadingId}>Vocabulary growth</h4>
        {view.growth === 'scoped' && growth
          ? <GrowthCurve growth={growth} />
          : view.growth === 'absent'
            ? <p>Vocabulary growth is unavailable for this result.</p>
            : (
                <p>
                  The visible growth curve describes the current corpus scope.
                  Use the scope action above to compute it for this book.
                </p>
              )}
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
                    <th scope="row">{index + 1}</th>
                    <td>{number.format(bin.sentences)}</td>
                    <td>{value(bin.mean)}</td>
                    <td>{number.format(bin.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <nav aria-label={`Vocabulary destination for ${view.title}`}>
        <button type="button" onClick={() => setPlace('vocabulary')}>
          Open {view.vocabularyLabel} and this book’s section profile
        </button>
      </nav>
    </section>
  );
}
