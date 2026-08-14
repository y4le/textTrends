import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useApp } from './lib/store-instance.ts';
import { StatusBar } from './components/StatusBar.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { WorkbenchTabs } from './components/WorkbenchTabs.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';
import { occurrenceNavigationText, type ReaderVisibleRangeV1 } from './lib/store.ts';
import {
  advanceShortcutSequence,
  rootShortcutAllowed,
  shortcutAria,
  shortcutMatches,
  type ShortcutId,
  type ShortcutHelpContext,
  type ShortcutSequenceState,
} from './lib/shortcuts.ts';
import { KeyboardShortcuts } from './components/KeyboardShortcuts.tsx';
import { termFocusControlId } from './lib/query-surface.ts';
import { bookTitleControlId } from './lib/corpus-view.ts';
import { WorkbenchDock } from './components/WorkbenchDock.tsx';

const ReaderDrawer = lazy(() =>
  import('./components/ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
);
const InputsPlace = lazy(() =>
  import('./places/InputsPlace.tsx').then(({ InputsPlace: placeBody }) => ({ default: placeBody })),
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
const MethodSurface = lazy(() =>
  import('./components/MethodSurface.tsx').then(({ MethodSurface: surface }) => ({ default: surface })),
);

interface ReaderEdgePointer {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly target: EventTarget | null;
  readonly geometry: string;
}

type OpenUtilityPane =
  | { readonly kind: 'method'; readonly place: Place }
  | { readonly kind: 'shortcuts'; readonly context: ShortcutHelpContext };

function isInteractiveReaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(
      'button, a, input, select, textarea, [role="button"], [data-reader-mark]',
    ) !== null;
}

function settledReaderGeometry(
  region: HTMLElement,
  visible: ReaderVisibleRangeV1 | null,
): string | null {
  const pane = region.querySelector<HTMLElement>('.reader-prose-pane');
  if (
    pane === null
    || pane.hasAttribute('data-reader-fitting')
    || visible === null
    || !visible.geometry.startsWith(`${pane.clientWidth}x${pane.clientHeight}:`)
  ) return null;
  return visible.geometry;
}

function PlaceSurface({
  place,
  children,
}: {
  readonly place: Place;
  readonly children: ReactNode;
}) {
  const focusId = `place-${place}-heading`;
  return (
    <section
      id={focusId}
      className="place-surface"
      aria-label={PLACE_HEADING[place]}
      tabIndex={-1}
    >
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
    case 'inputs': return <InputsPlace />;
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

function NoInputsPlace({ onOpenInputs }: { readonly onOpenInputs: () => void }) {
  return (
    <section
      aria-labelledby="no-inputs-heading"
      style={{
        maxWidth: '44rem',
        margin: 'var(--space-4) auto',
        padding: 'var(--space-4)',
        border: '1px solid var(--rule)',
      }}
    >
      <h2 id="no-inputs-heading" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
        No active inputs
      </h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        Nothing is being analyzed. Add a local text, choose a standard ebook, or load a demo from Inputs.
      </p>
      <button type="button" className="coarse-target" onClick={onOpenInputs}>
        Open Inputs
      </button>
    </section>
  );
}

export function App() {
  const inputError = useApp((s) => s.inputError);
  const retryAnalysis = useApp((s) => s.retryAnalysis);
  const loadError = useApp((s) => s.loadError);
  const notebookError = useApp((s) => s.notebookError);
  const clearNotebookError = useApp((s) => s.clearNotebookError);
  const commandError = useApp((s) => s.commandError);
  const clearCommandError = useApp((s) => s.clearCommandError);
  const appNotice = useApp((s) => s.appNotice);
  const clearAppNotice = useApp((s) => s.clearAppNotice);
  const trendSettingsNotice = useApp((s) => s.trendSettingsNotice);
  const readerPlace = useApp((s) => s.readerPlace);
  const readerPage = useApp((s) => s.readerPage);
  const readerNavigation = useApp((s) => s.readerNavigation);
  const readerVisibleRange = useApp((s) => s.readerVisibleRange);
  const occurrenceNavigation = useApp((s) => s.occurrenceNavigation);
  const series = useApp((s) => s.series);
  const closeReader = useApp((s) => s.closeReader);
  const navigateReader = useApp((s) => s.navigateReader);
  const stepOccurrence = useApp((s) => s.stepOccurrence);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const pendingInputCount = useApp((s) => s.projectSession?.imports.length ?? 0);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const setPlace = useApp((s) => s.setPlace);
  const routeStatus = useApp((s) => s.routeStatus);
  const hasNoInputs = project !== null
    && project.data.order.length === 0
    && pendingInputCount === 0;
  const readerOpen = readerPlace !== null;
  const [readerKeyboardStatus, setReaderKeyboardStatus] = useState('');
  const [utilityPane, setUtilityPane] = useState<OpenUtilityPane | null>(null);
  const utilityPaneReturnFocus = useRef<HTMLElement | null>(null);
  const readerEdgePointer = useRef<ReaderEdgePointer | null>(null);
  const shortcutSequence = useRef<ShortcutSequenceState | null>(null);
  const shortcutSequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardNavigationStatus, setKeyboardNavigationStatus] = useState('');
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation, series);

  const clearShortcutSequence = () => {
    shortcutSequence.current = null;
    if (shortcutSequenceTimer.current !== null) {
      clearTimeout(shortcutSequenceTimer.current);
      shortcutSequenceTimer.current = null;
    }
  };
  const openShortcutHelp = (context: ShortcutHelpContext) => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
    utilityPaneReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setUtilityPane({ kind: 'shortcuts', context });
  };
  const openMethod = () => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
    utilityPaneReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setUtilityPane({ kind: 'method', place });
  };
  const closeUtilityPane = () => {
    const target = utilityPaneReturnFocus.current;
    setUtilityPane(null);
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };
  const focusAfterRender = (id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(id)?.focus({ preventScroll: true });
    });
  };
  const runWorkbenchShortcut = (id: ShortcutId): boolean => {
    const state = useApp.getState();
    const go = (destination: Place) => {
      state.setPlace(destination);
      focusAfterRender(`place-${destination}-heading`);
      setKeyboardNavigationStatus(`${PLACE_HEADING[destination]}`);
    };
    switch (id) {
      case 'go-inputs': go('inputs'); return true;
      case 'go-trends': go('trends'); return true;
      case 'go-concordance': go('concordance'); return true;
      case 'go-vocabulary': go('vocabulary'); return true;
      case 'go-compare': go('compare'); return true;
      case 'go-footer': {
        const footer = document.getElementById('corpus-footer-position');
        if (!footer) {
          setKeyboardNavigationStatus('reading footer unavailable');
          return true;
        }
        footer.focus({ preventScroll: true });
        setKeyboardNavigationStatus('reading footer');
        return true;
      }
      case 'go-terms': {
        const focused = state.focusedSeries
          ? document.getElementById(termFocusControlId(state.focusedSeries))
          : null;
        const target = focused
          ?? document.querySelector<HTMLElement>('[data-term-focus]:not(:disabled)')
          ?? document.getElementById('term-add');
        target?.focus({ preventScroll: true });
        setKeyboardNavigationStatus(target ? 'Terms' : 'Terms unavailable');
        return true;
      }
      case 'focus-term-previous':
      case 'focus-term-next': {
        const direction = id === 'focus-term-next' ? 1 : -1;
        const terms = state.series;
        if (terms.length === 0) {
          setKeyboardNavigationStatus('no active terms');
          return true;
        }
        const current = terms.findIndex((item) => item.id === state.focusedSeries);
        const base = current >= 0 ? current : direction === 1 ? -1 : terms.length;
        const next = Math.max(0, Math.min(terms.length - 1, base + direction));
        const term = terms[next]!;
        state.setFocus(term.id);
        focusAfterRender(termFocusControlId(term.id));
        setKeyboardNavigationStatus(
          next === current
            ? `${direction === 1 ? 'last' : 'first'} active term · ${term.label}`
            : `${term.label} · active term ${next + 1} of ${terms.length}`,
        );
        return true;
      }
      case 'focus-book-previous':
      case 'focus-book-next': {
        const direction = id === 'focus-book-next' ? 1 : -1;
        const docs = state.snapshot?.readyDocs ?? [];
        if (docs.length === 0) {
          setKeyboardNavigationStatus('no ready books');
          return true;
        }
        const current = state.focusedDoc === null ? -1 : docs.indexOf(state.focusedDoc);
        const base = current >= 0 ? current : direction === 1 ? -1 : docs.length;
        const next = Math.max(0, Math.min(docs.length - 1, base + direction));
        const doc = docs[next]!;
        const title = state.projectSession?.project.data.docs.find((item) => item.doc === doc)?.meta.title
          ?? doc;
        state.setFocusedDoc(doc);
        focusAfterRender(bookTitleControlId(doc));
        setKeyboardNavigationStatus(
          next === current
            ? `${direction === 1 ? 'last' : 'first'} ready book · ${title}`
            : `${title} · ready book ${next + 1} of ${docs.length}`,
        );
        return true;
      }
      default: return false;
    }
  };
  const handleRootShortcut = (
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
    context: ShortcutHelpContext,
    dispatchSequences = false,
  ) => {
    if (!rootShortcutAllowed(event)) {
      // Sequence dispatch is document-owned. By the time an event reaches
      // document, defaultPrevented means a focused surface consumed this key;
      // that visible local action must also abandon any earlier prefix.
      if (dispatchSequences && shortcutSequence.current !== null) {
        clearShortcutSequence();
        setKeyboardNavigationStatus('');
      }
      return;
    }
    if (shortcutMatches(event, 'show-help')) {
      event.preventDefault();
      clearShortcutSequence();
      openShortcutHelp(context);
      return;
    }
    if (!dispatchSequences || context !== 'workbench') return;
    const advanced = advanceShortcutSequence(
      shortcutSequence.current,
      event,
      context,
      performance.now(),
    );
    if (advanced.kind === 'none') {
      if (shortcutSequence.current !== null) {
        clearShortcutSequence();
        setKeyboardNavigationStatus('');
      }
      return;
    }
    event.preventDefault();
    if (advanced.kind === 'matched') {
      clearShortcutSequence();
      runWorkbenchShortcut(advanced.id);
      return;
    }
    clearShortcutSequence();
    shortcutSequence.current = advanced.state;
    setKeyboardNavigationStatus(`${advanced.state.prefix}…`);
    shortcutSequenceTimer.current = setTimeout(() => {
      if (shortcutSequence.current?.expiresAt === advanced.state.expiresAt) {
        shortcutSequence.current = null;
        shortcutSequenceTimer.current = null;
        setKeyboardNavigationStatus('');
      }
    }, Math.max(0, advanced.state.expiresAt - performance.now()));
  };

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
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      // React-owned controls and surfaces run first; by the time this bubbles
      // to document, defaultPrevented is the hand-off that keeps local meaning
      // authoritative. The document seam also reaches a fresh workbench while
      // focus still rests on <body>.
      if (utilityPane !== null) return;
      handleRootShortcut(event, readerOpen ? 'reader' : 'workbench', true);
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [readerOpen, utilityPane]);

  useEffect(() => () => {
    if (shortcutSequenceTimer.current !== null) clearTimeout(shortcutSequenceTimer.current);
  }, []);

  useEffect(() => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
  }, [readerOpen]);

  useEffect(() => {
    setReaderKeyboardStatus('');
  }, [readerPlace]);

  useEffect(() => {
    if (!readerOpen) return undefined;
    document.documentElement.classList.add('reader-open');
    return () => document.documentElement.classList.remove('reader-open');
  }, [readerOpen]);

  const moveReaderPage = (direction: 1 | -1) => {
    const cursor = direction === 1
      ? readerNavigation?.next
      : readerNavigation?.previous;
    if (!cursor) {
      setReaderKeyboardStatus(direction === 1 ? 'end of corpus' : 'start of corpus');
      return;
    }
    setReaderKeyboardStatus('');
    navigateReader(cursor);
  };
  const onReaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    readerEdgePointer.current = null;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const geometry = settledReaderGeometry(event.currentTarget, readerVisibleRange);
    if (geometry === null) return;
    readerEdgePointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      target: event.target,
      geometry,
    };
  };
  const onReaderPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const down = readerEdgePointer.current;
    readerEdgePointer.current = null;
    if (
      down === null
      || down.id !== event.pointerId
      || event.pointerType !== 'touch'
      || event.timeStamp - down.time > 500
      || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8
      || isInteractiveReaderTarget(down.target)
      || isInteractiveReaderTarget(event.target)
      || window.getSelection()?.isCollapsed === false
      || down.geometry !== settledReaderGeometry(event.currentTarget, readerVisibleRange)
    ) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = Math.max(44, Math.min(120, rect.width * 0.18));
    const x = event.clientX - rect.left;
    if (x <= edge && readerNavigation?.previous) {
      event.preventDefault();
      moveReaderPage(-1);
    } else if (x >= rect.width - edge && readerNavigation?.next) {
      event.preventDefault();
      moveReaderPage(1);
    }
  };

  const utilityPaneSurface = utilityPane?.kind === 'shortcuts'
    ? <KeyboardShortcuts context={utilityPane.context} onClose={closeUtilityPane} />
    : utilityPane?.kind === 'method'
      ? (
          <Suspense fallback={null}>
            <MethodSurface place={utilityPane.place} onClose={closeUtilityPane} />
          </Suspense>
        )
      : null;

  if (readerPlace) {
    const readerTitle = project?.data.docs.find((document) => document.doc === readerPlace.doc)?.meta.title
      ?? readerPlace.doc;
    return (
      <>
      <main
        id="reader-region"
        className="reader-region"
        data-shortcut-context="reader"
        data-reader-fit-size={readerVisibleRange?.geometry.split(':', 1)[0]}
        aria-labelledby="reader-title"
        tabIndex={-1}
        onPointerDown={onReaderPointerDown}
        onPointerUp={onReaderPointerUp}
        onPointerCancel={() => { readerEdgePointer.current = null; }}
        onKeyDown={(event) => {
          if (!rootShortcutAllowed(event)) return;
          if (shortcutMatches(event, 'reader-close')) {
            event.preventDefault();
            closeReader();
            return;
          }
          if (shortcutMatches(event, 'reader-page-previous')) {
            event.preventDefault();
            moveReaderPage(-1);
            return;
          }
          if (shortcutMatches(event, 'reader-page-next')) {
            event.preventDefault();
            moveReaderPage(1);
            return;
          }
          if (shortcutMatches(event, 'reader-occurrence-next')) {
            event.preventDefault();
            setReaderKeyboardStatus('');
            stepOccurrence(1);
            return;
          }
          if (shortcutMatches(event, 'reader-occurrence-previous')) {
            event.preventDefault();
            setReaderKeyboardStatus('');
            stepOccurrence(-1);
            return;
          }
          if (shortcutMatches(event, 'reader-book-start')) {
            event.preventDefault();
            setReaderKeyboardStatus('');
            navigateReader({ kind: 'from', token: 0 });
            return;
          }
          if (shortcutMatches(event, 'reader-book-end')) {
            event.preventDefault();
            const page = readerPage?.state.status === 'ready' ? readerPage.state.page : null;
            if (page && page.docTokenCount > 0) {
              setReaderKeyboardStatus('');
              navigateReader({ kind: 'before', token: page.docTokenCount });
            }
            return;
          }
          handleRootShortcut(event, 'reader');
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
                <div className="reader-header-actions">
                  <button
                    type="button"
                    aria-keyshortcuts={shortcutAria(['show-help'])}
                    onClick={() => openShortcutHelp('reader')}
                  >
                    shortcuts
                  </button>
                  <button type="button" onClick={closeReader}>back</button>
                </div>
              </header>
              <div className="reader-prose-pane" aria-hidden="true" />
            </>
          )}
        >
          <ReaderDrawer
            onOpenShortcuts={() => openShortcutHelp('reader')}
          />
        </Suspense>
      </main>
      {utilityPaneSurface}
      </>
    );
  }

  return (
    <>
    <main
      className="app-shell"
      data-place={place}
      data-shortcut-context="workbench"
      onKeyDown={(event) => handleRootShortcut(event, 'workbench')}
    >
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {trendSettingsNotice}
      </p>
      <p
        className="visually-hidden"
        role="status"
        aria-label="Keyboard navigation status"
        aria-live="polite"
        aria-atomic="true"
      >
        {keyboardNavigationStatus}
      </p>
      <header className="app-header">
        <div className="app-identity">
          <h1 className="app-brand">
            <a
              className="app-brand-link"
              href="https://yalethom.as/"
              aria-label="yalethom.as/textTrends, publisher home"
            >
              <span>
                yalethom<span className="app-brand-dot">.</span>as/
              </span>
              <span>textTrends</span>
            </a>
          </h1>
          <button
            type="button"
            className="shortcut-help-open"
            aria-keyshortcuts={shortcutAria(['show-help'])}
            onClick={() => openShortcutHelp('workbench')}
          >
            shortcuts
          </button>
        </div>
        <StatusBar onOpenMethod={openMethod} />
        <WorkbenchTabs />
      </header>
      <ResumeStatus />
      {appNotice && (
        <p role="status" style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
          {appNotice}{' '}
          <button
            type="button"
            onClick={clearAppNotice}
            style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--rule-strong)', cursor: 'pointer', padding: '0 0.5ch' }}
          >
            dismiss
          </button>
        </p>
      )}
      {commandError && (
        <p role="alert" style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
          {commandError}{' '}
          <button
            type="button"
            onClick={clearCommandError}
            style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--rule-strong)', cursor: 'pointer', padding: '0 0.5ch' }}
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
      <div className="workbench">
        <div className="place-region">
          {routeStatus === 'pending'
            ? <p className="region-placeholder" role="status">preparing your workspace…</p>
            : (
                <PlaceSurface place={place}>
                  {hasNoInputs && place !== 'inputs'
                    ? (
                        <NoInputsPlace onOpenInputs={() => {
                          setPlace('inputs');
                          focusAfterRender('place-inputs-heading');
                        }} />
                      )
                    : <ActivePlace place={place} />}
                </PlaceSurface>
              )}
        </div>
      </div>
      <WorkbenchDock globalShortcuts={place === 'trends'} />
    </main>
    {utilityPaneSurface}
    </>
  );
}
