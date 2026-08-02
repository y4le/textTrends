import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useApp } from './lib/store-instance.ts';
import { ScopeBar } from './components/ScopeBar.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { LensOrgan } from './components/LensOrgan.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';
import {
  readerComposition,
  readerMode,
} from './lib/reader-presentation.ts';
import { usePresentation } from './components/PresentationProvider.tsx';

const ReaderDrawer = lazy(() =>
  import('./components/ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
);
const CorpusPlace = lazy(() =>
  import('./places/CorpusPlace.tsx').then(({ CorpusPlace: placeBody }) => ({ default: placeBody })),
);
const VocabularyPlace = lazy(() =>
  import('./places/VocabularyPlace.tsx').then(({ VocabularyPlace: placeBody }) => ({ default: placeBody })),
);
const ComparePlace = lazy(() =>
  import('./places/ComparePlace.tsx').then(({ ComparePlace: placeBody }) => ({ default: placeBody })),
);
const TrendsPlace = lazy(() =>
  import('./places/TrendsPlace.tsx').then(({ TrendsPlace: placeBody }) => ({ default: placeBody })),
);
const ConcordancePlace = lazy(() =>
  import('./places/ConcordancePlace.tsx').then(({ ConcordancePlace: placeBody }) => ({ default: placeBody })),
);
const FindingsPlace = lazy(() =>
  import('./places/FindingsPlace.tsx').then(({ FindingsPlace: placeBody }) => ({ default: placeBody })),
);
const QuerySurface = lazy(() =>
  import('./components/QuerySurface.tsx').then(({ QuerySurface: surface }) => ({ default: surface })),
);
const EvidenceSurface = lazy(() =>
  import('./components/EvidenceSurface.tsx').then(({ EvidenceSurface: surface }) => ({ default: surface })),
);
const MethodSurface = lazy(() =>
  import('./components/MethodSurface.tsx').then(({ MethodSurface: surface }) => ({ default: surface })),
);

function PlaceSurface({
  place,
  children,
}: {
  readonly place: Place;
  readonly children: ReactNode;
}) {
  const headingId = `place-${place}-heading`;
  return (
    <section className="place-surface" aria-labelledby={headingId}>
      <h2
        id={headingId}
        tabIndex={-1}
        style={{ fontSize: 'var(--text-md)', margin: 'var(--space-3) 0 var(--space-1)' }}
      >
        {PLACE_HEADING[place]}
      </h2>
      <Suspense
        fallback={(
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
            loading {PLACE_HEADING[place]}…
          </p>
        )}
      >
        {children}
      </Suspense>
    </section>
  );
}

function ActivePlace({ place }: { readonly place: Place }) {
  switch (place) {
    case 'corpus': return <CorpusPlace />;
    case 'trends': return <TrendsPlace />;
    case 'concordance': return <ConcordancePlace />;
    case 'vocabulary': return <VocabularyPlace />;
    case 'compare': return <ComparePlace />;
    case 'findings': return <FindingsPlace />;
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

export function App() {
  const inputError = useApp((s) => s.inputError);
  const retryAnalysis = useApp((s) => s.retryAnalysis);
  const loadError = useApp((s) => s.loadError);
  const notebookError = useApp((s) => s.notebookError);
  const clearNotebookError = useApp((s) => s.clearNotebookError);
  const trendSettingsNotice = useApp((s) => s.trendSettingsNotice);
  const readerPlace = useApp((s) => s.readerPlace);
  const requestedReaderMode = useApp((s) =>
    s.layers.findLast((layer) => layer.kind === 'reader')?.ui?.reader);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const presentation = usePresentation();
  const reader = readerComposition(
    presentation.width,
    readerPlace !== null,
    readerMode(requestedReaderMode),
  );
  const showWorkbenchChrome = reader.slot !== 'viewport';

  useEffect(() => {
    if (!reader.open) return undefined;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        document.getElementById('reader-region')?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [presentation.width, reader.mode, reader.open]);

  return (
    <main className="app-shell">
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {trendSettingsNotice}
      </p>
      {showWorkbenchChrome && (
        <>
          <header className="app-header" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', borderBottom: '1px solid var(--rule-strong)', paddingBottom: 'var(--space-2)' }}>
            <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
          </header>
          {(reader.showScope || reader.showLens) && (
            <div className="workbench-organs">
              {reader.showScope && <ScopeBar />}
              {reader.showLens && <LensOrgan />}
            </div>
          )}
          <ResumeStatus />
          {notebookError && (
            <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
              {notebookError}{' '}
              <button
                type="button"
                onClick={clearNotebookError}
                style={{
                  font: 'inherit',
                  color: 'inherit',
                  background: 'none',
                  border: '1px solid var(--rule-strong)',
                  cursor: 'pointer',
                  padding: '0 0.5ch',
                }}
              >
                dismiss
              </button>
            </p>
          )}
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
        </>
      )}
      <div
        className="workbench"
        data-reader={reader.open ? reader.mode : undefined}
      >
        {reader.showQuery && (
          <Suspense
            fallback={(
              <aside className="query-region" aria-label="Queries">
                <p className="region-placeholder">loading Queries…</p>
              </aside>
            )}
          >
            <QuerySurface />
          </Suspense>
        )}
        {reader.showPlace && (
          <div className="place-region">
            <PlaceSurface place={place}>
              <ActivePlace place={place} />
            </PlaceSurface>
          </div>
        )}
        {reader.showEvidence && (
          <Suspense
            fallback={(
              <aside className="evidence-region" aria-label="Evidence">
                <p className="region-placeholder">loading Evidence…</p>
              </aside>
            )}
          >
            <EvidenceSurface />
          </Suspense>
        )}
        {readerPlace && (
          <Suspense fallback={null}>
            <ReaderDrawer composition={reader} />
          </Suspense>
        )}
      </div>
      {reader.showMethod && (
        <Suspense fallback={null}>
          <MethodSurface place={place} />
        </Suspense>
      )}
    </main>
  );
}
