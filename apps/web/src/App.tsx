import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useApp } from './lib/store-instance.ts';
import { ScopeBar } from './components/ScopeBar.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { LensOrgan } from './components/LensOrgan.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';

const ReaderDrawer = lazy(() =>
  import('./components/ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
);
const CatalogPlace = lazy(() =>
  import('./places/CatalogPlace.tsx').then(({ CatalogPlace: placeBody }) => ({ default: placeBody })),
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
const QuerySurface = lazy(() =>
  import('./components/QuerySurface.tsx').then(({ QuerySurface: surface }) => ({ default: surface })),
);
const MethodSurface = lazy(() =>
  import('./components/MethodSurface.tsx').then(({ MethodSurface: surface }) => ({ default: surface })),
);
const WorkbenchFooter = lazy(() =>
  import('./components/WorkbenchFooter.tsx').then(({ WorkbenchFooter: footer }) => ({ default: footer })),
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
    case 'catalog': return <CatalogPlace />;
    case 'trends': return <TrendsPlace />;
    case 'concordance': return <ConcordancePlace />;
    case 'vocabulary': return <VocabularyPlace />;
    case 'compare': return <ComparePlace />;
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
  const closeReader = useApp((s) => s.closeReader);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const readerOpen = readerPlace !== null;

  useEffect(() => {
    if (!readerOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        document.getElementById('reader-region')?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [readerOpen]);

  useEffect(() => {
    if (!readerOpen) return undefined;
    document.documentElement.classList.add('reader-open');
    return () => document.documentElement.classList.remove('reader-open');
  }, [readerOpen]);

  if (readerPlace) {
    const readerTitle = project?.data.docs.find((document) => document.doc === readerPlace.doc)?.meta.title
      ?? readerPlace.doc;
    return (
      <main
        id="reader-region"
        className="reader-region"
        aria-labelledby="reader-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeReader();
        }}
      >
        <Suspense
          fallback={(
            <>
              <header className="reader-header">
                <div>
                  <h2 id="reader-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
                    <span className="visually-hidden">Reader: </span>{readerTitle}
                  </h2>
                  <p className="reader-position" role="status">loading reader…</p>
                </div>
                <button type="button" onClick={closeReader}>back</button>
              </header>
              <div className="reader-prose-scroll" aria-hidden="true" />
            </>
          )}
        >
          <ReaderDrawer />
        </Suspense>
      </main>
    );
  }

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
      <header className="app-header">
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
        <ScopeBar />
        <LensOrgan />
      </header>
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
      <div className="workbench">
        <Suspense
          fallback={(
            <aside className="query-region" aria-label="Queries">
              <p className="region-placeholder">loading Queries…</p>
            </aside>
          )}
        >
          <QuerySurface />
        </Suspense>
        <div className="place-region">
          <PlaceSurface place={place}>
            <ActivePlace place={place} />
          </PlaceSurface>
        </div>
      </div>
      <Suspense fallback={null}>
        <MethodSurface place={place} />
      </Suspense>
      <Suspense fallback={null}>
        <WorkbenchFooter />
      </Suspense>
    </main>
  );
}
