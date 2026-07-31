import { useEffect, useState } from 'react';
import type {
  FrequencySortFieldV1,
  FrequencyTokenClassV1,
} from '../../shared/analysis-contract.ts';
import { FREQUENCY_PREFIX_MAX_UNITS } from '@texttrends/core';
import {
  frequencyFilterError,
  frequencyPageView,
} from '../../lib/corpus-dashboard-view.ts';
import { useApp } from '../../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

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
  const state = useApp((store) => store.frequency);
  const view = useApp((store) => store.frequencyView);
  const setSort = useApp((store) => store.setFrequencySort);
  const setFilter = useApp((store) => store.setFrequencyFilter);
  const setClasses = useApp((store) => store.setFrequencyClasses);
  const setPage = useApp((store) => store.setFrequencyPage);
  const setPageSize = useApp((store) => store.setFrequencyPageSize);
  const addTerm = useApp((store) => store.addFrequencyTerm);
  const showInKwic = useApp((store) => store.showFrequencyTermInKwic);
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
