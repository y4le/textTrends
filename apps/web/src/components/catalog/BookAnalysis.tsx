import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
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
  type CatalogTotalValue,
} from '../../lib/catalog-totals.ts';
import { fullTokensByDoc } from '../../lib/doc-tokens.ts';
import { BookDetail } from '../corpus/BookDetail.tsx';
import { OnlyBookButton } from '../corpus/OnlyBookButton.tsx';
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
    return <span title="this text is unavailable in the term result">—</span>;
  }
  return (
    <span className="selectable-stat">
      {number.format(value.count)} <span aria-hidden="true">·</span>{' '}
      <span className="catalog-term-rate">{formatRate(value.rate)}</span>
    </span>
  );
}

export function BookAnalysis() {
  const inventory = useApp((s) => s.corpusInventory);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const setFocusedDoc = useApp((s) => s.setFocusedDoc);
  const snapshot = useApp((s) => s.snapshot);
  const series = useApp((s) => s.series);
  const trends = useApp((s) => s.trends);
  const corpusTokenCounts = useApp((s) => s.corpusTokenCounts);
  const layers = useApp((s) => s.layers);
  const pushLayer = useApp((s) => s.pushLayer);
  const replaceLayer = useApp((s) => s.replaceLayer);
  const popLayer = useApp((s) => s.popLayer);
  const [scopeMessage, setScopeMessage] = useState<string | null>(null);
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
    document.getElementById('place-inputs-heading')?.focus({ preventScroll: true });
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
    label: 'Input text',
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
        <h3 id="catalog-book-analysis-heading">Text details</h3>
        {inventory.state.status === 'pending' && <p>computing full-text measurements…</p>}
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
          const totals = catalogTotals({
            scope: 'full',
            docs: readyDocs,
            series,
            baseline: trends,
            ranged: new Map(),
            fullTokens,
            rangeTokens: new Map(),
          });
          const columnCount = 3 + series.length;
          const summaryEntries: readonly (readonly [string, number])[] = [
            ['texts', totals.rows.length],
            ['tokens', totals.corpus.tokens],
            ['types', result.totals.types],
            ['sentences', result.totals.sentences],
            ['paragraphs', result.totals.paragraphs],
          ];
          return (
            <>
              {result.missingDocs.length > 0 && (
                <p style={{ color: 'var(--accent-text)' }}>
                  Partial details: {result.missingDocs.length} expected text{result.missingDocs.length === 1 ? '' : 's'} unavailable.
                </p>
              )}
              {totals.missingDocs.length > 0 && (
                <p style={{ color: 'var(--accent-text)' }}>
                  Exact counts omitted for {totals.missingDocs.length} text{totals.missingDocs.length === 1 ? '' : 's'} whose token extent is unavailable.
                </p>
              )}
              <p className="catalog-analysis-scope">
                Full-text statistics stay stable while you explore ranges elsewhere.
                {' '}Each term cell is exact count <span aria-hidden="true">·</span> rate per {number.format(TREND_RATE_DENOMINATOR)} tokens.
              </p>
              <dl className="catalog-summary">
                {summaryEntries.map(([label, count]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className="selectable-stat">{number.format(count)}</dd>
                  </div>
                ))}
              </dl>
              {scopeMessage && (
                <p role="status" className="catalog-analysis-note">{scopeMessage}</p>
              )}
              <div
                ref={rowNavigation.portRef}
                className="catalog-analysis-port horizontal-data-port"
                role="region"
                tabIndex={0}
                aria-label="Scrollable text details table"
              >
                <table
                  className="catalog-analysis-table"
                  aria-label="Text details · full corpus"
                >
                  <caption>
                    Full-text statistics and exact term counts
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">text</th>
                      <th scope="col">tokens</th>
                      {series.map((term) => (
                        <th key={term.id} scope="col">
                          <span>{term.label}</span>
                          <span className="catalog-term-unit">n · /{number.format(TREND_RATE_DENOMINATOR)}</span>
                        </th>
                      ))}
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
                            selection: null,
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
                                title="Focus this text and show its details without changing analysis scope"
                              >
                                <span className="catalog-book-ordinal" aria-hidden="true">{readyDocs.indexOf(row.doc) + 1}</span>
                                <span aria-hidden="true"> · </span>{title}
                              </button>
                            </th>
                            <td className="catalog-book-tokens">
                              <span className="catalog-cell-label">tokens</span>
                              <span className="selectable-stat">{number.format(row.tokens)}</span>
                            </td>
                            {series.map((term) => (
                              <td key={term.id} className="catalog-term-total">
                                <span className="catalog-cell-label">
                                  {term.label} <span className="catalog-term-unit">n · /{number.format(TREND_RATE_DENOMINATOR)}</span>
                                </span>
                                <TotalValue value={row.values.get(term.id)} />
                              </td>
                            ))}
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
                                        measurementScope="full text"
                                        termCounts={series.map((term) => ({
                                          id: term.id,
                                          label: term.label,
                                          value: row.values.get(term.id),
                                        }))}
                                        onClose={popLayer}
                                        onScopeMessage={setScopeMessage}
                                      />
                                    )
                                  : (
                                      <section
                                        id={bookDetailRegionId(row.doc)}
                                        className="book-detail"
                                        role="region"
                                        aria-label={`Text detail: ${title}`}
                                      >
                                        <header className="book-detail-header">
                                          <h3>{title}</h3>
                                          <button type="button" onClick={() => popLayer()}>close</button>
                                        </header>
                                        <p>
                                          Full-text measurements are unavailable for this input.
                                        </p>
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
                      {series.map((term) => (
                        <td key={term.id} className="catalog-term-total">
                          <span className="catalog-cell-label">
                            {term.label} <span className="catalog-term-unit">n · /{number.format(TREND_RATE_DENOMINATOR)}</span>
                          </span>
                          <TotalValue value={totals.corpus.values.get(term.id)} />
                        </td>
                      ))}
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
