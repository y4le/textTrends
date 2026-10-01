import { sameReaderPlace, type ReaderPlace } from './lib/reader-intent.ts';
import { retryableLazy } from './components/retryable-lazy.tsx';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useWorkbenchShortcuts } from './components/app/useWorkbenchShortcuts.ts';
import { useUtilityPanes } from './components/app/useUtilityPanes.ts';
import { ActivePlace, PlaceLoading } from './places/ActivePlace.tsx';
import { shutdownAppForReload, useApp } from './lib/store-instance.ts';
import { StatusBar } from './components/StatusBar.tsx';
import { HeaderActions } from './components/HeaderActions.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { WorkspaceSaveStatus } from './components/WorkspaceSaveStatus.tsx';
import { ResumeStatus } from './components/ResumeStatus.tsx';
import { WorkbenchTabs } from './components/WorkbenchTabs.tsx';
import { PLACE_HEADING, type Place } from './lib/places.ts';
import { globalSettingsEntry } from './lib/settings-entry.ts';
import { SettingsEntryProvider } from './components/SettingsEntryContext.tsx';
import { occurrenceNavigationText } from './lib/occurrence-view.ts';
import {
  chordShortcutAllowed,
  interactionShortcutAllowed,
  rootShortcutAllowed,
  shortcutMatches,
  type ShortcutId,
  type ShortcutHelpContext,
} from './lib/shortcuts.ts';
import { HelpPane } from './components/HelpPane.tsx';
import { termFocusControlId } from './lib/query-surface.ts';
import { WorkbenchDock } from './components/WorkbenchDock.tsx';
import { FIND_INPUT_ID, findScope } from './lib/interaction.ts';
import { RSVP_WPM_STEP } from '@texttrends/rsvp';
import { RSVP_WPM_INPUT_ID } from './lib/rsvp-ui.ts';
import { usePresentation } from './components/PresentationProvider.tsx';
import { guideAnchorProps } from './lib/guide/anchors.ts';
import {
  GuideInvitation,
  useGuide,
  type GuideId,
  type GuideReadinessRemedy,
} from './components/guide/GuideProvider.tsx';

const ReaderDrawer = retryableLazy(() =>
  import('./components/ReaderDrawer.tsx').then(({ ReaderDrawer: drawer }) => ({ default: drawer })),
  'Reader',
);
const SettingsPane = retryableLazy(() =>
  import('./components/SettingsPane.tsx').then(({ SettingsPane: pane }) => ({ default: pane })),
  'Settings',
  true,
);
const DebugSurface = retryableLazy(() =>
  import('./components/DebugSurface.tsx').then(({ DebugSurface: surface }) => ({ default: surface })),
  'Debug',
  true,
);
const ReaderControlsPane = retryableLazy(() =>
  import('./components/reader/ReaderControlsPane.tsx')
    .then(({ ReaderControlsPane: pane }) => ({ default: pane })),
  'Reader controls',
  true,
);
const SpeedSettingsPane = retryableLazy(() =>
  import('./components/reader/SpeedSettingsPane.tsx')
    .then(({ SpeedSettingsPane: pane }) => ({ default: pane })),
  'Speed settings',
  true,
);

const focusAfterRender = (id: string) => {
  requestAnimationFrame(() => {
    document.getElementById(id)?.focus({ preventScroll: true });
  });
};

function PlaceSurface({
  place,
  children,
}: {
  readonly place: Place;
  readonly children: ReactNode;
}) {
  const setPlace = useApp((state) => state.setPlace);
  const focusId = `place-${place}-heading`;
  return (
    <section
      id={focusId}
      className="place-surface"
      aria-label={PLACE_HEADING[place]}
      tabIndex={-1}
    >
      <ErrorBoundary resetKey={place} {...(place === 'inputs' ? {} : { onReturn: () => { setPlace('inputs'); focusAfterRender('place-inputs-heading'); } })}>
        <Suspense
          fallback={<PlaceLoading place={place} />}
        >
          {children}
        </Suspense>
      </ErrorBoundary>
    </section>
  );
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
  const [appHeaderEl, setAppHeaderEl] = useState<HTMLElement | null>(null);
  const presentation = usePresentation();
  const guide = useGuide();
  const retryAnalysis = useApp((s) => s.retryAnalysis);
  const loadError = useApp((s) => s.loadError);
  const loadErrorFatal = useApp((s) => s.loadErrorFatal);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const notebookError = useApp((s) => s.notebookError);
  const clearNotebookError = useApp((s) => s.clearNotebookError);
  const commandError = useApp((s) => s.commandError);
  const clearCommandError = useApp((s) => s.clearCommandError);
  const appNotice = useApp((s) => s.appNotice);
  const clearAppNotice = useApp((s) => s.clearAppNotice);
  const trendSettingsNotice = useApp((s) => s.trendSettingsNotice);
  const readerPlace = useApp((s) => s.readerPlace);
  const readerPage = useApp((s) => s.readerPage);
  const readerScale = useApp((s) => s.readerScale);
  const readerNavigation = useApp((s) => s.readerNavigation);
  const readerVisibleRange = useApp((s) => s.readerVisibleRange);
  const occurrenceNavigation = useApp((s) => s.occurrenceNavigation);
  const interaction = useApp((s) => s.interaction);
  const enterFind = useApp((s) => s.enterFind);
  const stepFind = useApp((s) => s.stepFind);
  const exitInteraction = useApp((s) => s.exitInteraction);
  const setRsvpPlaying = useApp((s) => s.setRsvpPlaying);
  const enterRsvp = useApp((s) => s.enterRsvp);
  const setRsvpPacing = useApp((s) => s.setRsvpPacing);
  const closeReader = useApp((s) => s.closeReader);
  const navigateReader = useApp((s) => s.navigateReader);
  const stepReaderDocument = useApp((s) => s.stepReaderDocument);
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
  const [readerStatus, setReaderStatus] = useState<{ place: ReaderPlace | null; message: string }>({ place: null, message: '' });
  const readerKeyboardStatus = sameReaderPlace(readerStatus.place, readerPlace) ? readerStatus.message : '';
  const setReaderKeyboardStatus = (message: string) => setReaderStatus({ place: useApp.getState().readerPlace, message });
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const restoreFindFocus = useRef(false);
  const previousFindScope = useRef(findScope(interaction) !== null);
  const occurrenceStatus = occurrenceNavigationText(occurrenceNavigation);

  useLayoutEffect(() => {
    if (appHeaderEl === null) return undefined;
    const root = document.documentElement.style;
    const publish = () => {
      root.setProperty(
        '--app-header-block-size',
        `${Math.ceil(appHeaderEl.getBoundingClientRect().height)}px`,
      );
    };
    const observer = new ResizeObserver(publish);
    observer.observe(appHeaderEl);
    publish();
    return () => {
      observer.disconnect();
      root.removeProperty('--app-header-block-size');
    };
  }, [appHeaderEl]);

  useEffect(() => {
    if (
      routeStatus !== 'resolved'
      || project === null
      || place !== 'compare'
      || activeTextCount > 0
    ) return;
    setKeyboardNavigationStatus(
      'Compare requires at least one active text. Opening Inputs.',
    );
    replacePlace('inputs');
  }, [activeTextCount, place, project, replacePlace, routeStatus]);

  const {
    shortcutSequence, clearShortcutSequence, dispatchSequence,
    keyboardNavigationStatus, setKeyboardNavigationStatus,
  } = useWorkbenchShortcuts(readerOpen);
  const onUtilityOpen = useCallback(() => {
    clearShortcutSequence();
    setKeyboardNavigationStatus('');
  }, [clearShortcutSequence]);
  const {
    utilityPane, utilityPaneReturnFocus, openHelp, openSettingsEntry, openSettings,
    openDebug, openReaderControls, openSpeedSettings, closeUtilityPane, dismissForFind,
  } = useUtilityPanes({ onOpen: onUtilityOpen, findReturnFocus });
  const focusFindInput = (selectAll = false) => {
    requestAnimationFrame(() => {
      const input = document.getElementById(FIND_INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      input.focus({ preventScroll: true });
      if (selectAll) input.select();
    });
  };
  const openFind = (fromUtilityPane = false, selectAll = false) => {
    if (interaction.kind === 'rsvp') return;
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
    if (fromUtilityPane) dismissForFind();
    enterFind();
    focusFindInput(selectAll);
  };
  const closeFind = () => {
    restoreFindFocus.current = true;
    exitInteraction();
  };
  const startGuideFromHelp = (id: GuideId) => {
    const originPlace = useApp.getState().place;
    const returnId = utilityPaneReturnFocus.current?.id;
    const focusCandidates = [
      ...(returnId ? [returnId] : []),
      'global-help-open',
      `place-${originPlace}-heading`,
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
    closeUtilityPane({
      restoreFocus: false,
      onSettled: (interactive) => {
        if (!interactive) return;
        void guide.startGuide(id, { place: originPlace, focusCandidates }).then((started) => {
          if (!started) document.getElementById('global-help-open')?.focus({ preventScroll: true });
        });
      },
    });
  };
  const applyGuideRemedy = (remedy: GuideReadinessRemedy) => {
    closeUtilityPane({
      restoreFocus: false,
      onSettled: (interactive) => {
        if (!interactive) return;
        const state = useApp.getState();
        if (remedy.id === 'add-text') {
          state.replacePlace('inputs');
          focusAfterRender('place-inputs-heading');
          return;
        }
        state.replacePlace('trends');
        const openTermEntry = (attempt: number) => {
          const control = document.getElementById('term-add');
          if (control instanceof HTMLButtonElement) {
            control.click();
            return;
          }
          if (attempt < 3) requestAnimationFrame(() => openTermEntry(attempt + 1));
        };
        requestAnimationFrame(() => openTermEntry(0));
      },
    });
  };
  const exitActiveRsvp = (): boolean => {
    const state = useApp.getState();
    if (state.interaction.kind !== 'rsvp') return false;
    const mode = state.interaction.rsvp;
    const token = state.scrub?.doc === mode.doc
      && state.scrub.token >= 0
      && state.scrub.token < mode.docTokenCount
      ? state.scrub.token
      : mode.startToken;
    state.exitRsvp(token);
    return true;
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
        if (textCount < 1) {
          setKeyboardNavigationStatus('Compare requires at least one active text');
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
  const stepPositionHistory = (direction: -1 | 1) => {
    const state = useApp.getState();
    const target = state.stepPositionHistory(direction);
    const way = direction === -1 ? 'previous' : 'next';
    const message = target === null
      ? `No ${way} reading position`
      : `${way === 'previous' ? 'Previous' : 'Next'} reading position · ${
          state.projectSession?.project.data.docs.find((document) => document.doc === target.doc)
            ?.meta.title ?? target.doc
        } · token ${(target.token + 1).toLocaleString()}`;
    if (readerOpen) setReaderKeyboardStatus(message);
    else setKeyboardNavigationStatus(message);
  };
  const handlePositionHistoryShortcut = (
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
  ): boolean => {
    if (
      utilityPane !== null
      || interaction.kind === 'rsvp'
      || !chordShortcutAllowed(event)
    ) return false;
    const direction = shortcutMatches(event, 'position-previous')
      ? -1
      : shortcutMatches(event, 'position-next')
        ? 1
        : null;
    if (direction === null) return false;
    event.preventDefault();
    clearShortcutSequence();
    stepPositionHistory(direction);
    return true;
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
      openHelp(context);
      return;
    }
    if (shortcutMatches(event, 'show-debug')) {
      event.preventDefault();
      clearShortcutSequence();
      openDebug();
      return;
    }
    if (!dispatchSequences || context !== 'workbench') return;
    dispatchSequence(event, context, runWorkbenchShortcut);
  };
  const handleInteractionShortcut = (
    event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent,
  ): boolean => {
    if (utilityPane !== null || !interactionShortcutAllowed(event)) return false;
    const active = useApp.getState().interaction;
    if (active.kind === 'rsvp') {
      if (
        shortcutMatches(event, 'reader-rsvp-toggle')
        || shortcutMatches(event, 'rsvp-exit')
      ) {
        event.preventDefault();
        exitActiveRsvp();
        return true;
      }
      if (shortcutMatches(event, 'rsvp-toggle-play')) {
        event.preventDefault();
        setRsvpPlaying(!active.rsvp.playing);
        return true;
      }
      if (shortcutMatches(event, 'rsvp-pace-editor')) {
        event.preventDefault();
        const input = document.getElementById(RSVP_WPM_INPUT_ID);
        if (input instanceof HTMLInputElement) {
          input.focus({ preventScroll: true });
          input.select();
        }
        return true;
      }
      if (shortcutMatches(event, 'rsvp-pace-down')) {
        event.preventDefault();
        setRsvpPacing({ wpm: active.rsvp.wpm - RSVP_WPM_STEP });
        return true;
      }
      if (shortcutMatches(event, 'rsvp-pace-up')) {
        event.preventDefault();
        setRsvpPacing({ wpm: active.rsvp.wpm + RSVP_WPM_STEP });
        return true;
      }
      if (
        shortcutMatches(event, 'find-open')
        || shortcutMatches(event, 'reader-occurrence-previous')
        || shortcutMatches(event, 'reader-occurrence-next')
        || shortcutMatches(event, 'reader-text-previous')
        || shortcutMatches(event, 'reader-text-next')
        || shortcutMatches(event, 'reader-book-start')
        || shortcutMatches(event, 'reader-book-end')
      ) {
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (shortcutMatches(event, 'find-open')) {
      event.preventDefault();
      openFind(false, event.ctrlKey || event.metaKey);
      return true;
    }
    if (readerOpen && readerScale === 'read' && shortcutMatches(event, 'reader-rsvp-toggle')) {
      event.preventDefault();
      enterRsvp(!presentation.reducedMotion);
      return true;
    }
    if (readerOpen && readerScale === 'atlas' && shortcutMatches(event, 'reader-rsvp-toggle')) {
      event.preventDefault();
      setReaderKeyboardStatus('Speed reading is available in Read.');
      return true;
    }
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
        const destination = readerScale === 'atlas'
          ? document.getElementById('reader-atlas-plane')
          : document.getElementById('reader-region');
        destination?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [interaction.kind, readerOpen, readerScale]);

  const handleReaderKeyDown = (event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    if (handleInteractionShortcut(event)) return;
    if (interaction.kind === 'rsvp') {
      handleRootShortcut(event, 'rsvp');
      return;
    }
    if (!rootShortcutAllowed(event)) return;
    if (shortcutMatches(event, 'reader-close')) {
      event.preventDefault();
      closeReader();
      return;
    }
    if (readerScale === 'read' && shortcutMatches(event, 'reader-page-previous')) {
      event.preventDefault();
      moveReaderPage(-1);
      return;
    }
    if (readerScale === 'read' && shortcutMatches(event, 'reader-page-next')) {
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
    if (shortcutMatches(event, 'reader-text-previous')) {
      event.preventDefault();
      moveReaderDocument(-1);
      return;
    }
    if (shortcutMatches(event, 'reader-text-next')) {
      event.preventDefault();
      moveReaderDocument(1);
      return;
    }
    if (readerScale === 'read' && shortcutMatches(event, 'reader-book-start')) {
      event.preventDefault();
      setReaderKeyboardStatus('');
      navigateReader({ kind: 'from', token: 0 });
      return;
    }
    if (readerScale === 'read' && shortcutMatches(event, 'reader-book-end')) {
      event.preventDefault();
      const page = readerPage?.state.status === 'ready' ? readerPage.state.page : null;
      if (page && page.docTokenCount > 0) {
        setReaderKeyboardStatus('');
        navigateReader({ kind: 'before', token: page.docTokenCount });
      }
      return;
    }
    handleRootShortcut(event, 'reader');
  };

  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      // React-owned controls and surfaces run first; by the time this bubbles
      // to document, defaultPrevented is the hand-off that keeps local meaning
      // authoritative. The document seam also reaches a fresh workbench while
      // focus still rests on <body>.
      if (utilityPane !== null) return;
      if (handlePositionHistoryShortcut(event)) return;
      if (handleInteractionShortcut(event)) return;
      if (readerOpen && event.target === document.body) {
        handleReaderKeyDown(event);
        return;
      }
      handleRootShortcut(
        event,
        readerOpen ? interaction.kind === 'rsvp' ? 'rsvp' : 'reader' : 'workbench',
        true,
      );
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [interaction.kind, presentation.reducedMotion, readerOpen, readerScale, readerNavigation, readerPage, utilityPane]);

  useEffect(() => {
    const current = findScope(interaction) !== null;
    const previous = previousFindScope.current;
    previousFindScope.current = current;
    if (!previous || current) return;
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
  const moveReaderDocument = (direction: 1 | -1) => {
    const target = stepReaderDocument(direction);
    setReaderKeyboardStatus(target === null
      ? direction === 1 ? 'last readable text' : 'first readable text'
      : '');
  };
  const utilityPaneSurface = utilityPane?.kind === 'help'
    ? (
        <HelpPane
          context={utilityPane.context}
          place={place}
          onFind={() => openFind(true)}
          onSettings={() => openSettingsEntry(
            globalSettingsEntry(utilityPane.context === 'workbench' ? place : 'reader'),
            null,
            true,
          )}
          onDebug={() => openDebug(true)}
          guideReadiness={guide.guidedTourReadiness}
          guideActive={guide.activeGuideId === 'guided-tour'}
          guideSeen={guide.guidedTourSeen}
          onStartGuide={startGuideFromHelp}
          onGuideRemedy={applyGuideRemedy}
          onClose={() => closeUtilityPane()}
        />
      )
    : utilityPane?.kind === 'settings'
      ? (
          <Suspense fallback={null}>
            <SettingsPane
              onLoadFailureReturn={() => closeUtilityPane()}
              onLoadFailureReturnLabel="Close panel"
              entry={utilityPane.entry}
              onClose={() => closeUtilityPane()}
            />
          </Suspense>
        )
      : utilityPane?.kind === 'debug'
        ? (
            <Suspense fallback={null}>
              <DebugSurface onLoadFailureReturn={() => closeUtilityPane()} onLoadFailureReturnLabel="Close panel" onClose={() => closeUtilityPane()} />
            </Suspense>
          )
      : utilityPane?.kind === 'reader-controls'
        ? (
            <Suspense fallback={null}>
              <ReaderControlsPane
              onLoadFailureReturn={() => closeUtilityPane()}
              onLoadFailureReturnLabel="Close panel"
                onClose={() => closeUtilityPane()}
                onAnnounce={setReaderKeyboardStatus}
                onOpenFind={() => openFind(true)}
                onOpenSettings={() => openSettingsEntry(
                  globalSettingsEntry('reader'),
                  null,
                  true,
                )}
                onOpenHelp={() => openHelp('reader', true)}
              />
            </Suspense>
          )
        : utilityPane?.kind === 'speed-settings' && interaction.kind === 'rsvp'
          ? (
              <Suspense fallback={null}>
                <SpeedSettingsPane
              onLoadFailureReturn={() => closeUtilityPane()}
              onLoadFailureReturnLabel="Close panel"
                  mode={interaction.rsvp}
                  restSummary={utilityPane.restSummary}
                  onSetPacing={setRsvpPacing}
                  onOpenHelp={() => openHelp('rsvp', true)}
                  onClose={() => closeUtilityPane()}
                />
              </Suspense>
            )
      : null;

  if (readerPlace) {
    const readerTitle = project?.data.docs.find((document) => document.doc === readerPlace.doc)?.meta.title
      ?? readerPlace.doc;
    const readerDockPresent = readerScale === 'atlas';
    return (
      <>
      <WorkspaceSaveStatus />
      <main
        id="reader-region"
        className="reader-region"
        data-reader-footer={readerDockPresent ? 'true' : 'false'}
        data-shortcut-context={interaction.kind === 'rsvp' ? 'rsvp' : 'reader'}
        data-reader-fit-size={readerVisibleRange?.geometry.split(':', 1)[0]}
        aria-labelledby="reader-title"
        tabIndex={-1}
        onKeyDown={handleReaderKeyDown}
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
              <h2 id="reader-title" className="visually-hidden">Reader: {readerTitle}</h2>
              <p className="reader-position visually-hidden" role="status">loading reader…</p>
              <div
                {...guideAnchorProps('reader-prose')}
                className="reader-prose-pane"
                aria-hidden="true"
              />
              <nav className="reader-control-bar" aria-label="Reader controls">
                <span className="reader-progress-rail reader-control-progress" aria-hidden="true" />
                <button
                  type="button"
                  className="reader-control-exit"
                  aria-label="Return to workbench"
                  onClick={closeReader}
                >
                  <span aria-hidden="true">←</span>{' '}<span>back</span>
                </button>
                <button type="button" className="reader-control-page" disabled aria-label="Previous page">
                  <span aria-hidden="true">‹</span>
                </button>
                <button
                  type="button"
                  className="reader-control-position"
                  aria-label={`Open Reader controls for ${readerTitle}`}
                  disabled
                >
                  <strong>{readerTitle}</strong>
                  <span>loading position…</span>
                </button>
                <button type="button" className="reader-control-page" disabled aria-label="Next page">
                  <span aria-hidden="true">›</span>
                </button>
                <button type="button" className="reader-control-speed" disabled aria-label="Speed reading unavailable">
                  <span aria-hidden="true">▶</span>
                </button>
              </nav>
            </>
          )}
        >
          <ReaderDrawer
            onLoadFailureReturn={closeReader}
            onLoadFailureReturnLabel="Return to workbench"
            onAnnounce={setReaderKeyboardStatus}
            onCloseFind={closeFind}
            onOpenFind={() => openFind()}
            onOpenControls={openReaderControls}
            onOpenSpeedSettings={openSpeedSettings}
            onOpenSettings={(returnFocus) => openSettings('reader', returnFocus)}
            onOpenHelp={() => openHelp(
              interaction.kind === 'rsvp' ? 'rsvp' : 'reader',
            )}
          />
        </Suspense>
        {readerDockPresent && (
          <WorkbenchDock
            mode="reader"
            globalShortcuts={false}
            onCloseFind={closeFind}
          />
        )}
      </main>
      {utilityPaneSurface}
      </>
    );
  }

  return (
    <>
    <WorkspaceSaveStatus />
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
      <header ref={setAppHeaderEl} className="app-header">
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
        </div>
        <StatusBar />
        <HeaderActions
          onOpenFind={() => openFind()}
          onOpenSettings={() => openSettings()}
          onOpenHelp={() => openHelp('workbench')}
          onStepPositionHistory={stepPositionHistory}
        />
        <WorkbenchTabs />
      </header>
      {guide.guidedTourInvitation.status === 'available' && !presentation.shortLandscape && (
        <GuideInvitation
          starting={guide.guidedTourInvitation.starting}
          onStart={guide.guidedTourInvitation.start}
          onDismiss={guide.guidedTourInvitation.dismiss}
        />
      )}
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
              onClick={() => {
                if (!loadErrorFatal) {
                  retryAnalysis();
                  return;
                }
                setReloadError(null);
                void shutdownAppForReload({ preserveWorkspace: true })
                  .then(() => window.location.reload())
                  .catch((error: unknown) => setReloadError(`Could not save before reload: ${error instanceof Error ? error.message : String(error)}. Your edits remain open.`));
              }}
              style={{
                font: 'inherit',
                color: 'inherit',
                background: 'none',
                border: '1px solid var(--rule-strong)',
                cursor: 'pointer',
                padding: '0 0.5ch',
              }}
            >
              {loadErrorFatal ? 'reload' : 'retry'}
            </button>
          </p>
        )}
        {reloadError && <p role="alert">{reloadError}</p>}
      </div>
      <div className="workbench">
        <div className="place-region">
          {routeStatus === 'pending'
            ? <p className="region-placeholder" role="status">preparing your workspace…</p>
            : (
                <SettingsEntryProvider openSettings={openSettingsEntry}>
                  <PlaceSurface place={place}>
                    {hasNoInputs && place !== 'inputs'
                      ? (
                          <NoInputsPlace onOpenInputs={() => {
                            setPlace('inputs');
                            focusAfterRender('place-inputs-heading');
                          }} />
                        )
                      : <ActivePlace key={place} place={place} />}
                  </PlaceSurface>
                </SettingsEntryProvider>
              )}
        </div>
      </div>
      <WorkbenchDock globalShortcuts={place === 'trends'} onCloseFind={closeFind} />
    </main>
    {utilityPaneSurface}
    </>
  );
}
