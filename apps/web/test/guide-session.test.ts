import { describe, expect, it, vi } from 'vitest';
import type { GuideStep } from '../src/lib/guide/definition.ts';
import {
  GUIDE_RESTORE_TIMEOUT_MS,
  classifyGuideNavigation,
  guideReaderTarget,
  qualifyExpectedReaderOpen,
  qualifyNativeReaderOpen,
  startGuideSession,
  transitionGuideSession,
  type GuideNavigationFacts,
  type GuideReaderFence,
  type GuideReaderTarget,
  type GuideSession,
} from '../src/lib/guide/session.ts';
import {
  GUIDE_STAGE_KINDS,
  applyGuideStage,
  type GuideStageIntent,
} from '../src/lib/guide/stage.ts';

const TARGET: GuideReaderTarget = {
  snapshot: 'snapshot-1',
  doc: 'a',
  token: 42,
  from: 'barcode',
  anchor: 'occurrence',
};

function facts({
  place = 'trends',
  layerIds = [],
  reader = null,
}: Partial<GuideNavigationFacts> = {}): GuideNavigationFacts {
  return { place, layerIds, reader };
}

const BEFORE = facts({ layerIds: ['parent'] });
const OPEN = facts({ layerIds: ['parent', 'guide-reader'], reader: TARGET });
const FENCE: GuideReaderFence = {
  layerId: 'guide-reader',
  parentIds: ['parent'],
  parentPlace: 'trends',
  target: TARGET,
};

function step(
  id: string,
  advance: GuideStep['advance'] = { kind: 'manual' },
): GuideStep {
  return {
    id,
    kind: id === 'welcome' ? 'welcome' : id === 'finish' ? 'finish' : 'scene',
    cardSide: 'block-start',
    copy: () => ({
      kicker: 'Guide',
      title: id,
      body: id,
      actions: [{ id: 'primary', label: 'Next' }],
    }),
    advance,
  };
}

const STEPS: readonly GuideStep[] = [
  step('welcome'),
  step('terms'),
  step('axis'),
  step('mark', { kind: 'action', event: 'reader-opened' }),
  step('source'),
  step('return', { kind: 'action', event: 'reader-closed' }),
  step('finish'),
];

function session(): GuideSession {
  const started = startGuideSession(
    { id: 'guided-tour', version: 1, steps: STEPS },
    { place: 'inputs', focusCandidates: ['launch', 'help'] },
  );
  if (started === null) throw new Error('expected a session');
  return started;
}

function at(index: number, patch: Partial<GuideSession> = {}): GuideSession {
  const base = session();
  const current = STEPS[index]!;
  return {
    ...base,
    stepIndex: index,
    stepPhase: current.advance.kind === 'action' ? 'awaiting-action' : 'presenting',
    ...patch,
  };
}

describe('guide stage authority', () => {
  it('enumerates and routes exactly place, Reader open, and Reader close', () => {
    expect(GUIDE_STAGE_KINDS).toEqual(['place', 'reader-open', 'reader-close']);
    const actions = {
      replacePlace: vi.fn(),
      openReader: vi.fn(),
      closeReader: vi.fn(),
    };
    const stages: readonly GuideStageIntent[] = [
      { kind: 'place', place: 'matches' },
      { kind: 'reader-open', intent: TARGET },
      { kind: 'reader-close' },
    ];
    for (const stageIntent of stages) applyGuideStage(stageIntent, actions);

    expect(Object.keys(actions).sort()).toEqual([
      'closeReader', 'openReader', 'replacePlace',
    ]);
    expect(actions.replacePlace).toHaveBeenCalledExactlyOnceWith('matches');
    expect(actions.openReader).toHaveBeenCalledExactlyOnceWith(
      TARGET,
      'guide-card-heading',
    );
    expect(actions.closeReader).toHaveBeenCalledOnce();
  });
});

describe('qualified guide Reader navigation', () => {
  it('admits an expected open only for an exact appended target and layer', () => {
    expect(qualifyExpectedReaderOpen(BEFORE, OPEN, TARGET)).toEqual(FENCE);

    const targetFields: readonly (keyof GuideReaderTarget)[] = [
      'snapshot', 'doc', 'token', 'from', 'anchor',
    ];
    for (const field of targetFields) {
      const changed = {
        ...TARGET,
        [field]: field === 'token' ? 43 : `different-${field}`,
      } as GuideReaderTarget;
      expect(qualifyExpectedReaderOpen(BEFORE, facts({
        layerIds: OPEN.layerIds,
        reader: changed,
      }), TARGET), field).toBeNull();
    }
    expect(qualifyExpectedReaderOpen(BEFORE, facts({
      layerIds: ['different-parent', 'guide-reader'], reader: TARGET,
    }), TARGET)).toBeNull();
    expect(qualifyExpectedReaderOpen(BEFORE, facts({
      place: 'matches', layerIds: OPEN.layerIds, reader: TARGET,
    }), TARGET)).toBeNull();
    expect(qualifyExpectedReaderOpen(BEFORE, facts({
      layerIds: ['parent', 'parent'], reader: TARGET,
    }), TARGET)).toBeNull();
  });

  it('admits native opens only for a live exact barcode occurrence', () => {
    expect(qualifyNativeReaderOpen(BEFORE, OPEN, 'snapshot-1')).toEqual(FENCE);
    for (const reader of [
      { ...TARGET, snapshot: 'stale' },
      { ...TARGET, from: 'kwic' as const },
      { ...TARGET, anchor: 'position' as const },
    ]) {
      expect(qualifyNativeReaderOpen(BEFORE, facts({
        layerIds: OPEN.layerIds, reader,
      }), 'snapshot-1')).toBeNull();
    }
    expect(qualifyNativeReaderOpen(BEFORE, OPEN, null)).toBeNull();
  });

  it('recognizes movement and only the exact fenced close', () => {
    expect(classifyGuideNavigation(FENCE, OPEN, OPEN)).toBe('unchanged');
    expect(classifyGuideNavigation(FENCE, OPEN, facts({
      layerIds: OPEN.layerIds,
      reader: { ...TARGET, token: 99 },
    }))).toBe('reader-moved');
    expect(classifyGuideNavigation(FENCE, OPEN, BEFORE)).toBe('reader-closed');

    const foreign: readonly GuideNavigationFacts[] = [
      facts({ place: 'matches', layerIds: ['parent'] }),
      facts({ layerIds: [] }),
      facts({ layerIds: ['other-parent'] }),
      facts({ layerIds: ['parent', 'other-reader'], reader: TARGET }),
      facts({ layerIds: ['parent', 'guide-reader', 'nested'], reader: TARGET }),
    ];
    for (const after of foreign) {
      expect(classifyGuideNavigation(FENCE, OPEN, after), JSON.stringify(after))
        .toBe('foreign');
    }
    expect(classifyGuideNavigation(null, OPEN, BEFORE)).toBe('foreign');
  });

  it('projects every Reader cursor shape without changing the semantic target', () => {
    for (const cursor of [
      { kind: 'around' as const, token: 42 },
      { kind: 'from' as const, token: 42 },
      { kind: 'before' as const, token: 42 },
    ]) {
      expect(guideReaderTarget({
        snapshot: TARGET.snapshot,
        doc: TARGET.doc,
        cursor,
        from: TARGET.from,
        anchor: TARGET.anchor,
      })).toEqual(TARGET);
    }
    expect(guideReaderTarget(null)).toBeNull();
  });
});

describe('guide session transitions', () => {
  it('runs the seven beats without advancing past an awaited action', () => {
    let current = session();
    expect(current).toMatchObject({ stepIndex: 0, stepPhase: 'presenting', revision: 0 });

    let moved = transitionGuideSession(current, STEPS, { type: 'primary' });
    current = moved.session!;
    expect(current).toMatchObject({ stepIndex: 1, stepPhase: 'presenting', revision: 1 });

    moved = transitionGuideSession(current, STEPS, {
      type: 'primary', stage: { kind: 'place', place: 'trends' },
    });
    current = moved.session!;
    expect(moved.stage).toEqual({ kind: 'place', place: 'trends' });
    expect(current.stepIndex).toBe(2);

    current = transitionGuideSession(current, STEPS, { type: 'primary' }).session!;
    expect(current).toMatchObject({ stepIndex: 3, stepPhase: 'awaiting-action' });

    moved = transitionGuideSession(current, STEPS, {
      type: 'primary', stage: { kind: 'reader-open', intent: TARGET },
    });
    expect(moved.session).toBe(current);
    expect(moved.stage?.kind).toBe('reader-open');

    moved = transitionGuideSession(current, STEPS, {
      type: 'qualified-reader-open', fence: FENCE,
    });
    current = moved.session!;
    expect(moved).toMatchObject({ announcement: 'reader-opened' });
    expect(current).toMatchObject({ stepIndex: 4, readerFence: FENCE });

    current = transitionGuideSession(current, STEPS, { type: 'primary' }).session!;
    expect(current).toMatchObject({ stepIndex: 5, stepPhase: 'awaiting-action' });

    moved = transitionGuideSession(current, STEPS, {
      type: 'primary', stage: { kind: 'reader-close' },
    });
    expect(moved.session).toBe(current);
    expect(moved.stage).toEqual({ kind: 'reader-close' });

    moved = transitionGuideSession(current, STEPS, {
      type: 'qualified-reader-close', navigation: BEFORE,
    });
    current = moved.session!;
    expect(moved.announcement).toBe('reader-returned');
    expect(current).toMatchObject({
      stepIndex: 5, stepPhase: 'revealed', readerFence: null,
    });

    moved = transitionGuideSession(current, STEPS, {
      type: 'primary', stage: { kind: 'reader-close' },
    });
    expect(moved.stage).toBeUndefined();
    expect(moved.session).toMatchObject({ stepIndex: 6, stepPhase: 'presenting' });
  });

  it('reveals Return immediately when Source observes the fenced close', () => {
    const moved = transitionGuideSession(
      at(4, { readerFence: FENCE }),
      STEPS,
      { type: 'qualified-reader-close', navigation: BEFORE },
    );
    expect(moved).toMatchObject({
      session: { stepIndex: 5, stepPhase: 'revealed', readerFence: null },
      announcement: 'reader-returned',
      focus: { kind: 'heading' },
    });
  });

  it('ends on Reader events that do not match the current scene', () => {
    expect(transitionGuideSession(at(2), STEPS, {
      type: 'qualified-reader-open', fence: FENCE,
    }).session).toBeNull();
    expect(transitionGuideSession(at(3), STEPS, {
      type: 'qualified-reader-close', navigation: BEFORE,
    }).session).toBeNull();
    expect(transitionGuideSession(at(4), STEPS, {
      type: 'qualified-reader-open', fence: FENCE,
    }).session).toBeNull();
    expect(transitionGuideSession(at(4), STEPS, {
      type: 'qualified-reader-close', navigation: BEFORE,
    }).session).toBeNull();
  });

  it('restores origin focus if a terminal manual step advances off the script', () => {
    expect(transitionGuideSession(at(6), STEPS, { type: 'primary' })).toEqual({
      session: null,
      focus: { kind: 'origin', candidates: ['launch', 'help'] },
    });
  });

  it('replays from step zero with a fresh revision and no carried fence', () => {
    const replayed = transitionGuideSession(
      at(6, { revision: 9, readerFence: FENCE }),
      STEPS,
      { type: 'replay' },
    );
    expect(replayed).toMatchObject({
      session: {
        stepIndex: 0,
        stepPhase: 'presenting',
        revision: 10,
        readerFence: null,
        restore: { kind: 'idle' },
      },
      focus: { kind: 'heading' },
    });
    expect(replayed.stage).toBeUndefined();
  });

  it('ends foreign navigation without staging or stealing focus', () => {
    expect(transitionGuideSession(at(4, { readerFence: FENCE }), STEPS, {
      type: 'foreign-navigation',
    })).toEqual({ session: null });
  });
});

describe('guide origin restoration', () => {
  it('closes the fenced Reader, then restores place, then restores focus', () => {
    const active = at(4, { readerFence: FENCE });
    const closing = transitionGuideSession(active, STEPS, {
      type: 'restore-origin', navigation: OPEN, nowMs: 500,
    });
    expect(closing).toMatchObject({
      session: { restore: { kind: 'closing-reader', deadlineMs: 1_700 } },
      stage: { kind: 'reader-close' },
    });

    const replacing = transitionGuideSession(closing.session!, STEPS, {
      type: 'qualified-reader-close', navigation: BEFORE,
    });
    expect(replacing).toMatchObject({
      session: { restore: { kind: 'replacing-place' }, readerFence: null },
      stage: { kind: 'place', place: 'inputs' },
    });

    expect(transitionGuideSession(replacing.session!, STEPS, {
      type: 'place-restored',
    })).toEqual({
      session: null,
      announcement: 'origin-restored',
      focus: { kind: 'origin', candidates: ['launch', 'help'] },
    });
  });

  it('finishes directly when the qualified close returns to the origin place', () => {
    const active = at(4, {
      origin: { place: 'trends', focusCandidates: ['launch'] },
      readerFence: FENCE,
      restore: { kind: 'closing-reader', deadlineMs: 2_000 },
    });
    expect(transitionGuideSession(active, STEPS, {
      type: 'qualified-reader-close', navigation: BEFORE,
    })).toEqual({
      session: null,
      announcement: 'origin-restored',
      focus: { kind: 'origin', candidates: ['launch'] },
    });
  });

  it('uses one bounded close deadline and never stages a second restore on timeout', () => {
    const closing = transitionGuideSession(at(4, { readerFence: FENCE }), STEPS, {
      type: 'restore-origin', navigation: OPEN, nowMs: 50,
    });
    expect(GUIDE_RESTORE_TIMEOUT_MS).toBe(1_200);
    expect(transitionGuideSession(closing.session!, STEPS, {
      type: 'restore-timeout', nowMs: 1_249,
    })).toEqual({ session: closing.session });
    const timedOut = transitionGuideSession(closing.session!, STEPS, {
      type: 'restore-timeout', nowMs: 1_250,
    });
    expect(timedOut).toEqual({
      session: null,
      focus: { kind: 'origin', candidates: ['launch', 'help'] },
    });
    expect(timedOut.stage).toBeUndefined();
  });

  it('replaces only the origin place when no owned Reader is open', () => {
    const replacing = transitionGuideSession(at(6), STEPS, {
      type: 'restore-origin', navigation: facts({ place: 'trends' }), nowMs: 0,
    });
    expect(replacing).toMatchObject({
      session: { restore: { kind: 'replacing-place' } },
      stage: { kind: 'place', place: 'inputs' },
    });
    expect(transitionGuideSession(at(6, {
      origin: { place: 'trends', focusCandidates: ['launch'] },
    }), STEPS, {
      type: 'restore-origin', navigation: facts({ place: 'trends' }), nowMs: 0,
    })).toEqual({
      session: null,
      announcement: 'origin-restored',
      focus: { kind: 'origin', candidates: ['launch'] },
    });
  });
});
