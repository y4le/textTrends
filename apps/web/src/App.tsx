import { useEffect, useState } from 'react';
import { KwicPanel } from './components/KwicPanel.tsx';
import { TrendPanel } from './components/TrendPanel.tsx';
import { useApp } from './lib/store-instance.ts';
import { slotColor, slotDash } from './lib/series-style.ts';

/** Term chip: the series' persistent identity (line sample + name) and the
 *  KWIC focus control. aria-pressed carries the focused state. */
function SeriesChip({
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
      title={status === 'error' ? 'query failed' : `show concordance for “${label}”`}
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
      <svg width={22} height={8} aria-hidden="true">
        <line
          x1={1}
          y1={4}
          x2={21}
          y2={4}
          stroke={slotColor(slot)}
          strokeWidth={focused ? 2.5 : 1.5}
          strokeDasharray={slotDash(slot)}
          strokeLinecap={slotDash(slot) === '1 3' ? 'round' : 'butt'}
        />
      </svg>
      {label}
      {status === 'pending' && <span style={{ color: 'var(--fg-muted)' }}>…</span>}
      {status === 'error' && <span style={{ color: 'var(--accent-text)' }}>error</span>}
    </button>
  );
}

export function App() {
  const snapshot = useApp((s) => s.snapshot);
  const loadingPhase = useApp((s) => s.loadingPhase);
  const input = useApp((s) => s.input);
  const setInput = useApp((s) => s.setInput);
  const inputError = useApp((s) => s.inputError);
  const series = useApp((s) => s.series);
  const trends = useApp((s) => s.trends);
  const focusedSeries = useApp((s) => s.focusedSeries);
  const setFocus = useApp((s) => s.setFocus);
  const trendView = useApp((s) => s.trendView);
  const setTrendView = useApp((s) => s.setTrendView);
  const loadSherlock = useApp((s) => s.loadSherlock);
  const loadError = useApp((s) => s.loadError);
  const [draft, setDraft] = useState(input);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) {
      setStarted(true);
      void loadSherlock();
    }
  }, [started, loadSherlock]);

  const focusedId = focusedSeries;

  return (
    <main style={{ padding: 'var(--space-4)', width: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', borderBottom: '1px solid var(--rule-strong)', paddingBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setInput(draft);
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Terms to compare through the corpus, comma-separated"
            placeholder="holmes, moriarty"
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
            : loadingPhase ?? 'loading Sherlock Holmes…'}
        </span>
      </header>
      <div role="status" aria-live="polite">
        {inputError && (
          <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>{inputError}</p>
        )}
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
            <SeriesChip
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
      <div style={{ marginTop: 'var(--space-3)' }}>
        <TrendPanel />
        <KwicPanel />
      </div>
    </main>
  );
}
