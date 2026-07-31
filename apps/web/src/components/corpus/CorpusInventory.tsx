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
            <div style={{ overflowX: 'auto' }}>
              <table aria-label="Corpus documents">
                <thead><tr><th scope="col">book</th><th scope="col">selected/full tokens</th><th scope="col">types</th><th scope="col">hapax</th><th scope="col">sentences</th><th scope="col">mean / median / p90</th><th scope="col">paragraph mean</th><th scope="col">TTR</th><th scope="col">MATTR</th><th scope="col">rhythm</th><th scope="col">scope</th></tr></thead>
                <tbody>
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
                    <tr data-focused={focusedDoc === row.doc ? true : undefined}>
                      <th scope="row">
                        <button
                          id={bookTitleControlId(row.doc)}
                          type="button"
                          onClick={() => openBook(row.doc)}
                          aria-pressed={focusedDoc === row.doc}
                          aria-expanded={expanded}
                          aria-controls={bookDetailRegionId(row.doc)}
                          title="Focus this book and show its detail without changing analysis scope"
                        >
                          {titleByDoc.get(row.doc) ?? row.doc}
                        </button>
                      </th>
                      <td>{number.format(row.selectedTokens)} / {number.format(row.fullTokens)}</td>
                      <td>{number.format(row.types)}</td><td>{number.format(row.hapax)}</td><td>{number.format(row.sentences)}</td>
                      <td>{value(row.sentenceMean)} / {value(row.sentenceMedian)} / {value(row.sentenceP90)}</td>
                      <td>{value(row.paragraphMean)}</td><td title="Descriptive and length-dependent">{value(row.ttr)}</td>
                      <td>{value(row.mattr)}{row.mattrIsPlainTtr ? ' (plain TTR in a short run)' : ''}</td>
                      <td><RhythmMark rhythm={result.rhythm} docOrdinal={readyDocs.indexOf(row.doc)} /></td>
                      <td>
                        <OnlyBookButton doc={row.doc} onMessage={setScopeMessage} />
                      </td>
                    </tr>
                    {detail && (
                      <tr data-book-detail>
                        <td colSpan={11}>
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
