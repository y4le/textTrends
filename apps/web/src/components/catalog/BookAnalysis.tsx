import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApp } from '../../lib/store-instance.ts';
import {
  bookDetailRegionId,
  bookDetailView,
  bookSheetTarget,
  bookTitleControlId,
} from '../../lib/corpus-view.ts';
import {
  rowDetailSurface,
  rowDetailWrite,
} from '../../lib/row-detail.ts';
import {
  catalogTotals,
  type CatalogTotalsScope,
  type CatalogTotalValue,
} from '../../lib/catalog-totals.ts';
import { fullTokensByDoc } from '../../lib/doc-tokens.ts';
import { SMALL_BUTTON_STYLE } from '../chrome.tsx';
import { usePresentation } from '../PresentationProvider.tsx';
import { BookDetail } from '../corpus/BookDetail.tsx';
import { OnlyBookButton } from '../corpus/OnlyBookButton.tsx';
import { RhythmMark } from '../corpus/RhythmMark.tsx';
import { SourceDetails } from './SourceDetails.tsx';
import { useRowNavigation } from '../useRowNavigation.ts';
import { formatRate } from '../../lib/rate-format.ts';

const number = new Intl.NumberFormat('en-US');

function TotalValue({ value }: { readonly value: CatalogTotalValue | undefined }) {
  if (!value || value.status === 'pending') {
    return <span title="query totals pending">…</span>;
  }
  if (value.status === 'error') {
    return <span title={value.message} style={{ color: 'var(--accent-text)' }}>error</span>;
  }
  if (value.status === 'unavailable') {
    return <span title="this book is unavailable in the query result">—</span>;
  }
  return (
    <span className="selectable-stat">
      {number.format(value.count)} <span aria-hidden="true">·</span>{' '}
      <span className="catalog-term-rate">{formatRate(value.rate)}</span>
    </span>
  );
}

export function BookAnalysis() {
  const inventory = useApp((s) => s.inventory);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const setFocusedDoc = useApp((s) => s.setFocusedDoc);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const series = useApp((s) => s.series);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const trends = useApp((s) => s.trends);
  const selectedTrends = useApp((s) => s.selectedTrends);
  const trendMeasure = useApp((s) => s.trendMeasure);
  const corpusTokenCounts = useApp((s) => s.corpusTokenCounts);
  const layers = useApp((s) => s.layers);
  const pushLayer = useApp((s) => s.pushLayer);
  const replaceLayer = useApp((s) => s.replaceLayer);
  const popLayer = useApp((s) => s.popLayer);
  const presentation = usePresentation();
  const [scopeMessage, setScopeMessage] = useState<string | null>(null);
  const [scopeChoice, setScopeChoice] = useState<{
    readonly selection: typeof linkedSelection;
    readonly scope: CatalogTotalsScope;
  }>(() => ({
    selection: linkedSelection,
    scope: linkedSelection === null ? 'full' : 'range',
  }));
  const [showAllTotals, setShowAllTotals] = useState(false);
  const hasRange = linkedSelection !== null;
  const totalsScope: CatalogTotalsScope = linkedSelection === null
    ? 'full'
    : scopeChoice.selection === linkedSelection
      ? scopeChoice.scope
      : 'range';
  const readyDocs = snapshot?.readyDocs ?? [];
  const project = useApp((s) => s.projectSession?.project ?? null);
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const topLayer = layers.at(-1);
  const bookLayer = layers.find(
    (layer) => layer.kind === 'row-detail' && bookSheetTarget(layer.target) !== null,
  ) ?? null;
  const bookTarget = bookLayer === null ? null : bookSheetTarget(bookLayer.target);
  const bookTargetValid = bookTarget === null || readyDocs.includes(bookTarget.doc);
  const stalePopRequested = useRef(false);

  useEffect(() => {
    stalePopRequested.current = false;
  }, [bookLayer?.id]);

  useEffect(() => {
    if (bookTarget === null || bookTargetValid || stalePopRequested.current) return;
    stalePopRequested.current = true;
    document.getElementById('place-catalog-heading')?.focus({ preventScroll: true });
    popLayer();
  }, [bookTarget, bookTargetValid, popLayer]);

  const openBook = (doc: string) => {
    setFocusedDoc(doc);
    if (bookTarget?.doc === doc && bookLayer !== null) {
      const bookIndex = layers.findIndex((layer) => layer.id === bookLayer.id);
      popLayer(bookIndex < 0 ? 1 : layers.length - bookIndex);
      return;
    }
    const target = Object.freeze({ surface: 'book-sheet' as const, doc });
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      'book-sheet',
    );
    if (write === 'replace') {
      replaceLayer('row-detail', target, bookTitleControlId(doc));
    } else {
      pushLayer('row-detail', target, bookTitleControlId(doc));
    }
  };
  const rowNavigation = useRowNavigation({
    keys: readyDocs,
    label: 'Catalog book',
    preferredKey: focusedDoc,
    onFocusKey: setFocusedDoc,
    onExit: () => {
      if (bookTarget === null || bookLayer === null) return false;
      const bookIndex = layers.findIndex((layer) => layer.id === bookLayer.id);
      popLayer(bookIndex < 0 ? 1 : layers.length - bookIndex);
      return true;
    },
  });

  if (!inventory) return null;
  return (
    <>
      <section
        aria-labelledby="catalog-book-analysis-heading"
        className="catalog-book-analysis"
      >
        <h3 id="catalog-book-analysis-heading">Book analysis</h3>
        {inventory.state.status === 'pending' && <p>computing book measurements…</p>}
        {inventory.state.status === 'error' && (
          <p style={{ color: 'var(--accent-text)' }}>{inventory.state.message}</p>
        )}
        {inventory.state.status === 'ready' && (() => {
          const result = inventory.state.result;
          const fullTokens = new Map<string, number>();
          for (const doc of readyDocs) {
            const tokens = fullTokensByDoc(doc, { corpusTokenCounts, inventory, trends });
            if (tokens !== null) fullTokens.set(doc, tokens);
          }
          const rangeTokens = new Map(
            result.documents.map((row) => [row.doc, row.selectedTokens] as const),
          );
          const totals = catalogTotals({
            scope: totalsScope,
            docs: readyDocs,
            series,
            baseline: trends,
            ranged: selectedTrends,
            fullTokens,
            rangeTokens,
            denominator: trendMeasure.kind === 'rate' ? trendMeasure.denominator : 10_000,
          });
          const compact = presentation.width === 'compact';
          const focusedTerm = series.find((term) => term.id === focusedSeries) ?? series[0] ?? null;
          const visibleSeries = compact && !showAllTotals && focusedTerm
            ? [focusedTerm]
            : series;
          const columnCount = 4 + visibleSeries.length;
          const inventoryMatchesTotals = totalsScope === (hasRange ? 'range' : 'full');
          const scopeLabel = totalsScope === 'range' ? 'active range' : 'full corpus';
          const summaryEntries: readonly (readonly [string, number])[] = [
            ['books', totals.rows.length],
            ['tokens', totals.corpus.tokens],
            ...(inventoryMatchesTotals
              ? [
                  ['types', result.totals.types] as const,
                  ['sentences', result.totals.sentences] as const,
                  ['paragraphs', result.totals.paragraphs] as const,
                ]
              : []),
          ];
          return (
            <>
              {result.missingDocs.length > 0 && (
                <p style={{ color: 'var(--accent-text)' }}>
                  Partial catalog: {result.missingDocs.length} expected book{result.missingDocs.length === 1 ? '' : 's'} unavailable.
                </p>
              )}
              {totals.missingDocs.length > 0 && (
                <p style={{ color: 'var(--accent-text)' }}>
                  Exact totals omitted for {totals.missingDocs.length} book{totals.missingDocs.length === 1 ? '' : 's'} whose token extent is unavailable.
                </p>
              )}
              <p className="catalog-analysis-scope">
                Comparing {number.format(totals.rows.length)} book{totals.rows.length === 1 ? '' : 's'} across the {scopeLabel}.
                {' '}Term cells are exact count <span aria-hidden="true">·</span> rate per {number.format(totals.denominator)} tokens.
              </p>
              <dl className="catalog-summary">
                {summaryEntries.map(([label, count]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className="selectable-stat">{number.format(count)}</dd>
                  </div>
                ))}
              </dl>
              {hasRange && (
                <div className="catalog-analysis-controls" role="group" aria-label="Book totals scope">
                  <span>totals:</span>
                  {(['range', 'full'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      aria-pressed={totalsScope === scope}
                      onClick={() => setScopeChoice({ selection: linkedSelection, scope })}
                      style={SMALL_BUTTON_STYLE}
                    >
                      {scope === 'range' ? 'active range' : 'full corpus'}
                    </button>
                  ))}
                </div>
              )}
              {compact && series.length > 1 && (
                <div className="catalog-analysis-controls" role="group" aria-label="Book totals terms">
                  <span>
                    {showAllTotals ? `${series.length} query terms` : `${focusedTerm?.label ?? ''} totals`}
                  </span>
                  <button
                    type="button"
                    aria-pressed={showAllTotals}
                    onClick={() => setShowAllTotals((current) => !current)}
                    style={SMALL_BUTTON_STYLE}
                  >
                    {showAllTotals ? 'show focused query totals' : 'show all query totals'}
                  </button>
                </div>
              )}
              {scopeMessage && (
                <p role="status" className="catalog-analysis-note">{scopeMessage}</p>
              )}
              <div
                ref={rowNavigation.portRef}
                className="catalog-analysis-port horizontal-data-port"
                role="region"
                tabIndex={0}
                aria-label="Scrollable book analysis table"
              >
                <table
                  className="catalog-analysis-table"
                  aria-label={`Book analysis · ${scopeLabel}`}
                >
                  <caption>
                    Exact totals by book · {scopeLabel}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">book</th>
                      <th scope="col">tokens</th>
                      {visibleSeries.map((term) => (
                        <th key={term.id} scope="col">
                          <span>{term.label}</span>
                          <span className="catalog-term-unit">n · /{number.format(totals.denominator)}</span>
                        </th>
                      ))}
                      <th scope="col">rhythm</th>
                      <th scope="col">scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {totals.rows.map((row) => {
                      const inventoryRow = result.documents.find((candidate) => candidate.doc === row.doc);
                      const expanded = bookTarget?.doc === row.doc;
                      const detail = expanded && inventoryRow
                        ? bookDetailView({
                            target: bookTarget,
                            title: titleByDoc.get(row.doc) ?? row.doc,
                            result,
                            snapshotDocOrdinal: readyDocs.indexOf(row.doc),
                            selection: linkedSelection,
                          })
                        : null;
                      const title = titleByDoc.get(row.doc) ?? row.doc;
                      return (
                        <Fragment key={row.doc}>
                          <tr
                            className="catalog-book-row"
                            data-catalog-book
                            data-focused={focusedDoc === row.doc ? true : undefined}
                          >
                            <th className="catalog-book-title" scope="row">
                              <button
                                {...rowNavigation.controlProps(row.doc)}
                                id={bookTitleControlId(row.doc)}
                                type="button"
                                onClick={() => openBook(row.doc)}
                                aria-expanded={expanded}
                                aria-current={focusedDoc === row.doc ? 'true' : undefined}
                                aria-controls={expanded ? bookDetailRegionId(row.doc) : undefined}
                                title="Focus this book and show its detail without changing analysis scope"
                              >
                                <span className="catalog-book-ordinal" aria-hidden="true">{readyDocs.indexOf(row.doc) + 1}</span>
                                <span aria-hidden="true"> · </span>{title}
                              </button>
                            </th>
                            <td className="catalog-book-tokens">
                              <span className="catalog-cell-label">tokens</span>
                              <span className="selectable-stat">{number.format(row.tokens)}</span>
                            </td>
                            {visibleSeries.map((term) => (
                              <td key={term.id} className="catalog-term-total">
                                <span className="catalog-cell-label">
                                  {term.label} <span className="catalog-term-unit">n · /{number.format(totals.denominator)}</span>
                                </span>
                                <TotalValue value={row.values.get(term.id)} />
                              </td>
                            ))}
                            <td className="catalog-book-rhythm">
                              <span className="catalog-cell-label">rhythm</span>
                              {inventoryMatchesTotals && inventoryRow
                                ? <RhythmMark rhythm={result.rhythm} docOrdinal={readyDocs.indexOf(row.doc)} />
                                : <span title="rhythm follows the active range">—</span>}
                            </td>
                            <td className="catalog-book-scope">
                              <OnlyBookButton doc={row.doc} onMessage={setScopeMessage} />
                            </td>
                          </tr>
                          {expanded && (
                            <tr data-book-detail>
                              <td colSpan={columnCount}>
                                {detail
                                  ? (
                                      <BookDetail
                                        view={detail}
                                        growth={result.growth}
                                        measurementScope={hasRange ? 'active range' : 'full book'}
                                        onClose={popLayer}
                                        onScopeMessage={setScopeMessage}
                                      />
                                    )
                                  : (
                                      <section
                                        id={bookDetailRegionId(row.doc)}
                                        className="book-detail"
                                        role="region"
                                        aria-label={`Book detail: ${title}`}
                                      >
                                        <header className="book-detail-header">
                                          <h3>{title}</h3>
                                          <button type="button" onClick={() => popLayer()}>close</button>
                                        </header>
                                        <p>
                                          This book’s measurements are not resident while the linked range excludes it.
                                        </p>
                                        <button type="button" onClick={() => setLinkedSelection(null)}>
                                          clear range and inspect this book
                                        </button>
                                      </section>
                                    )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="catalog-corpus-row">
                      <th scope="row">corpus</th>
                      <td>
                        <span className="catalog-cell-label">tokens</span>
                        <span className="selectable-stat">{number.format(totals.corpus.tokens)}</span>
                      </td>
                      {visibleSeries.map((term) => (
                        <td key={term.id} className="catalog-term-total">
                          <span className="catalog-cell-label">
                            {term.label} <span className="catalog-term-unit">n · /{number.format(totals.denominator)}</span>
                          </span>
                          <TotalValue value={totals.corpus.values.get(term.id)} />
                        </td>
                      ))}
                      <td aria-label="not applicable">—</td>
                      <td aria-label="not applicable">—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <span className="visually-hidden" role="status" aria-live="polite">
                {rowNavigation.status}
              </span>
            </>
          );
        })()}
      </section>
      {bookTarget === null && <SourceDetails headingAs="h3" />}
    </>
  );
}
