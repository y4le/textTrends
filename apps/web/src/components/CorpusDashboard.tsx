import { useEffect, useMemo, useState } from 'react';
import type {
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
  InventoryGrowthV1,
  InventoryRhythmV1,
} from '../shared/analysis-contract.ts';
import { FREQUENCY_PREFIX_MAX_UNITS } from '@texttrends/core';
import {
  frequencyFilterError,
  frequencyPageView,
  rhythmBinsForDocument,
  rhythmDescription,
} from '../lib/corpus-dashboard-view.ts';
import { TFIDF_SECTION_MIN_TOKENS } from '../lib/store.ts';
import { useApp } from '../lib/store-instance.ts';
import { fullTokensByDoc } from '../lib/doc-tokens.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (v: number | null) =>
  v === null || !Number.isFinite(v) ? '—' : decimal.format(v);

function GrowthCurve({ growth }: { growth: InventoryGrowthV1 }) {
  const width = 560;
  const height = 120;
  const maxTokens = growth.tokens.at(-1) ?? 0;
  const maxTypes = growth.types.at(-1) ?? 0;
  const points = Array.from(growth.tokens, (tokens, i) => {
    const x = maxTokens === 0 ? 0 : tokens / maxTokens * width;
    const y = maxTypes === 0 ? height : height - (growth.types[i] as number) / maxTypes * height;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Vocabulary growth to ${number.format(maxTypes)} types over ${number.format(maxTokens)} selected tokens`}
        style={{ width: '100%', maxWidth: width, height, display: 'block', borderLeft: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}
      >
        <polyline points={points} fill="none" stroke="var(--accent-text)" strokeWidth="1.5" />
      </svg>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
          exact growth values
        </summary>
        <table>
          <thead><tr><th scope="col">selected tokens</th><th scope="col">types seen</th></tr></thead>
          <tbody>
            {Array.from(growth.tokens, (tokens, i) => (
              <tr key={`${tokens}:${i}`}>
                <td>{number.format(tokens)}</td>
                <td>{number.format(growth.types[i] as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function RhythmSummary({ rhythm, docOrdinal }: { rhythm: InventoryRhythmV1 | null; docOrdinal: number }) {
  if (!rhythm) return <>—</>;
  const bins = rhythmBinsForDocument(rhythm, docOrdinal);
  const max = Math.max(1, ...bins.map((bin) => Number.isFinite(bin.mean) ? bin.mean : 0));
  return (
    <span
      role="img"
      aria-label={rhythmDescription(bins, value)}
      style={{ display: 'inline-flex', gap: 1, height: 22, alignItems: 'end' }}
    >
      {bins.map((bin, i) => (
        <span
          key={i}
          title={`bin ${i + 1}: mean ${value(bin.mean)} tokens`}
          style={{
            display: 'inline-block',
            width: 3,
            height: Number.isFinite(bin.mean) ? Math.max(1, bin.mean / max * 22) : 1,
            background: bin.tokens === 0 ? 'var(--rule)' : 'var(--accent-text)',
            opacity: bin.tokens === 0 ? 0.4 : 0.75,
          }}
        />
      ))}
    </span>
  );
}

const SORTS: readonly { by: FrequencySortFieldV1; label: string }[] = [
  { by: 'key', label: 'term' },
  { by: 'count', label: 'count' },
  { by: 'docFreq', label: 'docs' },
  { by: 'dp', label: 'DP' },
  { by: 'dpNorm', label: 'DPnorm' },
];

export function FrequencyTable({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const state = useApp((s) => s.frequency);
  const view = useApp((s) => s.frequencyView);
  const setSort = useApp((s) => s.setFrequencySort);
  const setFilter = useApp((s) => s.setFrequencyFilter);
  const setClasses = useApp((s) => s.setFrequencyClasses);
  const setPage = useApp((s) => s.setFrequencyPage);
  const setPageSize = useApp((s) => s.setFrequencyPageSize);
  const addTerm = useApp((s) => s.addFrequencyTerm);
  const showInKwic = useApp((s) => s.showFrequencyTermInKwic);
  const [prefix, setPrefixDraft] = useState(view.prefixNfc ?? '');
  const [minCount, setMinCount] = useState(view.minCount);
  const [minDocFreq, setMinDocFreq] = useState(view.minDocFreq);
  const [filterMessage, setFilterMessage] = useState<string | null>(null);
  useEffect(() => setPrefixDraft(view.prefixNfc ?? ''), [view.prefixNfc]);
  useEffect(() => setMinCount(view.minCount), [view.minCount]);
  useEffect(() => setMinDocFreq(view.minDocFreq), [view.minDocFreq]);

  const toggleClass = (tokenClass: FrequencyTokenClassV1) => {
    const next = view.classes.includes(tokenClass)
      ? view.classes.filter((item) => item !== tokenClass)
      : [...view.classes, tokenClass];
    if (next.length === 0) {
      setFilterMessage('Select at least one token class.');
      return;
    }
    setFilterMessage(null);
    setClasses(next);
  };
  const page = state?.state.status === 'ready'
    ? frequencyPageView(
        state.state.result.total,
        view.page.offset,
        view.page.limit,
        state.state.result.rows.length,
      )
    : null;

  return (
    <section
      aria-labelledby={showHeading ? 'frequency-heading' : undefined}
      aria-label={showHeading ? undefined : 'Vocabulary frequency'}
    >
      {showHeading && (
        <h2 id="frequency-heading" style={{ fontSize: 'var(--text-md)' }}>
          Vocabulary
        </h2>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const error = frequencyFilterError(minCount, minDocFreq);
          if (error) {
            setFilterMessage(error);
            return;
          }
          setFilterMessage(null);
          setFilter(minCount, minDocFreq, prefix);
        }}
        style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <label>
          starts with{' '}
          <input
            value={prefix}
            maxLength={FREQUENCY_PREFIX_MAX_UNITS}
            onChange={(event) => setPrefixDraft(event.target.value)}
            style={{ width: '14ch' }}
          />
        </label>
        <label>
          count ≥{' '}
          <input
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(minCount) ? minCount : ''}
            onChange={(event) => setMinCount(event.currentTarget.valueAsNumber)}
            style={{ width: '7ch' }}
          />
        </label>
        <label>
          docs ≥{' '}
          <input
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(minDocFreq) ? minDocFreq : ''}
            onChange={(event) => setMinDocFreq(event.currentTarget.valueAsNumber)}
            style={{ width: '6ch' }}
          />
        </label>
        <button type="submit">apply</button>
        {(['lexical', 'numeral'] as const).map((tokenClass) => (
          <label key={tokenClass}>
            <input type="checkbox" checked={view.classes.includes(tokenClass)} onChange={() => toggleClass(tokenClass)} /> {tokenClass}
          </label>
        ))}
      </form>
      {filterMessage && <p role="status" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-xs)' }}>{filterMessage}</p>}
      {state?.state.status === 'pending' && <p>ranking vocabulary…</p>}
      {state?.state.status === 'error' && <p style={{ color: 'var(--accent-text)' }}>{state.state.message}</p>}
      {state?.state.status === 'ready' && (
        <>
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
            {number.format(state.state.result.total)} matching types · rates use {number.format(state.state.result.totalTokens)} selected class tokens · DP parts are selected documents
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table aria-label="Vocabulary frequency list">
              <thead>
                <tr>
                  {SORTS.map(({ by, label }) => (
                    <th key={by} scope="col" aria-sort={view.sort.by === by ? (view.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => setSort(by)}>{label}</button>
                    </th>
                  ))}
                  <th scope="col">rate/10k</th>
                  <th scope="col">class</th>
                  <th scope="col">actions</th>
                </tr>
              </thead>
              <tbody>
                {state.state.result.rows.map((row) => (
                  <tr key={row.typeId}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{row.key}</td>
                    <td>{number.format(row.count)}</td>
                    <td>{number.format(row.docFreq)}</td>
                    <td>{value(row.dp)}</td>
                    <td>{value(row.dpNorm)}</td>
                    <td>{decimal.format(row.ratePer10k)}</td>
                    <td>{row.class}</td>
                    <td>
                      <button type="button" onClick={() => addTerm(row.key)} title="Add this exact, case-sensitive term as a notebook group">
                        add exact
                      </button>
                      {' '}
                      <button type="button" onClick={() => showInKwic(row.key)} title="Show this exact, case-sensitive term in the concordance">
                        concordance
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <button type="button" disabled={view.page.offset === 0} onClick={() => setPage(Math.max(0, view.page.offset - view.page.limit))}>previous</button>
            <span>{page?.label}</span>
            <button type="button" disabled={!page?.canNext} onClick={() => setPage(view.page.offset + view.page.limit)}>next</button>
            <label>
              rows/page{' '}
              <select value={view.page.limit} onChange={(event) => setPageSize(Number(event.currentTarget.value))}>
                {[50, 100, 200].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
              </select>
            </label>
          </div>
          {page?.atWindow && (
            <p role="status" style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
              The bounded result window ends at 5,000 rows. Narrow the filters to continue.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function CorpusDashboard({
  showHeading = true,
  showVocabulary = true,
}: {
  readonly showHeading?: boolean;
  readonly showVocabulary?: boolean;
}) {
  const inventory = useApp((s) => s.inventory);
  const tfidf = useApp((s) => s.tfidf);
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
                      <td><RhythmSummary rhythm={result.rhythm} docOrdinal={readyDocs.indexOf(row.doc)} /></td>
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
            {result.sections && (() => {
              const sectionDoc = focusedDoc ?? result.documents[0]?.doc ?? null;
              const rows = sectionDoc === null
                ? []
                : result.sections.rows.filter((row) => row.doc === sectionDoc);
              const maxTokens = Math.max(1, ...rows.map((row) => row.selectedTokens));
              return (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <h3 style={{ fontSize: 'var(--text-sm)' }}>Focused-book section profile</h3>
                  {result.sections.truncated && (
                    <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-xs)' }}>
                      Section summaries reached the bounded result cap; later sections are omitted.
                    </p>
                  )}
                  {rows.length === 0
                    ? <p>No section summaries are available for this book and selection.</p>
                    : (
                      <>
                        <div
                          role="img"
                          aria-label={`${rows.length} section vocabulary strip for ${titleByDoc.get(sectionDoc!) ?? sectionDoc}`}
                          style={{ display: 'flex', alignItems: 'end', gap: 2, height: 48, maxWidth: 560 }}
                        >
                          {rows.map((row) => (
                            <span
                              key={row.id}
                              aria-hidden="true"
                              title={`${row.title ?? row.id}: ${number.format(row.selectedTokens)} selected tokens, ${number.format(row.types)} types`}
                              style={{
                                flex: 1,
                                minWidth: 2,
                                height: Math.max(2, row.selectedTokens / maxTokens * 48),
                                background: 'var(--accent-text)',
                                opacity: 0.7,
                              }}
                            />
                          ))}
                        </div>
                        <details>
                          <summary>exact section values</summary>
                          <table aria-label="Focused-book section values">
                            <thead><tr><th scope="col">section</th><th scope="col">selected tokens</th><th scope="col">types</th><th scope="col">sentences</th><th scope="col">sentence mean</th></tr></thead>
                            <tbody>
                              {rows.map((row) => (
                                <tr key={row.id}>
                                  <th scope="row">{row.title ?? `section ${row.id.slice(0, 8)}`}</th>
                                  <td>{number.format(row.selectedTokens)}</td>
                                  <td>{number.format(row.types)}</td>
                                  <td>{number.format(row.sentences)}</td>
                                  <td>{value(row.sentenceMean)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </details>
                      </>
                    )}
                </div>
              );
            })()}
            {result.growth && <div style={{ marginTop: 'var(--space-3)' }}><h3 style={{ fontSize: 'var(--text-sm)' }}>Vocabulary growth</h3><GrowthCurve growth={result.growth} /></div>}
            <div style={{ marginTop: 'var(--space-3)' }}>
              <h3 style={{ fontSize: 'var(--text-sm)' }}>Focused-book chapter labels</h3>
              {tfidf?.state.status === 'pending' && <p>comparing chapters…</p>}
              {tfidf?.state.status === 'error' && <p style={{ color: 'var(--accent-text)' }}>{tfidf.state.message}</p>}
              {tfidf?.state.status === 'ready' && tfidf.state.result.eligibleSections < 2 && <p>Not enough chapters to compare.</p>}
              {tfidf?.state.status === 'ready' && tfidf.state.result.eligibleSections >= 2 && (
                <ol>
                  {tfidf.state.result.sections.map((section) => (
                    <li key={section.id}>
                      <strong>{section.title ?? `section ${section.id.slice(0, 8)}`}</strong>
                      {section.eligible
                        ? <> — {section.labels.length === 0 ? 'no distinctive labels' : section.labels.map((label) => label.key).join(', ')}</>
                        : <> — below the {TFIDF_SECTION_MIN_TOKENS} token threshold</>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            </>
          );
        })()}
      </section>
      {showVocabulary && <FrequencyTable />}
    </>
  );
}
