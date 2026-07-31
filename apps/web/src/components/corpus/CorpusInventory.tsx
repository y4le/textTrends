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
import { StructurePanel } from '../StructurePanel.tsx';
import { BookDetail } from './BookDetail.tsx';
import { GrowthCurve } from './GrowthCurve.tsx';
import { OnlyBookButton } from './OnlyBookButton.tsx';
import { RhythmMark } from './RhythmMark.tsx';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (v: number | null) =>
  v === null || !Number.isFinite(v) ? '—' : decimal.format(v);

export function CorpusInventory({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const inventory = useApp((s) => s.inventory);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const setFocusedDoc = useApp((s) => s.setFocusedDoc);
  const snapshot = useApp((s) => s.snapshot);
  const linkedSelection = useApp((s) => s.linkedSelection);
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
    document.getElementById('place-corpus-heading')?.focus({ preventScroll: true });
    popLayer();
  }, [bookTarget, bookTargetValid, popLayer]);

  const openBook = (doc: string) => {
    setFocusedDoc(doc);
    if (bookTarget?.doc === doc && topLayer?.id === bookLayer?.id) {
      popLayer();
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

  if (!inventory) return null;
  return (
    <>
      <section
        aria-labelledby={showHeading ? 'corpus-dashboard-heading' : undefined}
        aria-label={showHeading ? undefined : 'Corpus overview'}
        style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--rule-strong)', paddingTop: 'var(--space-3)' }}
      >
        {showHeading && (
          <h2 id="corpus-dashboard-heading" style={{ fontSize: 'var(--text-md)', margin: 0 }}>
            Corpus
          </h2>
        )}
        {inventory.selection && <p style={{ color: 'var(--accent-text)' }}>Showing the linked selected range; full-document token totals remain alongside it.</p>}
        {inventory.state.status === 'pending' && <p>computing corpus inventory…</p>}
        {inventory.state.status === 'error' && <p style={{ color: 'var(--accent-text)' }}>{inventory.state.message}</p>}
        {inventory.state.status === 'ready' && (() => {
          const result = inventory.state.result;
          return (
            <>
            {result.missingDocs.length > 0 && <p style={{ color: 'var(--accent-text)' }}>Partial corpus: {result.missingDocs.length} expected document{result.missingDocs.length === 1 ? '' : 's'} unavailable.</p>}
            <dl style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
              {[
                ['tokens', result.totals.tokens],
                ['types', result.totals.types],
                ['hapax', result.totals.hapax],
                ['sentences', result.totals.sentences],
                ['paragraphs', result.totals.paragraphs],
                ['UTF-16 span', result.totals.charsUtf16],
              ].map(([label, count]) => (
                <div key={label as string}><dt style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>{label}</dt><dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{number.format(count as number)}</dd></div>
              ))}
            </dl>
            {scopeMessage && (
              <p role="status" style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
                {scopeMessage}
              </p>
            )}
            <div className="corpus-inventory-port">
              <table className="corpus-inventory" role="table" aria-label="Corpus documents">
                <thead role="rowgroup">
                  <tr role="row">
                    <th role="columnheader" scope="col">book</th>
                    <th role="columnheader" scope="col">readiness</th>
                    <th role="columnheader" scope="col">selected/full tokens</th>
                    <th role="columnheader" scope="col">types</th>
                    <th role="columnheader" scope="col">hapax</th>
                    <th role="columnheader" scope="col">sentences</th>
                    <th role="columnheader" scope="col">mean / median / p90</th>
                    <th role="columnheader" scope="col">paragraph mean</th>
                    <th role="columnheader" scope="col">TTR</th>
                    <th role="columnheader" scope="col">MATTR</th>
                    <th role="columnheader" scope="col">rhythm</th>
                    <th role="columnheader" scope="col">scope</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {result.documents.map((row) => {
                    const expanded = bookTarget?.doc === row.doc;
                    const detail = bookTarget !== null && bookTarget.doc === row.doc
                      ? bookDetailView({
                          target: bookTarget,
                          title: titleByDoc.get(row.doc) ?? row.doc,
                          result,
                          snapshotDocOrdinal: readyDocs.indexOf(row.doc),
                          selection: linkedSelection,
                        })
                      : null;
                    return (
                    <Fragment key={row.doc}>
                    <tr
                      className="corpus-document-row"
                      role="row"
                      data-corpus-document
                      data-focused={focusedDoc === row.doc ? true : undefined}
                    >
                      <th className="corpus-title" role="rowheader" aria-colindex={1} scope="row">
                        <button
                          id={bookTitleControlId(row.doc)}
                          type="button"
                          onClick={() => openBook(row.doc)}
                          aria-expanded={expanded}
                          aria-current={focusedDoc === row.doc ? 'true' : undefined}
                          aria-controls={expanded ? bookDetailRegionId(row.doc) : undefined}
                          title="Focus this book and show its detail without changing analysis scope"
                        >
                          {titleByDoc.get(row.doc) ?? row.doc}
                        </button>
                      </th>
                      <td className="corpus-readiness" role="cell" aria-colindex={2}>
                        {readyDocs.includes(row.doc) ? 'ready' : 'unavailable'}
                      </td>
                      <td className="corpus-tokens" role="cell" aria-colindex={3}>
                        <span className="corpus-selected-tokens">{number.format(row.selectedTokens)}</span>
                        <span className="corpus-token-separator"> / </span>
                        <span>{number.format(row.fullTokens)}</span>
                        <span className="corpus-compact-token-label"> tokens</span>
                      </td>
                      <td role="cell" aria-colindex={4} data-detail-only>{number.format(row.types)}</td>
                      <td role="cell" aria-colindex={5} data-detail-only>{number.format(row.hapax)}</td>
                      <td role="cell" aria-colindex={6} data-detail-only>{number.format(row.sentences)}</td>
                      <td role="cell" aria-colindex={7} data-detail-only>{value(row.sentenceMean)} / {value(row.sentenceMedian)} / {value(row.sentenceP90)}</td>
                      <td role="cell" aria-colindex={8} data-detail-only>{value(row.paragraphMean)}</td>
                      <td role="cell" aria-colindex={9} data-detail-only title="Descriptive and length-dependent">{value(row.ttr)}</td>
                      <td role="cell" aria-colindex={10} data-detail-only>{value(row.mattr)}{row.mattrIsPlainTtr ? ' (plain TTR in a short run)' : ''}</td>
                      <td className="corpus-rhythm" role="cell" aria-colindex={11}><RhythmMark rhythm={result.rhythm} docOrdinal={readyDocs.indexOf(row.doc)} /></td>
                      <td className="corpus-scope" role="cell" aria-colindex={12}>
                        <OnlyBookButton doc={row.doc} onMessage={setScopeMessage} />
                      </td>
                    </tr>
                    {detail && (
                      <tr role="row" data-book-detail>
                        <td role="cell" colSpan={12}>
                          <BookDetail
                            view={detail}
                            growth={result.growth}
                            onClose={popLayer}
                            onScopeMessage={setScopeMessage}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                  })}
                </tbody>
              </table>
            </div>
            {result.growth && <div style={{ marginTop: 'var(--space-3)' }}><h3 style={{ fontSize: 'var(--text-sm)' }}>Vocabulary growth</h3><GrowthCurve growth={result.growth} /></div>}
            </>
          );
        })()}
      </section>
      {bookTarget === null && <StructurePanel headingAs="h3" />}
    </>
  );
}
