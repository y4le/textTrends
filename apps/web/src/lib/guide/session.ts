import type { Place } from '../places.ts';
import type { ReaderOpenIntent, ReaderPlace } from '../reader-intent.ts';
import type {
  GuideDefinition,
  GuideEvent,
  GuideId,
  GuideStep,
  GuideStepPhase,
} from './definition.ts';
import type { GuideStageIntent } from './stage.ts';

export const GUIDE_RESTORE_TIMEOUT_MS = 1_200;

export type GuideReaderTarget = ReaderOpenIntent;

export interface GuideNavigationFacts {
  readonly place: Place;
  readonly layerIds: readonly string[];
  readonly reader: GuideReaderTarget | null;
}

export interface GuideReaderFence {
  readonly layerId: string;
  readonly parentIds: readonly string[];
  readonly parentPlace: Place;
  readonly target: GuideReaderTarget;
}

export interface GuideOrigin {
  readonly place: Place;
  readonly focusCandidates: readonly string[];
}

export interface GuideSession {
  readonly guideId: GuideId;
  readonly version: number;
  readonly stepIndex: number;
  readonly stepPhase: GuideStepPhase;
  readonly revision: number;
  readonly origin: GuideOrigin;
  readonly readerFence: GuideReaderFence | null;
  readonly restore:
    | { readonly kind: 'idle' }
    | { readonly kind: 'closing-reader'; readonly deadlineMs: number }
    | { readonly kind: 'replacing-place' };
}

export type GuideAnnouncement =
  | 'reader-opened'
  | 'reader-returned'
  | 'origin-restored';

export type GuideFocusRequest =
  | { readonly kind: 'heading' }
  | { readonly kind: 'origin'; readonly candidates: readonly string[] };

export interface GuideTransition {
  readonly session: GuideSession | null;
  readonly stage?: GuideStageIntent;
  readonly announcement?: GuideAnnouncement;
  readonly focus?: GuideFocusRequest;
}

export type GuideSessionCommand =
  | { readonly type: 'primary'; readonly stage?: GuideStageIntent | null }
  | { readonly type: 'qualified-reader-open'; readonly fence: GuideReaderFence }
  | { readonly type: 'qualified-reader-close'; readonly navigation: GuideNavigationFacts }
  | { readonly type: 'foreign-navigation' }
  | { readonly type: 'dismiss' }
  | {
      readonly type: 'restore-origin';
      readonly navigation: GuideNavigationFacts;
      readonly nowMs: number;
    }
  | { readonly type: 'place-restored' }
  | { readonly type: 'restore-timeout'; readonly nowMs: number }
  | { readonly type: 'abridge' }
  | { readonly type: 'replay' };

export type GuideNavigationChange =
  | 'unchanged'
  | 'reader-moved'
  | 'reader-closed'
  | 'foreign';

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function sameReaderTarget(
  left: GuideReaderTarget | null,
  right: GuideReaderTarget | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.snapshot === right.snapshot
    && left.doc === right.doc
    && left.token === right.token
    && left.from === right.from
    && left.anchor === right.anchor
  );
}

function exactReaderAppend(
  before: GuideNavigationFacts,
  after: GuideNavigationFacts,
): string | null {
  if (
    before.reader !== null
    || after.reader === null
    || before.place !== after.place
    || after.layerIds.length !== before.layerIds.length + 1
    || !sameStrings(before.layerIds, after.layerIds.slice(0, -1))
  ) return null;
  const layerId = after.layerIds.at(-1) ?? null;
  return layerId !== null && !before.layerIds.includes(layerId) ? layerId : null;
}

function fenceForOpen(
  before: GuideNavigationFacts,
  after: GuideNavigationFacts,
): GuideReaderFence | null {
  const layerId = exactReaderAppend(before, after);
  if (layerId === null || after.reader === null) return null;
  return {
    layerId,
    parentIds: [...before.layerIds],
    parentPlace: before.place,
    target: { ...after.reader },
  };
}

/** Admit a card-staged open only when every semantic target claim agrees. */
export function qualifyExpectedReaderOpen(
  before: GuideNavigationFacts,
  after: GuideNavigationFacts,
  expected: GuideReaderTarget,
): GuideReaderFence | null {
  if (!sameReaderTarget(after.reader, expected)) return null;
  return fenceForOpen(before, after);
}

/** Admit a native mark only for exact barcode evidence in the live snapshot. */
export function qualifyNativeReaderOpen(
  before: GuideNavigationFacts,
  after: GuideNavigationFacts,
  liveSnapshot: string | null,
): GuideReaderFence | null {
  if (
    liveSnapshot === null
    || after.reader?.snapshot !== liveSnapshot
    || after.reader.from !== 'barcode'
    || after.reader.anchor !== 'occurrence'
  ) return null;
  return fenceForOpen(before, after);
}

/** Project the Reader store shape into the only facts guide navigation uses. */
export function guideReaderTarget(place: ReaderPlace | null): GuideReaderTarget | null {
  if (place === null) return null;
  return {
    snapshot: place.snapshot,
    doc: place.doc,
    token: place.cursor.token,
    from: place.from,
    anchor: place.anchor,
  };
}

function fencedOpenFacts(
  fence: GuideReaderFence,
  facts: GuideNavigationFacts,
): boolean {
  return facts.place === fence.parentPlace
    && facts.reader !== null
    && facts.layerIds.length === fence.parentIds.length + 1
    && facts.layerIds.at(-1) === fence.layerId
    && sameStrings(facts.layerIds.slice(0, -1), fence.parentIds);
}

/** Classify only the exact Reader layer owned by this guide. */
export function classifyGuideNavigation(
  fence: GuideReaderFence | null,
  before: GuideNavigationFacts,
  after: GuideNavigationFacts,
): GuideNavigationChange {
  if (
    before.place === after.place
    && sameStrings(before.layerIds, after.layerIds)
    && sameReaderTarget(before.reader, after.reader)
  ) return 'unchanged';
  if (fence === null || !fencedOpenFacts(fence, before)) return 'foreign';
  if (fencedOpenFacts(fence, after)) return 'reader-moved';
  if (
    after.place === fence.parentPlace
    && after.reader === null
    && sameStrings(after.layerIds, fence.parentIds)
  ) return 'reader-closed';
  return 'foreign';
}

function phaseFor(step: GuideStep): GuideStepPhase {
  return step.advance.kind === 'action' ? 'awaiting-action' : 'presenting';
}

function focusHeading(): GuideFocusRequest {
  return { kind: 'heading' };
}

function advance(
  session: GuideSession,
  steps: readonly GuideStep[],
  phase?: GuideStepPhase,
): GuideTransition {
  const nextIndex = session.stepIndex + 1;
  const next = steps[nextIndex];
  if (next === undefined) return endAtOrigin(session);
  return {
    session: {
      ...session,
      stepIndex: nextIndex,
      stepPhase: phase ?? phaseFor(next),
      revision: session.revision + 1,
    },
    focus: focusHeading(),
  };
}

function expectedEvent(step: GuideStep | undefined): GuideEvent | null {
  return step?.advance.kind === 'action' ? step.advance.event : null;
}

export function startGuideSession(
  definition: Pick<GuideDefinition, 'id' | 'version' | 'steps'>,
  origin: GuideOrigin,
): GuideSession | null {
  const first = definition.steps[0];
  if (first === undefined) return null;
  return {
    guideId: definition.id,
    version: definition.version,
    stepIndex: 0,
    stepPhase: phaseFor(first),
    revision: 0,
    origin: {
      place: origin.place,
      focusCandidates: [...origin.focusCandidates],
    },
    readerFence: null,
    restore: { kind: 'idle' },
  };
}

function endAtOrigin(session: GuideSession): GuideTransition {
  return {
    session: null,
    focus: { kind: 'origin', candidates: session.origin.focusCandidates },
  };
}

function restoreAfterReaderClose(
  session: GuideSession,
  navigation: GuideNavigationFacts,
): GuideTransition {
  if (navigation.place !== session.origin.place) {
    return {
      session: {
        ...session,
        readerFence: null,
        restore: { kind: 'replacing-place' },
      },
      stage: { kind: 'place', place: session.origin.place },
    };
  }
  return {
    ...endAtOrigin(session),
    announcement: 'origin-restored',
  };
}

/** Pure guide state machine. The caller resolves any current-step stage. */
export function transitionGuideSession(
  session: GuideSession,
  steps: readonly GuideStep[],
  command: GuideSessionCommand,
): GuideTransition {
  const step = steps[session.stepIndex];
  if (step === undefined) return { session: null };

  if (command.type === 'foreign-navigation') return { session: null };
  if (command.type === 'dismiss') return endAtOrigin(session);
  if (command.type === 'replay') {
    const first = steps[0];
    if (first === undefined) return { session: null };
    return {
      session: {
        ...session,
        stepIndex: 0,
        stepPhase: phaseFor(first),
        revision: session.revision + 1,
        readerFence: null,
        restore: { kind: 'idle' },
      },
      focus: focusHeading(),
    };
  }

  if (session.restore.kind !== 'idle') {
    if (command.type === 'qualified-reader-close' && session.restore.kind === 'closing-reader') {
      return restoreAfterReaderClose(session, command.navigation);
    }
    if (command.type === 'place-restored' && session.restore.kind === 'replacing-place') {
      return {
        ...endAtOrigin(session),
        announcement: 'origin-restored',
      };
    }
    if (
      command.type === 'restore-timeout'
      && session.restore.kind === 'closing-reader'
      && command.nowMs >= session.restore.deadlineMs
    ) return endAtOrigin(session);
    return { session };
  }

  switch (command.type) {
    case 'primary': {
      if (session.stepPhase === 'revealed') return advance(session, steps);
      if (command.stage !== undefined && command.stage !== null) {
        if (step.advance.kind === 'action') return { session, stage: command.stage };
        const moved = advance(session, steps);
        return { ...moved, stage: command.stage };
      }
      if (step.advance.kind === 'manual') return advance(session, steps);
      return { session };
    }
    case 'qualified-reader-open': {
      if (
        session.stepPhase !== 'awaiting-action'
        || expectedEvent(step) !== 'reader-opened'
      ) return { session: null };
      const moved = advance({ ...session, readerFence: command.fence }, steps);
      return { ...moved, announcement: 'reader-opened' };
    }
    case 'qualified-reader-close': {
      if (session.readerFence === null) return { session: null };
      if (
        session.stepPhase === 'awaiting-action'
        && expectedEvent(step) === 'reader-closed'
      ) {
        return {
          session: {
            ...session,
            stepPhase: 'revealed',
            revision: session.revision + 1,
            readerFence: null,
          },
          announcement: 'reader-returned',
          focus: focusHeading(),
        };
      }
      if (expectedEvent(steps[session.stepIndex + 1]) === 'reader-closed') {
        const moved = advance(
          { ...session, readerFence: null },
          steps,
          'revealed',
        );
        return { ...moved, announcement: 'reader-returned' };
      }
      return { session: null };
    }
    case 'restore-origin': {
      if (session.readerFence !== null && fencedOpenFacts(session.readerFence, command.navigation)) {
        return {
          session: {
            ...session,
            restore: {
              kind: 'closing-reader',
              deadlineMs: command.nowMs + GUIDE_RESTORE_TIMEOUT_MS,
            },
          },
          stage: { kind: 'reader-close' },
        };
      }
      if (command.navigation.place !== session.origin.place) {
        return {
          session: { ...session, restore: { kind: 'replacing-place' } },
          stage: { kind: 'place', place: session.origin.place },
        };
      }
      return {
        ...endAtOrigin(session),
        announcement: 'origin-restored',
      };
    }
    case 'abridge': {
      if (session.readerFence !== null) return { session };
      const finishIndex = steps.findIndex((candidate, index) => (
        index > session.stepIndex && candidate.kind === 'finish'
      ));
      if (finishIndex < 0) return endAtOrigin(session);
      return {
        session: {
          ...session,
          stepIndex: finishIndex,
          stepPhase: 'abridged',
          revision: session.revision + 1,
          readerFence: null,
        },
        focus: focusHeading(),
      };
    }
    case 'place-restored':
    case 'restore-timeout':
      return { session };
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}
