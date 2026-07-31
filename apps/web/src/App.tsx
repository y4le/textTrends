import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useApp } from './lib/store-instance.ts';
import { ScopeBar } from './components/ScopeBar.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { LensOrgan } from './components/LensOrgan.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';

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

function PlaceSurface({
  place,
  children,
}: {
  readonly place: Place;
  readonly children: ReactNode;
}) {
  const headingId = `${place}-place-heading`;
  return (
    <section className="place-surface" aria-labelledby={headingId}>
      <h2
        id={headingId}
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
  const quickAdd = useApp((s) => s.quickAdd);
  const inputError = useApp((s) => s.inputError);
  const retryAnalysis = useApp((s) => s.retryAnalysis);
  const loadError = useApp((s) => s.loadError);
  const pinError = useApp((s) => s.pinError);
  const clearPinError = useApp((s) => s.clearPinError);
  const notebookError = useApp((s) => s.notebookError);
  const clearNotebookError = useApp((s) => s.clearNotebookError);
  const readerPlace = useApp((s) => s.readerPlace);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const [draft, setDraft] = useState('');

  return (
    <main className="app-shell">
      <header className="app-header" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', borderBottom: '1px solid var(--rule-strong)', paddingBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>textTrends</h1>
        <form
          className="quick-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            // Append-only quick-add: the field clears on submission — the
            // NOTEBOOK below, not this input, is the authoritative group list.
            quickAdd(draft);
            setDraft('');
          }}
        >
          <input
            className="exact-input quick-add-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Add terms to the notebook, comma-separated"
            placeholder="add terms: holmes, moriarty"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              background: 'transparent',
              color: 'var(--fg)',
              border: 'none',
              borderBottom: '1px solid var(--rule-strong)',
              padding: '2px 0',
            }}
          />
        </form>
      </header>
      <div className="workbench-organs">
        <ScopeBar />
        <LensOrgan />
      </div>
      <ResumeStatus />
      {pinError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {pinError}{' '}
          <button
            type="button"
            onClick={clearPinError}
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
      <PlaceSurface place={place}>
        <ActivePlace place={place} />
      </PlaceSurface>
      {readerPlace && (
        <Suspense fallback={null}>
          <ReaderDrawer />
        </Suspense>
      )}
    </main>
  );
}
