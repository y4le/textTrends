import { lazy, Suspense, useState } from 'react';
import { KwicPanel } from './components/KwicPanel.tsx';
import { NotebookPanel } from './components/NotebookPanel.tsx';
import { ProjectPanel } from './components/ProjectPanel.tsx';
import { StructurePanel } from './components/StructurePanel.tsx';
import { useApp } from './lib/store-instance.ts';
import { SeriesLineSample } from './components/chrome.tsx';
import { PinnedPane } from './components/PinnedPane.tsx';

// The chart/interaction surface is the largest main-thread feature module and
// is irrelevant until the notebook has an active series. Keep the initial
// entry within its enforced budget; Vite preloads this chunk on first render.
const TrendPanel = lazy(() =>
  import('./components/TrendPanel.tsx').then(({ TrendPanel: panel }) => ({ default: panel })),
);
const ReaderDrawer = lazy(() =>
  import('./components/ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
);
const CorpusDashboard = lazy(() =>
  import('./components/CorpusDashboard.tsx').then(({ CorpusDashboard: panel }) => ({ default: panel })),
);
const KeynessPanel = lazy(() =>
  import('./components/KeynessPanel.tsx').then(({ KeynessPanel: panel }) => ({ default: panel })),
);

/** Chart-focus chip: the series' persistent identity (line sample + name) and
 *  the CHART-emphasis control (concordance membership is the KwicPanel
 *  toggle chips' job, independent of focus — deliberately a separate control
 *  with its own semantics, not a variant of this one). aria-pressed carries
 *  the focused state. */
function ChartFocusChip({
  label,
  slot,
  focused,
  status,
  onFocus,
}: {
  label: string;
  slot: number;
  focused: boolean;
  status: 'pending' | 'ready' | 'error';
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      aria-pressed={focused}
      title={status === 'error' ? 'query failed' : `emphasize “${label}” in the chart`}
      style={{
        font: 'inherit',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg)',
        background: 'none',
        border: '1px solid',
        borderColor: focused ? 'var(--rule-strong)' : 'transparent',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.75ch',
        padding: '1px 0.75ch',
      }}
    >
      <SeriesLineSample slot={slot} emphasized={focused} />
      {label}
      {status === 'pending' && <span style={{ color: 'var(--fg-muted)' }}>…</span>}
      {status === 'error' && <span style={{ color: 'var(--accent-text)' }}>error</span>}
    </button>
  );
}

export function App() {
  const snapshot = useApp((s) => s.snapshot);
  const loadingPhase = useApp((s) => s.loadingPhase);
  const quickAdd = useApp((s) => s.quickAdd);
  const inputError = useApp((s) => s.inputError);
  const series = useApp((s) => s.series);
  const trends = useApp((s) => s.trends);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const setFocus = useApp((s) => s.setFocus);
  const trendView = useApp((s) => s.trendView);
  const setTrendView = useApp((s) => s.setTrendView);
  const retryAnalysis = useApp((s) => s.retryAnalysis);
  const loadError = useApp((s) => s.loadError);
  const readerPlace = useApp((s) => s.readerPlace);
  const bootstrap = useApp((s) => s.bootstrap);
  const [draft, setDraft] = useState('');

  const focusedId = focusedSeries;

  return (
    <main style={{ padding: 'var(--space-4)', width: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', borderBottom: '1px solid var(--rule-strong)', paddingBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Append-only quick-add: the field clears on submission — the
            // NOTEBOOK below, not this input, is the authoritative group list.
            quickAdd(draft);
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Add terms to the notebook, comma-separated"
            placeholder="add terms: holmes, moriarty"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              background: 'transparent',
              color: 'var(--fg)',
              border: 'none',
              borderBottom: '1px solid var(--rule-strong)',
              padding: '2px 0',
              width: '32ch',
            }}
          />
        </form>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
          {snapshot
            ? `${snapshot.readyDocs.length}/${snapshot.readyDocs.length + snapshot.missingDocs.length} books ready`
            : bootstrap.phase === 'initializing'
              ? 'preparing the built-in project…'
              : loadingPhase ?? 'loading…'}
        </span>
      </header>
      <div role="status" aria-live="polite">
        {inputError && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>{inputError}</p>
        )}
        {bootstrap.phase === 'error' && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            failed to prepare the app: {bootstrap.message} — reload the page to retry
          </p>
        )}
        {loadError && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            {loadError}{' '}
            <button
              type="button"
              onClick={() => retryAnalysis()}
              style={{
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: '1px solid var(--rule-strong)',
                cursor: 'pointer',
                padding: '0 0.5ch',
              }}
            >
              retry
            </button>
          </p>
        )}
      </div>
      {series.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          {series.map((s) => (
            <ChartFocusChip
              key={s.id}
              label={s.label}
              slot={s.styleSlot}
              focused={s.id === focusedId}
              status={trends.get(s.id)?.status ?? 'pending'}
              onFocus={() => setFocus(s.id)}
            />
          ))}
          <span style={{ borderLeft: '1px solid var(--rule)', alignSelf: 'stretch' }} />
          {(['series', 'by-book'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setTrendView(view)}
              aria-pressed={trendView === view}
              style={{
                font: 'inherit',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: trendView === view ? 'var(--fg)' : 'var(--fg-muted)',
                background: 'none',
                border: 'none',
                borderBottom: trendView === view ? '1px solid var(--fg)' : '1px solid transparent',
                cursor: 'pointer',
                padding: '1px 0',
              }}
            >
              {view === 'series' ? 'series' : 'by book'}
            </button>
          ))}
        </div>
      )}
      <NotebookPanel />
      <div style={{ marginTop: 'var(--space-3)' }}>
        {series.length > 0 && (
          <Suspense
            fallback={(
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
                loading analysis view…
              </p>
            )}
          >
            <TrendPanel />
          </Suspense>
        )}
        <PinnedPane />
        <KwicPanel />
      </div>
      <StructurePanel />
      <Suspense fallback={<p style={{ color: 'var(--fg-muted)' }}>loading corpus dashboard…</p>}>
        <CorpusDashboard />
      </Suspense>
      <Suspense fallback={<p style={{ color: 'var(--fg-muted)' }}>loading keyness comparison…</p>}>
        <KeynessPanel />
      </Suspense>
      <ProjectPanel />
      {readerPlace && (
        <Suspense fallback={null}>
          <ReaderDrawer />
        </Suspense>
      )}
    </main>
  );
}
