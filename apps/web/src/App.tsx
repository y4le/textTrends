import { useEffect, useState } from 'react';
import { KwicPanel } from './components/KwicPanel.tsx';
import { TrendPanel } from './components/TrendPanel.tsx';
import { useApp } from './lib/store-instance.ts';

export function App() {
  const snapshot = useApp((s) => s.snapshot);
  const loadingPhase = useApp((s) => s.loadingPhase);
  const term = useApp((s) => s.term);
  const setTerm = useApp((s) => s.setTerm);
  const loadSherlock = useApp((s) => s.loadSherlock);
  const loadError = useApp((s) => s.loadError);
  const [draft, setDraft] = useState(term);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) {
      setStarted(true);
      void loadSherlock();
    }
  }, [started, loadSherlock]);

  return (
    <main style={{ padding: 'var(--space-4)', maxWidth: '64rem' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', borderBottom: '1px solid var(--rule-strong)', paddingBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(draft);
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Term to trace through the corpus"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              background: 'transparent',
              color: 'var(--fg)',
              border: 'none',
              borderBottom: '1px solid var(--rule-strong)',
              padding: '2px 0',
              width: '16ch',
            }}
          />
        </form>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
          {snapshot
            ? `${snapshot.readyDocs.length}/${snapshot.readyDocs.length + snapshot.missingDocs.length} books ready`
            : loadingPhase ?? 'loading Sherlock Holmes…'}
        </span>
      </header>
      <div role="status" aria-live="polite">
        {loadError && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
            {loadError}{' '}
            <button
              type="button"
              onClick={() => void loadSherlock()}
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
      <div style={{ marginTop: 'var(--space-3)' }}>
        <TrendPanel />
        <KwicPanel />
      </div>
    </main>
  );
}
