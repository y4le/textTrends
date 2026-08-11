import { lazy, Suspense } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { usePresentation } from '../components/PresentationProvider.tsx';

const TrendPanel = lazy(() =>
  import('../components/TrendPanel.tsx').then(({ TrendPanel: panel }) => ({ default: panel })),
);

export function TrendsPlace() {
  const series = useApp((state) => state.series);
  const trendView = useApp((state) => state.trendView);
  const setTrendView = useApp((state) => state.setTrendView);
  const presentation = usePresentation();

  return (
    <>
      {series.length > 0 && (
        <div
          role="group"
          aria-label="Trend view"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          {(['series', 'by-book'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setTrendView(view)}
              aria-pressed={trendView === view}
              style={{
                font: 'inherit',
                fontFamily: 'var(--font-mono)',
                fontSize: presentation.width === 'compact'
                  ? 'var(--text-sm)'
                  : 'var(--text-xs)',
                color: trendView === view ? 'var(--fg)' : 'var(--fg-muted)',
                background: 'none',
                border: 'none',
                borderBottom: trendView === view ? '1px solid var(--fg)' : '1px solid transparent',
                cursor: 'pointer',
                minHeight: 44,
                padding: 'var(--space-1) var(--space-2)',
              }}
            >
              {view === 'series' ? 'series' : 'by book'}
            </button>
          ))}
        </div>
      )}
      <div className="analysis-stack" style={{ marginTop: 'var(--space-3)' }}>
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
      </div>
    </>
  );
}
