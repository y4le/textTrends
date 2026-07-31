import { useMemo, useState } from 'react';
import { useApp } from '../../lib/store-instance.ts';
import { fullTokensByDoc } from '../../lib/doc-tokens.ts';
import { GrowthCurve } from './GrowthCurve.tsx';
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
  const trends = useApp((s) => s.trends);
  const linkedSelection = useApp((s) => s.linkedSelection);
  const setLinkedSelection = useApp((s) => s.setLinkedSelection);
  const [scopeMessage, setScopeMessage] = useState<string | null>(null);
  const readyDocs = snapshot?.readyDocs ?? [];
  const project = useApp((s) => s.projectSession?.project ?? null);
  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );

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
                  {result.documents.map((row) => (
                    <tr key={row.doc}>
                      <th scope="row">
                        <button
                          type="button"
                          onClick={() => setFocusedDoc(row.doc)}
                          aria-pressed={focusedDoc === row.doc}
                          title="Focus this book without changing analysis scope"
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
                        {(() => {
                          const fullTokens = fullTokensByDoc(row.doc, { inventory, trends });
                          const unavailable = fullTokens === null || snapshot === null;
                          const isOnlyThisBook = linkedSelection !== null
                            && linkedSelection.doc === row.doc
                            && linkedSelection.tokens.start === 0
                            && linkedSelection.tokens.end === fullTokens;
                          return (
                            <button
                              className="coarse-target"
                              type="button"
                              aria-disabled={unavailable ? true : undefined}
                              title={unavailable
                                ? 'The full token extent is not available yet.'
                                : isOnlyThisBook
                                  ? 'Restore analysis scope to all ready books.'
                                  : 'Use this whole book as the linked analysis scope.'}
                              onClick={() => {
                                if (snapshot === null || fullTokens === null) {
                                  setScopeMessage('The full token extent is not available yet.');
                                  return;
                                }
                                setScopeMessage(null);
                                setLinkedSelection(isOnlyThisBook
                                  ? null
                                  : {
                                      snapshot: snapshot.snapshot,
                                      doc: row.doc,
                                      tokens: { start: 0, end: fullTokens },
                                    });
                              }}
                            >
                              {isOnlyThisBook ? 'all books' : 'only this book'}
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.growth && <div style={{ marginTop: 'var(--space-3)' }}><h3 style={{ fontSize: 'var(--text-sm)' }}>Vocabulary growth</h3><GrowthCurve growth={result.growth} /></div>}
            </>
          );
        })()}
      </section>
    </>
  );
}
