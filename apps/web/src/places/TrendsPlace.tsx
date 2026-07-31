import { lazy, Suspense } from 'react';
import { NotebookPanel } from '../components/NotebookPanel.tsx';
import { MethodSummary } from '../components/MethodSummary.tsx';
import { SeriesLineSample } from '../components/chrome.tsx';
import { useApp } from '../lib/store-instance.ts';

const TrendPanel = lazy(() =>
  import('../components/TrendPanel.tsx').then(({ TrendPanel: panel }) => ({ default: panel })),
);

/** One persistent series identity and a separate chart-emphasis control. */
function ChartFocusChip({
  label,
  slot,
  focused,
  status,
  onFocus,
}: {
  readonly label: string;
  readonly slot: number;
  readonly focused: boolean;
  readonly status: 'pending' | 'ready' | 'error';
  readonly onFocus: () => void;
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

export function TrendsPlace() {
  const series = useApp((state) => state.series);
  const trends = useApp((state) => state.trends);
  const focusedSeries = useApp((state) => state.focusedSeries);
  const setFocus = useApp((state) => state.setFocus);
  const trendView = useApp((state) => state.trendView);
  const setTrendView = useApp((state) => state.setTrendView);

  return (
    <>
      <MethodSummary place="trends" />
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
          {series.map((item) => (
            <ChartFocusChip
              key={item.id}
              label={item.label}
              slot={item.styleSlot}
              focused={item.id === focusedSeries}
              status={trends.get(item.id)?.status ?? 'pending'}
              onFocus={() => setFocus(item.id)}
            />
          ))}
          <span aria-hidden="true" style={{ borderLeft: '1px solid var(--rule)', alignSelf: 'stretch' }} />
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
