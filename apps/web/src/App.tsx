import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from './lib/store-instance.ts';
import { ScopeBar } from './components/ScopeBar.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { LensOrgan } from './components/LensOrgan.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';
import { occurrenceNavigationText } from './lib/store.ts';

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
  const readerPage = useApp((s) => s.readerPage);
  const readerNavigation = useApp((s) => s.readerNavigation);
  const occurrenceNavigation = useApp((s) => s.occurrenceNavigation);
  const series = useApp((s) => s.series);
  const closeReader = useApp((s) => s.closeReader);
  const navigateReader = useApp((s) => s.navigateReader);
  const stepOccurrence = useApp((s) => s.stepOccurrence);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const readerOpen = readerPlace !== null;
  const [readerKeyboardStatus, setReaderKeyboardStatus] = useState('');
  const readerScrollRef = useRef<HTMLDivElement | null>(null);
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation, series);

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
    setReaderKeyboardStatus('');
  }, [readerPlace]);

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
          if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]')) {
            return;
          }
          const move = (direction: 1 | -1) => {
            const cursor = direction === 1
              ? readerNavigation?.next
              : readerNavigation?.previous;
            if (!cursor) {
              setReaderKeyboardStatus(direction === 1 ? 'end of book' : 'start of book');
              return;
            }
            setReaderKeyboardStatus('');
            navigateReader(cursor);
          };
          switch (event.key) {
            case 'Escape':
              event.preventDefault();
              closeReader();
              return;
            case 'h':
            case 'ArrowLeft':
            case 'PageUp':
              event.preventDefault();
              move(-1);
              return;
            case 'l':
            case 'ArrowRight':
            case 'PageDown':
              event.preventDefault();
              move(1);
              return;
            case 'w':
              event.preventDefault();
              setReaderKeyboardStatus('');
              stepOccurrence(1);
              return;
            case 'W':
              event.preventDefault();
              setReaderKeyboardStatus('');
              stepOccurrence(-1);
              return;
            case 'j':
              event.preventDefault();
              if (readerScrollRef.current) {
                const prose = readerScrollRef.current.querySelector<HTMLElement>('[data-reader-page]');
                const lineHeight = prose ? Number.parseFloat(getComputedStyle(prose).lineHeight) : 0;
                readerScrollRef.current.scrollBy({
                  top: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24,
                });
              }
              return;
            case 'k':
              event.preventDefault();
              if (readerScrollRef.current) {
                const prose = readerScrollRef.current.querySelector<HTMLElement>('[data-reader-page]');
                const lineHeight = prose ? Number.parseFloat(getComputedStyle(prose).lineHeight) : 0;
                readerScrollRef.current.scrollBy({
                  top: Number.isFinite(lineHeight) && lineHeight > 0 ? -lineHeight : -24,
                });
              }
              return;
            case 'Home':
              event.preventDefault();
              setReaderKeyboardStatus('');
              navigateReader({ kind: 'from', token: 0 });
              return;
            case 'End': {
              event.preventDefault();
              const page = readerPage?.state.status === 'ready' ? readerPage.state.page : null;
              if (page && page.docTokenCount > 0) {
                setReaderKeyboardStatus('');
                navigateReader({ kind: 'before', token: page.docTokenCount });
              }
              return;
            }
            default:
              return;
          }
        }}
      >
        <span
          className="visually-hidden"
          role="status"
          aria-label="Reader keyboard status"
          aria-live="polite"
        >
          {[readerKeyboardStatus, occurrenceStatus].filter(Boolean).join(' · ')}
        </span>
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
              <div ref={readerScrollRef} className="reader-prose-scroll" aria-hidden="true" />
            </>
          )}
        >
          <ReaderDrawer proseScrollRef={readerScrollRef} />
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
