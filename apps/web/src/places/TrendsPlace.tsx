import { lazy, Suspense } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { chapterMarkView } from '../lib/trend-controls.ts';
import { usePresentation } from '../components/PresentationProvider.tsx';

const TrendPanel = lazy(() =>
  import('../components/TrendPanel.tsx').then(({ TrendPanel: panel }) => ({ default: panel })),
);

export function TrendsPlace() {
  const series = useApp((state) => state.series);
  const project = useApp((state) => state.projectSession?.project ?? null);
  const snapshot = useApp((state) => state.snapshot);
  const trendView = useApp((state) => state.trendView);
  const focusedDoc = useApp((state) => state.focusedDoc);
  const structure = useApp((state) => state.structure);
  const sectionMarks = useApp((state) => state.sectionMarks);
  const setTrendView = useApp((state) => state.setTrendView);
  const setSectionMarks = useApp((state) => state.setSectionMarks);
  const setPlace = useApp((state) => state.setPlace);
  const presentation = usePresentation();

  const markView = chapterMarkView({
    sectionMarks,
    focusedDoc,
    structure,
    titleByDoc: new Map(
      (project?.data.docs ?? []).map((doc) => [doc.doc, doc.meta.title ?? doc.doc]),
    ),
    readyDocs: snapshot?.readyDocs ?? [],
  });

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
          <span aria-hidden="true" style={{ color: 'var(--rule-strong)' }}>·</span>
          <label
            style={{
              alignItems: 'center',
              color: markView.enabled ? 'var(--fg)' : 'var(--fg-muted)',
              cursor: markView.enabled ? 'pointer' : 'default',
              display: 'inline-flex',
              gap: 'var(--space-1)',
              minHeight: 44,
            }}
          >
            <input
              type="checkbox"
              checked={markView.checked}
              disabled={!markView.enabled}
              onChange={(event) => setSectionMarks(event.target.checked)}
              aria-label="Mark top-level chapters on the chart"
              aria-describedby={markView.reason ? 'chapter-mark-status' : undefined}
            />
            mark chapters
          </label>
          {markView.bookLabel && (
            <button
              type="button"
              onClick={() => setPlace('corpus')}
              style={{
                background: 'none',
                border: 0,
                borderBottom: '1px solid var(--rule-strong)',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                font: 'inherit',
                minHeight: 44,
                padding: 'var(--space-1) 0',
              }}
              aria-label={`Change chapter-mark book, currently ${markView.bookLabel}`}
            >
              {markView.bookLabel} ▸
            </button>
          )}
          {markView.reason && (
            <span id="chapter-mark-status" role="note" style={{ color: 'var(--fg-muted)' }}>
              {markView.reason}
            </span>
          )}
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
