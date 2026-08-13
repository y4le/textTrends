import { useMemo, useState } from 'react';
import type { Place } from '../lib/places.ts';
import {
  formatProvenanceText,
  formatResultTsv,
  provenanceFor,
  resultTableFor,
  type ProvenanceInput,
} from '../lib/provenance.ts';
import { keynessSelections } from '../lib/store.ts';
import { useApp } from '../lib/store-instance.ts';

async function copyText(text: string): Promise<'copied' | 'unavailable'> {
  if (!navigator.clipboard?.writeText) return 'unavailable';
  await navigator.clipboard.writeText(text);
  return 'copied';
}

export function MethodSummary({ place }: { readonly place: Place }) {
  const snapshot = useApp((state) => state.snapshot);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const inventory = useApp((state) => state.inventory);
  const series = useApp((state) => state.series);
  const trends = useApp((state) => state.trends);
  const trendMeasure = useApp((state) => state.trendMeasure);
  const selectedTrends = useApp((state) => state.selectedTrends);
  const kwic = useApp((state) => state.kwic);
  const kwicEnabledSeries = useApp((state) => state.kwicEnabledSeries);
  const frequency = useApp((state) => state.frequency);
  const frequencyView = useApp((state) => state.frequencyView);
  const keynessView = useApp((state) => state.keynessView);
  const keynessA = useApp((state) => state.keynessA);
  const keynessB = useApp((state) => state.keynessB);
  const [prepared, setPrepared] = useState<'provenance' | 'result' | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const input = useMemo<ProvenanceInput>(() => {
    const sides = snapshot === null
      ? null
      : keynessSelections(keynessView, snapshot.readyDocs);
    const trendLane = linkedSelection === null ? trends : selectedTrends;
    const allTrendsReady = series.length > 0
      && series.every((item) => trendLane.get(item.id)?.status === 'ready');
    return {
      snapshot,
      linkedSelection,
      inventory: inventory?.state.status === 'ready' ? inventory.state.result : null,
      trends: allTrendsReady ? series.flatMap((item) => {
        // Baseline and selected trends are deliberately separate store lanes.
        // A committed range must never relabel the retained baseline as if its
        // denominators came from that range. While the selected overlay is
        // pending — including while only a subset has landed — Method waits
        // rather than carrying stale or incomplete numbers.
        const resident = trendLane.get(item.id);
        return resident?.status === 'ready'
          ? [{ label: item.label, result: resident.trend }]
          : [];
      }) : [],
      trendMeasure,
      concordance: {
        resident: kwic?.resident !== null && kwic?.resident !== undefined,
        enabledTracks: kwicEnabledSeries.size,
        total: kwic?.resident?.total ?? null,
      },
      frequency: {
        view: frequencyView,
        result: frequency?.state.status === 'ready' ? frequency.state.result : null,
      },
      keyness: {
        view: keynessView,
        sideA: sides?.a.docs ?? [],
        sideB: sides?.b.docs ?? [],
        resultA: keynessA?.state.status === 'ready' ? keynessA.state.result : null,
        resultB: keynessB?.state.status === 'ready' ? keynessB.state.result : null,
      },
    };
  }, [
    frequency,
    frequencyView,
    inventory,
    keynessA,
    keynessB,
    keynessView,
    kwic,
    kwicEnabledSeries,
    linkedSelection,
    series,
    selectedTrends,
    snapshot,
    trends,
    trendMeasure,
  ]);
  const provenance = useMemo(() => provenanceFor(input, place), [input, place]);
  const provenanceText = useMemo(
    () => formatProvenanceText(provenance),
    [provenance],
  );
  const resultTable = useMemo(() => resultTableFor(input, place), [input, place]);
  const resultText = useMemo(
    () => resultTable === null ? null : formatResultTsv(resultTable, provenance),
    [provenance, resultTable],
  );
  const methodNames = provenance.methods.map((method) => method.method).join(' + ');

  return (
    <section className="method-summary" aria-labelledby="method-summary-heading">
      <header className="method-summary-header">
        <h3 id="method-summary-heading">Analysis record</h3>
        <p>
          {methodNames || 'waiting for resident results'}
          {' · '}
          {provenance.completeness.status}
        </p>
      </header>
      <div className="method-summary-content">
        <p style={{ marginTop: 0 }}>
          {provenance.completeness.statement}
        </p>
        {provenance.methods.map((method) => (
          <section key={method.method} aria-label={`${method.method} method`}>
            <h3 style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-1)' }}>
              {method.method}
            </h3>
            <dl className="method-parameters">
              {method.parameters.map((item) => (
                <div key={item.name}>
                  <dt>{item.name}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
            {method.limitations.map((limitation) => (
              <p key={limitation} style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
                {limitation}
              </p>
            ))}
          </section>
        ))}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
            marginTop: 'var(--space-2)',
          }}
        >
          <button
            type="button"
            onClick={() => {
              setPrepared('provenance');
              void copyText(provenanceText)
                .then((outcome) => setCopyStatus(outcome === 'copied'
                  ? 'Provenance prepared and copied.'
                  : 'Provenance prepared below; clipboard access is unavailable.'))
                .catch(() => setCopyStatus('Provenance prepared below; clipboard access was unavailable.'));
            }}
          >
            copy provenance
          </button>
          <button
            type="button"
            aria-disabled={resultText === null ? true : undefined}
            title={resultText === null
              ? 'A result export is available after a matching analysis result is ready.'
              : 'Prepare and copy the resident result with its provenance.'}
            onClick={() => {
              if (resultText === null) {
                setCopyStatus('A result export is available after a matching analysis result is ready.');
                return;
              }
              setPrepared('result');
              void copyText(resultText)
                .then((outcome) => setCopyStatus(outcome === 'copied'
                  ? 'TSV prepared and copied.'
                  : 'TSV prepared below; clipboard access is unavailable.'))
                .catch(() => setCopyStatus('TSV prepared below; clipboard access was unavailable.'));
            }}
          >
            copy result as TSV
          </button>
        </div>
        {copyStatus && <p role="status">{copyStatus}</p>}
        {prepared && (
          <pre
            data-testid="prepared-export"
            role="region"
            tabIndex={0}
            aria-label={prepared === 'provenance' ? 'Prepared provenance text' : 'Prepared result TSV'}
            style={{
              overflow: 'auto',
              maxHeight: '18rem',
              padding: 'var(--space-2)',
              border: '1px solid var(--rule)',
              background: 'var(--bg-subtle, var(--bg))',
              fontSize: 'var(--text-xs)',
              whiteSpace: 'pre',
            }}
          >
            {prepared === 'provenance' ? provenanceText : resultText}
          </pre>
        )}
      </div>
    </section>
  );
}
