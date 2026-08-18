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
import { isSettingsPlace } from './lib/settings-place.ts';
import { occurrenceNavigationText, type ReaderVisibleRangeV1 } from './lib/store.ts';
import {
  advanceShortcutSequence,
  interactionShortcutAllowed,
  rootShortcutAllowed,
  shortcutAria,
  shortcutMatches,
  type ShortcutId,
  type ShortcutHelpContext,
  type ShortcutSequenceState,
} from './lib/shortcuts.ts';
import { KeyboardShortcuts } from './components/KeyboardShortcuts.tsx';
import { termFocusControlId } from './lib/query-surface.ts';
import { WorkbenchDock } from './components/WorkbenchDock.tsx';
import { FindBar } from './components/FindBar.tsx';
import { FIND_INPUT_ID } from './lib/interaction.ts';

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
const MatchesPlace = lazy(() =>
  import('./places/MatchesPlace.tsx').then(({ MatchesPlace: placeBody }) => ({ default: placeBody })),
);
const SettingsSurface = lazy(() =>
  import('./components/SettingsSurface.tsx').then(({ SettingsSurface: surface }) => ({ default: surface })),
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
  | { readonly kind: 'settings' }
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
    case 'matches': return <MatchesPlace />;
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
  const interaction = useApp((s) => s.interaction);
  const enterFind = useApp((s) => s.enterFind);
  const stepFind = useApp((s) => s.stepFind);
  const exitInteraction = useApp((s) => s.exitInteraction);
  const closeReader = useApp((s) => s.closeReader);
  const navigateReader = useApp((s) => s.navigateReader);
  const stepOccurrence = useApp((s) => s.stepOccurrence);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const pendingInputCount = useApp((s) => s.projectSession?.imports.length ?? 0);
  const bootstrap = useApp((s) => s.bootstrap);
  const place = useApp((s) => s.place);
  const setPlace = useApp((s) => s.setPlace);
  const replacePlace = useApp((s) => s.replacePlace);
  const routeStatus = useApp((s) => s.routeStatus);
  const activeTextCount = useApp(
    (s) => s.projectSession?.project.data.order.length ?? 0,
  );
  const hasNoInputs = project !== null
    && activeTextCount === 0
    && pendingInputCount === 0;
  const readerOpen = readerPlace !== null;
  const [readerKeyboardStatus, setReaderKeyboardStatus] = useState('');
  const [utilityPane, setUtilityPane] = useState<OpenUtilityPane | null>(null);
  const utilityPaneReturnFocus = useRef<HTMLElement | null>(null);
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const restoreFindFocus = useRef(false);
  const previousInteractionKind = useRef(interaction.kind);
  const readerEdgePointer = useRef<ReaderEdgePointer | null>(null);
  const shortcutSequence = useRef<ShortcutSequenceState | null>(null);
  const shortcutSequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardNavigationStatus, setKeyboardNavigationStatus] = useState('');
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation);

  useEffect(() => {
    if (
      routeStatus !== 'resolved'
      || project === null
      || place !== 'compare'
      || activeTextCount > 1
    ) return;
    const fallbackPlace = activeTextCount === 0 ? 'inputs' : 'trends';
    setKeyboardNavigationStatus(
      `Compare requires at least two active texts. Opening ${PLACE_HEADING[fallbackPlace]}.`,
    );
    replacePlace(fallbackPlace);
  }, [activeTextCount, place, project, replacePlace, routeStatus]);

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
    utilityPaneReturnFocus.current = interaction.kind === 'find'
      ? findReturnFocus.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (interaction.kind === 'find') exitInteraction();
    setUtilityPane({ kind: 'shortcuts', context });
  };
  const openSettings = () => {
    if (!isSettingsPlace(place)) return;
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
    utilityPaneReturnFocus.current = interaction.kind === 'find'
      ? findReturnFocus.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (interaction.kind === 'find') exitInteraction();
    setUtilityPane({ kind: 'settings' });
  };
  const focusFindInput = (selectAll = false) => {
    requestAnimationFrame(() => {
      const input = document.getElementById(FIND_INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      input.focus({ preventScroll: true });
      if (selectAll) input.select();
    });
  };
  const openFind = (fromUtilityPane = false, selectAll = false) => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
    if (interaction.kind !== 'find') {
      restoreFindFocus.current = false;
      const active = fromUtilityPane
        ? utilityPaneReturnFocus.current
        : document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      findReturnFocus.current = active;
    }
    if (fromUtilityPane) setUtilityPane(null);
    enterFind();
    focusFindInput(selectAll);
  };
  const closeFind = () => {
    restoreFindFocus.current = true;
    exitInteraction();
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
      case 'go-matches': go('matches'); return true;
      case 'go-vocabulary': go('vocabulary'); return true;
      case 'go-compare': {
        const textCount = state.projectSession?.project.data.order.length ?? 0;
        if (textCount < 2) {
          setKeyboardNavigationStatus('Compare requires at least two active texts');
          return true;
        }
        go('compare');
        return true;
      }
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
        const firstTerm = state.notebook.groups[0];
        const target = (firstTerm
          ? document.getElementById(termFocusControlId(firstTerm.id))
          : null)
          ?? document.querySelector<HTMLElement>('[data-term-focus]:not(:disabled)')
          ?? document.getElementById('term-add');
        target?.focus({ preventScroll: true });
        setKeyboardNavigationStatus(target ? 'Terms' : 'Terms unavailable');
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
  const handleInteractionShortcut = (
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
  ): boolean => {
    if (utilityPane !== null || !interactionShortcutAllowed(event)) return false;
    if (shortcutMatches(event, 'find-open')) {
      event.preventDefault();
      openFind(false, event.ctrlKey || event.metaKey);
      return true;
    }
    const active = useApp.getState().interaction;
    if (active.kind !== 'find') return false;
    if (shortcutMatches(event, 'find-close')) {
      event.preventDefault();
      closeFind();
      return true;
    }
    if (active.find !== null && shortcutMatches(event, 'find-next')) {
      event.preventDefault();
      stepFind(1);
      return true;
    }
    if (active.find !== null && shortcutMatches(event, 'find-previous')) {
      event.preventDefault();
      stepFind(-1);
      return true;
    }
    return false;
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
      if (handleInteractionShortcut(event)) return;
      handleRootShortcut(event, readerOpen ? 'reader' : 'workbench', true);
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [interaction.kind, readerOpen, utilityPane]);

  useEffect(() => {
    const previous = previousInteractionKind.current;
    previousInteractionKind.current = interaction.kind;
    if (previous !== 'find' || interaction.kind === 'find') return;
    const shouldRestore = restoreFindFocus.current;
    restoreFindFocus.current = false;
    const target = findReturnFocus.current;
    findReturnFocus.current = null;
    const orphaned = document.activeElement === null || document.activeElement === document.body;
    if (!shouldRestore && !orphaned) return;
    requestAnimationFrame(() => {
      const connectedTarget = target?.isConnected
        ? target
        : target?.id
          ? document.getElementById(target.id)
          : null;
      if (connectedTarget) {
        connectedTarget.focus({ preventScroll: true });
        return;
      }
      document.getElementById(readerOpen ? 'reader-region' : `place-${place}-heading`)
        ?.focus({ preventScroll: true });
    });
  }, [interaction.kind, place, readerOpen]);

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
    ? (
        <KeyboardShortcuts
          context={utilityPane.context}
          place={place}
          onFind={() => openFind(true)}
          onClose={closeUtilityPane}
        />
      )
    : utilityPane?.kind === 'settings'
      ? (
          <Suspense fallback={null}>
            <SettingsSurface onClose={closeUtilityPane} />
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
          if (handleInteractionShortcut(event)) return;
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
      {interaction.kind === 'find' && <FindBar onClose={closeFind} />}
      </>
    );
  }

  return (
    <>
    <main
      className="app-shell"
      data-place={place}
      data-shortcut-context="workbench"
      onKeyDown={(event) => {
        if (handleInteractionShortcut(event)) return;
        handleRootShortcut(event, 'workbench');
      }}
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
        aria-label="Navigation status"
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
        <StatusBar onOpenSettings={openSettings} />
        <WorkbenchTabs />
      </header>
      <ResumeStatus />
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', margin: appNotice ? undefined : 0 }}
      >
        {appNotice && (
          <>
            {appNotice}{' '}
            <button
              type="button"
              onClick={clearAppNotice}
              style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--rule-strong)', cursor: 'pointer', padding: '0 0.5ch' }}
            >
              dismiss
            </button>
          </>
        )}
      </p>
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
      <WorkbenchDock globalShortcuts={place === 'trends'} onCloseFind={closeFind} />
    </main>
    {utilityPaneSurface}
    </>
  );
}
