import { useEffect, useMemo, useState } from 'react';
import type {
  FrequencyTokenClassV1,
  KeynessRowV1,
  KeynessSortFieldV1,
} from '../shared/analysis-contract.ts';
import { boundedPageView } from '../lib/bounded-page-view.ts';
import type {
  KeynessInventoryState,
  KeynessTableState,
  KeynessViewV1,
  KwicRowView,
} from '../lib/store.ts';
import { useApp } from '../lib/store-instance.ts';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
  signDisplay: 'always',
});
const SORTS: readonly { by: KeynessSortFieldV1; label: string }[] = [
  { by: 'countA', label: 'A count' },
  { by: 'countB', label: 'B count' },
  { by: 'logRatio', label: 'log₂ ratio' },
  { by: 'g2', label: 'signed G²' },
];

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ');
}

function sideLabel(
  side: 'a' | 'b',
  view: KeynessViewV1,
  titleOf: (doc: string) => string,
): string {
  if (view.mode === 'documents') {
    const doc = side === 'a' ? view.documentA : view.documentB;
    return doc ? titleOf(doc) : 'unavailable';
  }
  if (view.restOn === side) {
    const excluded = side === 'a' ? view.documentB : view.documentA;
    return `all books except ${excluded ? titleOf(excluded) : 'the focus book'}`;
  }
  const doc = side === 'a' ? view.documentA : view.documentB;
  return doc ? titleOf(doc) : 'unavailable';
}

function InventorySummary({
  inventory,
}: {
  inventory: KeynessInventoryState | null;
}) {
  if (!inventory || inventory.state.status === 'pending') {
    return <span style={{ color: 'var(--fg-muted)' }}>summarizing…</span>;
  }
  if (inventory.state.status === 'error') {
    return <span style={{ color: 'var(--accent-text)' }}>{inventory.state.message}</span>;
  }
  const totals = inventory.state.result.totals;
  return (
    <span>
      {number.format(totals.types)} types · {number.format(totals.sentences)} sentences
    </span>
  );
}

function KeynessTable({
  side,
  state,
  view,
  maxEffect,
}: {
  side: 'a' | 'b';
  state: KeynessTableState | null;
  view: KeynessViewV1;
  maxEffect: number;
}) {
  const setSort = useApp((store) => store.setKeynessSort);
  const setPage = useApp((store) => store.setKeynessPage);
  const setPageSize = useApp((store) => store.setKeynessPageSize);
  const openEvidence = useApp((store) => store.openKeynessEvidence);
  const sort = side === 'a' ? view.sortA : view.sortB;
  const requestedPage = side === 'a' ? view.pageA : view.pageB;
  if (!state || state.state.status === 'pending') {
    return <p>ranking {side.toUpperCase()}-key terms…</p>;
  }
  if (state.state.status === 'error') {
    return <p style={{ color: 'var(--accent-text)' }}>{state.state.message}</p>;
  }
  const result = state.state.result;
  const page = boundedPageView(
    result.total,
    requestedPage.offset,
    requestedPage.limit,
    result.rows.length,
  );
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table aria-label={`${side.toUpperCase()}-key terms`}>
          <thead>
            <tr>
              <th scope="col">term</th>
              {SORTS.map(({ by, label }) => (
                <th
                  key={by}
                  scope="col"
                  aria-sort={sort.by === by
                    ? (sort.dir === 1 ? 'ascending' : 'descending')
                    : 'none'}
                >
                  <button type="button" onClick={() => setSort(side, by)}>
                    {label}
                  </button>
                </th>
              ))}
              <th scope="col">A/B rate per 10k</th>
              <th scope="col">A/B range</th>
              <th scope="col">evidence</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row: KeynessRowV1) => (
              <tr key={row.typeId}>
                <th scope="row" style={{ fontFamily: 'var(--font-mono)' }}>
                  {row.key}
                  <span
                    role="img"
                    aria-label={`log ratio ${signed.format(row.logRatio)}`}
                    style={{
                      display: 'inline-block',
                      verticalAlign: 'middle',
                      width: `${Math.max(2, Math.abs(row.logRatio) / maxEffect * 52)}px`,
                      height: 3,
                      marginLeft: 6,
                      background: row.logRatio >= 0
                        ? 'var(--accent-text)'
                        : 'var(--fg-muted)',
                    }}
                  />
                </th>
                <td>{number.format(row.countA)}</td>
                <td>{number.format(row.countB)}</td>
                <td>{signed.format(row.logRatio)}</td>
                <td>{signed.format(row.g2)}</td>
                <td>{decimal.format(row.rateAper10k)} / {decimal.format(row.rateBper10k)}</td>
                <td>{number.format(row.rangeA)} / {number.format(row.rangeB)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => openEvidence(row.key, side)}
                    title={`Open case-sensitive concordance evidence restricted to side ${side.toUpperCase()}`}
                  >
                    concordance
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        <button
          type="button"
          disabled={requestedPage.offset === 0}
          onClick={() => setPage(side, Math.max(0, requestedPage.offset - requestedPage.limit))}
        >
          previous
        </button>
        <span>{page.label}</span>
        <button
          type="button"
          disabled={!page.canNext}
          onClick={() => setPage(side, requestedPage.offset + requestedPage.limit)}
        >
          next
        </button>
        <label>
          rows/page{' '}
          <select
            value={requestedPage.limit}
            onChange={(event) => setPageSize(side, Number(event.currentTarget.value))}
          >
            {[50, 100, 200].map((limit) => (
              <option key={limit} value={limit}>{limit}</option>
            ))}
          </select>
        </label>
      </div>
      {page.atWindow && (
        <p role="status" style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
          The bounded result window ends at 5,000 rows. Narrow the filters to continue.
        </p>
      )}
    </>
  );
}

function EvidenceTable({
  rows,
  titleOf,
}: {
  rows: readonly KwicRowView[];
  titleOf: (doc: string) => string;
}) {
  return (
    <table aria-label="Keyness concordance">
      <thead>
        <tr><th scope="col">book</th><th scope="col">left</th><th scope="col">node</th><th scope="col">right</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={JSON.stringify([row.doc, row.pos, row.node.start, row.node.end])}>
            <td>{titleOf(row.doc)}</td>
            <td style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>{oneLine(row.left).slice(-38)}</td>
            <td style={{ fontWeight: 600 }}>{oneLine(row.nodeText)}</td>
            <td style={{ color: 'var(--fg-muted)' }}>{oneLine(row.right).slice(0, 38)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function KeynessPanel({
  showHeading = true,
}: {
  readonly showHeading?: boolean;
}) {
  const snapshot = useApp((state) => state.snapshot);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const view = useApp((state) => state.keynessView);
  const tableA = useApp((state) => state.keynessA);
  const tableB = useApp((state) => state.keynessB);
  const inventoryA = useApp((state) => state.keynessInventoryA);
  const inventoryB = useApp((state) => state.keynessInventoryB);
  const evidence = useApp((state) => state.keynessEvidence);
  const setMode = useApp((state) => state.setKeynessMode);
  const setDocument = useApp((state) => state.setKeynessDocument);
  const swap = useApp((state) => state.swapKeynessSides);
  const setFilter = useApp((state) => state.setKeynessFilter);
  const closeEvidence = useApp((state) => state.closeKeynessEvidence);
  const [minCount, setMinCount] = useState(view.minCountTotal);
  const [minDocs, setMinDocs] = useState(view.minDocFreqTotal);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setMinCount(view.minCountTotal), [view.minCountTotal]);
  useEffect(() => setMinDocs(view.minDocFreqTotal), [view.minDocFreqTotal]);

  const titleByDoc = useMemo(
    () => new Map((project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title])),
    [project],
  );
  const titleOf = (doc: string) => titleByDoc.get(doc) ?? doc;
  const readyDocs = snapshot?.readyDocs ?? [];
  const maxEffect = Math.max(
    1,
    ...(tableA?.state.status === 'ready'
      ? tableA.state.result.rows.map((row) => Math.abs(row.logRatio))
      : []),
    ...(tableB?.state.status === 'ready'
      ? tableB.state.result.rows.map((row) => Math.abs(row.logRatio))
      : []),
  );
  const toggleClass = (tokenClass: FrequencyTokenClassV1) => {
    const classes = view.classes.includes(tokenClass)
      ? view.classes.filter((value) => value !== tokenClass)
      : [...view.classes, tokenClass];
    if (classes.length === 0) {
      setMessage('Select at least one token class.');
      return;
    }
    setMessage(null);
    setFilter(view.minCountTotal, view.minDocFreqTotal, classes);
  };
  const sideControl = (side: 'a' | 'b') => {
    const isRest = view.mode === 'document-rest' && view.restOn === side;
    const doc = side === 'a' ? view.documentA : view.documentB;
    return isRest
      ? <span>{sideLabel(side, view, titleOf)}</span>
      : (
        <select
          aria-label={`Side ${side.toUpperCase()} book`}
          value={doc ?? ''}
          onChange={(event) => setDocument(side, event.currentTarget.value)}
        >
          {readyDocs.map((candidate) => (
            <option
              key={candidate}
              value={candidate}
              disabled={candidate === (side === 'a' ? view.documentB : view.documentA)}
            >
              {titleOf(candidate)}
            </option>
          ))}
        </select>
      );
  };
  const sideResult = (side: 'a' | 'b') => {
    const table = side === 'a' ? tableA : tableB;
    if (table?.state.status !== 'ready') return null;
    return side === 'a' ? table.state.result.totalsA : table.state.result.totalsB;
  };

  return (
    <section
      aria-labelledby={showHeading ? 'keyness-heading' : undefined}
      aria-label={showHeading ? undefined : 'Keyness comparison'}
      style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--rule-strong)', paddingTop: 'var(--space-3)' }}
    >
      {showHeading && (
        <h2 id="keyness-heading" style={{ fontSize: 'var(--text-md)', margin: 0 }}>
          Compare
        </h2>
      )}
      <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
        Compare explicit sides; the linked trend brush does not redefine this analysis.
      </p>
      {readyDocs.length < 2
        ? <p>Add at least two ready books to compare key terms.</p>
        : (
          <>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <label>
                comparison{' '}
                <select
                  value={view.mode}
                  onChange={(event) => setMode(event.currentTarget.value as KeynessViewV1['mode'])}
                >
                  <option value="documents">book vs book</option>
                  <option value="document-rest">book vs rest</option>
                </select>
              </label>
              <label>side A {sideControl('a')}</label>
              <button type="button" onClick={swap} aria-label="Swap keyness sides">⇄ swap</button>
              <label>side B {sideControl('b')}</label>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !Number.isSafeInteger(minCount) ||
                  minCount < 1 ||
                  !Number.isSafeInteger(minDocs) ||
                  minDocs < 1
                ) {
                  setMessage('Keyness minimums must be whole numbers of at least 1.');
                  return;
                }
                setMessage(null);
                setFilter(minCount, minDocs, view.classes);
              }}
              style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}
            >
              <label>
                combined count ≥{' '}
                <input type="number" min={1} step={1} value={Number.isFinite(minCount) ? minCount : ''} onChange={(event) => setMinCount(event.currentTarget.valueAsNumber)} />
              </label>
              <label>
                combined docs ≥{' '}
                <input type="number" min={1} step={1} value={Number.isFinite(minDocs) ? minDocs : ''} onChange={(event) => setMinDocs(event.currentTarget.valueAsNumber)} />
              </label>
              {(['lexical', 'numeral'] as const).map((tokenClass) => (
                <label key={tokenClass}>
                  <input type="checkbox" checked={view.classes.includes(tokenClass)} onChange={() => toggleClass(tokenClass)} /> {tokenClass}
                </label>
              ))}
              <button type="submit">apply keyness filters</button>
            </form>
            {message && <p role="status" style={{ color: 'var(--accent-text)' }}>{message}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 34rem), 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
              {(['a', 'b'] as const).map((side) => {
                const totals = sideResult(side);
                const inventory = side === 'a' ? inventoryA : inventoryB;
                const table = side === 'a' ? tableA : tableB;
                return (
                  <section key={side} aria-labelledby={`keyness-${side}-heading`}>
                    <h3 id={`keyness-${side}-heading`} style={{ fontSize: 'var(--text-sm)' }}>
                      {side.toUpperCase()}-key · {sideLabel(side, view, titleOf)}
                    </h3>
                    <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
                      {totals
                        ? `${number.format(totals.tokens)} class-filtered tokens · ${number.format(totals.documents)} documents · `
                        : ''}
                      <InventorySummary inventory={inventory} />
                    </p>
                    {totals && totals.tokens < 10_000 && (
                      <p role="note" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-xs)' }}>
                        Small side (&lt;10,000 tokens): ranks may be unstable; inspect the evidence.
                      </p>
                    )}
                    <KeynessTable side={side} state={table} view={view} maxEffect={maxEffect} />
                  </section>
                );
              })}
            </div>
            <details style={{ marginTop: 'var(--space-3)' }}>
              <summary>method and filter notes</summary>
              <p>
                Evidence: <code>keyness-g2-2x2/1</code>. Effect: <code>log-ratio-halves/1</code> with the 0.5 four-cell correction.
                Combined count ≥ {view.minCountTotal}; combined document range ≥ {view.minDocFreqTotal};
                classes: {view.classes.join(', ')}. A-key defaults to descending effect; B-key defaults to ascending effect.
              </p>
              <p><strong>No confidence intervals — see method notes.</strong></p>
            </details>
            {evidence && (
              <section aria-labelledby="keyness-evidence-heading" style={{ marginTop: 'var(--space-3)' }}>
                <h3 id="keyness-evidence-heading" style={{ fontSize: 'var(--text-sm)' }}>
                  {evidence.key} in side {evidence.side.toUpperCase()}
                </h3>
                <button type="button" onClick={closeEvidence}>close evidence</button>
                {evidence.state.status === 'pending' && <p>finding side-restricted evidence…</p>}
                {evidence.state.status === 'error' && <p style={{ color: 'var(--accent-text)' }}>{evidence.state.message}</p>}
                {evidence.state.status === 'ready' && (
                  <>
                    <p>{evidence.state.rows.length} of {number.format(evidence.state.total)} occurrences</p>
                    <EvidenceTable rows={evidence.state.rows} titleOf={titleOf} />
                  </>
                )}
              </section>
            )}
          </>
        )}
    </section>
  );
}
