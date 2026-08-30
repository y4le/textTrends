import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppState } from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';
import {
  readOccurrenceActivation,
  type ObservedOccurrenceActivation,
} from '../../lib/guide/activation.ts';
import {
  GUIDE_ACTIVE_ANCHOR_ATTRIBUTE,
  GUIDE_CARD_HEADING_ID,
  GUIDE_LIVE_REGION_ID,
  queryGuideAnchor,
} from '../../lib/guide/anchors.ts';
import {
  guidedTourReadiness,
  type GuideContext as GuideFacts,
} from '../../lib/guide/context.ts';
import {
  GUIDED_TOUR_VERSION,
  type GuideActionId,
  type GuideDefinition,
  type GuideId,
} from '../../lib/guide/definition.ts';
import {
  advanceGuideProgress,
  browserGuideLocalStorage,
  guideProgressCovers,
  loadGuideProgress,
  saveGuideProgress,
  type GuideProgressField,
} from '../../lib/guide/storage.ts';
import {
  classifyGuideNavigation,
  guideReaderTarget,
  qualifyExpectedReaderOpen,
  qualifyNativeReaderOpen,
  startGuideSession,
  transitionGuideSession,
  type GuideAnnouncement,
  type GuideFocusRequest,
  type GuideNavigationFacts,
  type GuideOrigin,
  type GuideSession,
  type GuideSessionCommand,
  type GuideTransition,
} from '../../lib/guide/session.ts';
import { applyGuideStage, type GuideStageIntent } from '../../lib/guide/stage.ts';
import { resolveGuideTarget } from '../../lib/guide/target.ts';
import { usePresentation } from '../PresentationProvider.tsx';
import {
  GuideControllerContext,
  type GuideController,
} from './GuideContext.ts';
import {
  GUIDE_INVITATION_START_ID,
  GuideInvitation,
} from './GuideInvitation.tsx';

export { useGuide } from './GuideContext.ts';

const GuideCard = lazy(() =>
  import('./GuideCard.tsx').then(({ GuideCard: card }) => ({ default: card })),
);

interface ActiveGuide {
  readonly definition: GuideDefinition;
  readonly session: GuideSession;
}

export type { GuideId, GuideReadinessRemedy } from '../../lib/guide/definition.ts';

function navigationFacts(state: AppState): GuideNavigationFacts {
  return {
    place: state.place,
    layerIds: state.layers.map((layer) => layer.id),
    reader: guideReaderTarget(state.readerPlace),
  };
}

function announcementText(announcement: GuideAnnouncement): string {
  switch (announcement) {
    case 'reader-opened': return 'Opened the source in Reader.';
    case 'reader-returned': return 'Returned to the chart at the reading position.';
    case 'origin-restored': return 'Returned to where the guide started.';
  }
}

function currentStep(active: ActiveGuide) {
  return active.definition.steps[active.session.stepIndex];
}

export function GuideProvider({ children }: { readonly children: ReactNode }) {
  const presentation = usePresentation();
  const place = useApp((state) => state.place);
  const snapshot = useApp((state) => state.snapshot);
  const series = useApp((state) => state.series);
  const dispersion = useApp((state) => state.dispersion);
  const corpusTokenCounts = useApp((state) => state.corpusTokenCounts);
  const measure = useApp((state) => state.trendMeasure.kind);
  const readerOpen = useApp((state) => state.readerPlace !== null);
  const rsvpActive = useApp((state) => state.interaction.kind === 'rsvp');
  const [activation, setActivation] = useState<ObservedOccurrenceActivation>('unknown');
  const [active, setActive] = useState<ActiveGuide | null>(null);
  const [progressStorage] = useState<Storage | null>(() => (
    typeof window === 'undefined' ? null : browserGuideLocalStorage(window)
  ));
  const [guideProgress, setGuideProgress] = useState(() => (
    loadGuideProgress(progressStorage)
  ));
  const guideProgressRef = useRef(guideProgress);
  const [invitationStarting, setInvitationStarting] = useState(false);
  const [focusTask, setFocusTask] = useState<{
    readonly serial: number;
    readonly request: GuideFocusRequest;
  } | null>(null);
  const [announcement, setAnnouncement] = useState<{
    readonly serial: number;
    readonly text: string;
  } | null>(null);
  const activeRef = useRef<ActiveGuide | null>(null);
  const factsRef = useRef<GuideFacts | null>(null);
  const navigationRef = useRef(navigationFacts(useApp.getState()));
  const absorbingStage = useRef(0);
  const issueRef = useRef<(command: GuideSessionCommand) => void>(() => undefined);
  const startRequest = useRef(0);
  const mounted = useRef(false);
  const serial = useRef(0);
  const reducedMotion = useRef(presentation.reducedMotion);
  reducedMotion.current = presentation.reducedMotion;

  const shownTerms = useMemo(() => series.map((item) => ({
    seriesId: item.id,
    label: item.label,
  })), [series]);
  const guideDispersion = useMemo(() => dispersion === null
    ? null
    : { snapshotId: dispersion.snapshot, state: dispersion.state }, [dispersion]);
  const target = useMemo(() => resolveGuideTarget({
    snapshotId: snapshot?.snapshot ?? null,
    readyDocs: snapshot?.readyDocs ?? [],
    shownTerms,
    dispersion: guideDispersion,
    tokenCountOf: (doc) => corpusTokenCounts.get(doc),
  }), [corpusTokenCounts, guideDispersion, shownTerms, snapshot]);
  const facts = useMemo<GuideFacts>(() => ({
    place,
    readerOpen,
    rsvpActive,
    snapshotId: snapshot?.snapshot ?? null,
    readyDocs: snapshot?.readyDocs ?? [],
    readyTexts: snapshot?.readyDocs.length ?? 0,
    shownTerms,
    measure,
    rateDenominator: TREND_RATE_DENOMINATOR,
    occurrenceActivation: activation,
    target,
  }), [
    activation,
    measure,
    place,
    readerOpen,
    rsvpActive,
    shownTerms,
    snapshot,
    target,
  ]);
  factsRef.current = facts;

  const publishActive = useCallback((next: ActiveGuide | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  const requestFocus = useCallback((request: GuideFocusRequest) => {
    setFocusTask({ serial: ++serial.current, request });
  }, []);

  const publishAnnouncement = useCallback((next: GuideAnnouncement) => {
    setAnnouncement({ serial: ++serial.current, text: announcementText(next) });
  }, []);

  const recordProgress = useCallback((field: GuideProgressField) => {
    const current = guideProgressRef.current;
    const next = advanceGuideProgress(current, field, GUIDED_TOUR_VERSION);
    if (next === current) return;
    guideProgressRef.current = next;
    setGuideProgress(next);
    saveGuideProgress(progressStorage, next);
  }, [progressStorage]);

  const applyStage = useCallback((stage: GuideStageIntent) => {
    const before = navigationFacts(useApp.getState());
    const actions = {
      replacePlace: (destination: Parameters<AppState['replacePlace']>[0]) =>
        useApp.getState().replacePlace(destination),
      openReader: (
        intent: Parameters<AppState['openReader']>[0],
        returnFocusTo?: string,
      ) => useApp.getState().openReader(intent, returnFocusTo),
      closeReader: () => useApp.getState().closeReader(),
    };
    const absorb = stage.kind !== 'reader-close';
    if (absorb) absorbingStage.current += 1;
    try {
      applyGuideStage(stage, actions);
    } finally {
      if (absorb) absorbingStage.current -= 1;
    }
    const after = navigationFacts(useApp.getState());
    navigationRef.current = after;

    if (stage.kind === 'reader-open') {
      const fence = qualifyExpectedReaderOpen(before, after, stage.intent);
      if (fence !== null) {
        issueRef.current({ type: 'qualified-reader-open', fence });
      } else if (classifyGuideNavigation(null, before, after) !== 'unchanged') {
        issueRef.current({ type: 'foreign-navigation' });
      }
    } else if (
      stage.kind === 'place'
      && activeRef.current?.session.restore.kind === 'replacing-place'
    ) {
      issueRef.current({ type: 'place-restored' });
    }
  }, []);

  const commitTransition = useCallback((transition: GuideTransition) => {
    const current = activeRef.current;
    if (current === null) return;
    const next = transition.session === null
      ? null
      : { definition: current.definition, session: transition.session };
    const nextStep = next === null ? undefined : current.definition.steps[next.session.stepIndex];
    if (
      current.session.guideId === 'guided-tour'
      && nextStep?.kind === 'finish'
      && currentStep(current)?.kind !== 'finish'
      && next?.session.stepPhase !== 'abridged'
    ) {
      recordProgress('tourSeenVersion');
    }
    publishActive(next);
    if (transition.announcement !== undefined) {
      publishAnnouncement(transition.announcement);
    }
    if (transition.focus !== undefined) requestFocus(transition.focus);
    if (transition.stage !== undefined) applyStage(transition.stage);
  }, [applyStage, publishActive, publishAnnouncement, recordProgress, requestFocus]);
  const issue = useCallback((command: GuideSessionCommand) => {
    const current = activeRef.current;
    if (current === null) return;
    commitTransition(transitionGuideSession(
      current.session,
      current.definition.steps,
      command,
    ));
  }, [commitTransition]);
  issueRef.current = issue;

  const startGuide = useCallback(async (
    id: GuideId,
    origin: GuideOrigin,
  ): Promise<boolean> => {
    const request = ++startRequest.current;
    const registry = await import('../../lib/guide/registry.ts');
    if (!mounted.current || request !== startRequest.current) return false;
    const definition = registry.guideDefinition(id);
    const currentFacts = factsRef.current;
    if (
      definition === null
      || currentFacts === null
      || definition.requires(currentFacts).status !== 'ready'
    ) return false;
    const session = startGuideSession(definition, origin);
    if (session === null) return false;
    publishActive({ definition, session });
    requestFocus({ kind: 'heading' });
    return true;
  }, [publishActive, requestFocus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      startRequest.current += 1;
    };
  }, []);

  useEffect(() => useApp.subscribe((state) => {
    const before = navigationRef.current;
    const after = navigationFacts(state);
    navigationRef.current = after;
    if (absorbingStage.current > 0) return;
    const current = activeRef.current;
    if (current === null) return;

    const change = classifyGuideNavigation(current.session.readerFence, before, after);
    if (change === 'unchanged' || change === 'reader-moved') return;
    if (change === 'reader-closed') {
      issueRef.current({ type: 'qualified-reader-close', navigation: after });
      return;
    }

    const step = currentStep(current);
    if (
      current.session.readerFence === null
      && current.session.stepPhase === 'awaiting-action'
      && step?.advance.kind === 'action'
      && step.advance.event === 'reader-opened'
    ) {
      const fence = qualifyNativeReaderOpen(before, after, state.snapshot?.snapshot ?? null);
      if (fence !== null) {
        issueRef.current({ type: 'qualified-reader-open', fence });
        return;
      }
    }
    issueRef.current({ type: 'foreign-navigation' });
  }), []);

  useEffect(() => {
    const restore = active?.session.restore;
    if (restore?.kind !== 'closing-reader') return undefined;
    const timeout = setTimeout(() => {
      issueRef.current({
        type: 'restore-timeout',
        nowMs: Math.max(Date.now(), restore.deadlineMs),
      });
    }, Math.max(0, restore.deadlineMs - Date.now()));
    return () => clearTimeout(timeout);
  }, [active?.session.restore]);

  const sceneKey = active === null
    ? null
    : `${active.session.guideId}:${active.session.stepIndex}:${active.session.revision}`;
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    root?.removeAttribute(GUIDE_ACTIVE_ANCHOR_ATTRIBUTE);
    setActivation('unknown');
    if (root === null || activeRef.current === null) return undefined;
    const step = currentStep(activeRef.current);
    if (step?.anchor === undefined) return undefined;
    const anchor = queryGuideAnchor(root, step.anchor);
    if (anchor === null) return undefined;
    root.setAttribute(GUIDE_ACTIVE_ANCHOR_ATTRIBUTE, step.anchor);
    // Activation is deliberately sampled once on scene entry. The guide's
    // semantic-anchor contract forbids observers that track product layout.
    if (step.anchor === 'dispersion-strip') {
      setActivation(readOccurrenceActivation(anchor));
    }
    anchor.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: reducedMotion.current ? 'auto' : 'smooth',
    });
    const owned = step.anchor;
    return () => {
      if (root.getAttribute(GUIDE_ACTIVE_ANCHOR_ATTRIBUTE) === owned) {
        root.removeAttribute(GUIDE_ACTIVE_ANCHOR_ATTRIBUTE);
      }
    };
  }, [sceneKey]);

  useLayoutEffect(() => {
    if (focusTask === null) return;
    if (focusTask.request.kind === 'heading') {
      document.getElementById(GUIDE_CARD_HEADING_ID)?.focus({ preventScroll: true });
      return;
    }
    for (const id of focusTask.request.candidates) {
      const candidate = document.getElementById(id);
      if (candidate?.isConnected) {
        candidate.focus({ preventScroll: true });
        return;
      }
    }
  }, [focusTask]);

  useEffect(() => {
    if (announcement === null || active !== null) return undefined;
    const timeout = setTimeout(() => setAnnouncement(null), 1_000);
    return () => clearTimeout(timeout);
  }, [active, announcement]);

  const handleAction = useCallback((action: GuideActionId) => {
    const current = activeRef.current;
    const currentFacts = factsRef.current;
    if (current === null || currentFacts === null) return;
    switch (action) {
      case 'primary': {
        const stage = currentStep(current)?.stage?.(currentFacts) ?? null;
        issueRef.current({ type: 'primary', stage });
        return;
      }
      case 'abridge':
        issueRef.current({ type: 'abridge' });
        return;
      case 'restore-origin':
        issueRef.current({
          type: 'restore-origin',
          navigation: navigationFacts(useApp.getState()),
          nowMs: Date.now(),
        });
        return;
      case 'replay':
        issueRef.current({ type: 'replay' });
        return;
      case 'exit':
        if (current.session.readerFence === null) {
          issueRef.current({ type: 'dismiss' });
        } else {
          issueRef.current({
            type: 'restore-origin',
            navigation: navigationFacts(useApp.getState()),
            nowMs: Date.now(),
          });
        }
    }
  }, []);

  const readiness = useMemo(() => guidedTourReadiness(facts), [facts]);
  const guidedTourSeen = guideProgressCovers(
    guideProgress,
    'tourSeenVersion',
    GUIDED_TOUR_VERSION,
  );
  const invitationDismissed = guideProgressCovers(
    guideProgress,
    'dismissedInvitationVersion',
    GUIDED_TOUR_VERSION,
  );
  const showInvitation = active === null
    && readiness.status === 'ready'
    && !guidedTourSeen
    && !invitationDismissed;
  const invitationFocusCandidates = useCallback(() => {
    const originPlace = useApp.getState().place;
    return {
      originPlace,
      candidates: [
        GUIDE_INVITATION_START_ID,
        'global-help-open',
        `place-${originPlace}-heading`,
      ],
    };
  }, []);
  const startFromInvitation = useCallback(() => {
    if (invitationStarting) return;
    const { originPlace, candidates } = invitationFocusCandidates();
    setInvitationStarting(true);
    void startGuide('guided-tour', { place: originPlace, focusCandidates: candidates })
      .then((started) => {
        if (started) {
          recordProgress('dismissedInvitationVersion');
          return;
        }
        document.getElementById('global-help-open')?.focus({ preventScroll: true });
      })
      .finally(() => {
        if (mounted.current) setInvitationStarting(false);
      });
  }, [invitationFocusCandidates, invitationStarting, recordProgress, startGuide]);
  const dismissInvitation = useCallback(() => {
    const { candidates } = invitationFocusCandidates();
    recordProgress('dismissedInvitationVersion');
    requestAnimationFrame(() => {
      for (const id of candidates.slice(1)) {
        const candidate = document.getElementById(id);
        if (candidate?.isConnected) {
          candidate.focus({ preventScroll: true });
          return;
        }
      }
    });
  }, [invitationFocusCandidates, recordProgress]);
  const controller = useMemo<GuideController>(() => ({
    activeGuideId: active?.session.guideId ?? null,
    guidedTourReadiness: readiness,
    guidedTourSeen,
    startGuide,
  }), [active?.session.guideId, guidedTourSeen, readiness, startGuide]);
  const step = active === null ? null : currentStep(active);
  const showCard = active !== null
    && step !== undefined
    && active.session.restore.kind === 'idle';

  return (
    <GuideControllerContext.Provider value={controller}>
      {children}
      {showInvitation && (
        <GuideInvitation
          starting={invitationStarting}
          onStart={startFromInvitation}
          onDismiss={dismissInvitation}
        />
      )}
      {showCard && step && (
        <Suspense fallback={null}>
          <GuideCard
            copy={step.copy(facts, active.session.stepPhase)}
            side={step.cardSide}
            stepId={step.id}
            focusRevision={active.session.revision}
            reader={readerOpen}
            place={place}
            exitLabel={active.session.guideId === 'guided-tour'
              ? 'Exit guided tour'
              : 'Exit guide'}
            onAction={handleAction}
          />
        </Suspense>
      )}
      <p
        id={GUIDE_LIVE_REGION_ID}
        className="visually-hidden"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement?.text ?? ''}
      </p>
    </GuideControllerContext.Provider>
  );
}
