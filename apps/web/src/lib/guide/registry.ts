import type {
  GuideCopy,
  GuideDefinition,
  GuideId,
  GuideReadiness,
  GuideStepPhase,
} from './definition.ts';
import type { GuideContext } from './context.ts';

export const GUIDED_TOUR_VERSION = 1;

const PRIMARY_NEXT = Object.freeze([
  { id: 'primary', label: 'Next' },
] as const);

const FINISH_ACTIONS = Object.freeze([
  { id: 'exit', label: 'Stay here' },
  { id: 'restore-origin', label: 'Back to where I was' },
  { id: 'replay', label: 'Replay' },
] as const);

const MARK_EXACT_TITLE = 'Every mark is a position';
const MARK_EXACT_BODY = 'The strip beneath the graph is the occurrences themselves — one mark, one reference. Open one and you are in the text.';

function ready(): GuideReadiness {
  return { status: 'ready' };
}

export function guidedTourReadiness(context: GuideContext): GuideReadiness {
  if (context.rsvpActive) {
    return { status: 'disabled', reason: 'Exit Speed reader to start.' };
  }
  if (context.readerOpen) {
    return { status: 'disabled', reason: 'Return to Trends to start the guided tour.' };
  }
  if (context.readyTexts === 0) {
    return {
      status: 'disabled',
      reason: 'Add a ready text before starting the guided tour.',
      remedy: { id: 'add-text', label: 'Add a text' },
    };
  }
  if (context.shownTerms.length === 0) {
    return {
      status: 'disabled',
      reason: 'Track at least one term before starting the guided tour.',
      remedy: { id: 'track-term', label: 'Track a term' },
    };
  }
  if (context.target.status === 'pending' || context.target.status === 'ready') {
    return ready();
  }
  switch (context.target.reason) {
    case 'no-occurrences':
      return {
        status: 'disabled',
        reason: 'Show a term that occurs in a ready text.',
      };
    case 'failed':
      return {
        status: 'disabled',
        reason: 'Retry the reading strip from the chart before starting.',
      };
    case 'no-corpus':
      return {
        status: 'disabled',
        reason: 'Add a ready text before starting the guided tour.',
        remedy: { id: 'add-text', label: 'Add a text' },
      };
    case 'no-shown-term':
      return {
        status: 'disabled',
        reason: 'Track at least one term before starting the guided tour.',
        remedy: { id: 'track-term', label: 'Track a term' },
      };
  }
}

function axisCopy(context: GuideContext): GuideCopy {
  const measurement = context.measure === 'count'
    ? 'Height is a raw count.'
    : `Height is a rate per ${context.rateDenominator.toLocaleString('en-US')} tokens.`;
  return {
    kicker: 'Guided tour · chart',
    title: 'One order, followed everywhere',
    body: 'Each line follows a term through the corpus in declared reading order and breaks at every text boundary. Matches, the reading strip, and Reader all use that same order.',
    hints: [measurement],
    actions: PRIMARY_NEXT,
  };
}

function exactActivationHints(context: GuideContext): readonly string[] | undefined {
  switch (context.occurrenceActivation) {
    case 'available':
      return ['You can also activate any mark directly.'];
    case 'coarse':
      // Conservative on hybrid devices: true for touch, even when a mouse is
      // also available. The card action remains the universal route.
      return ['On touch these marks are read-only; this card opens the one it found.'];
    case 'minimized':
      return ['These marks are minimized at this row height. This card opens the one it found.'];
    case 'unknown':
      return undefined;
  }
}

function pendingMarkCopy(
  reason: Extract<GuideContext['target'], { readonly status: 'pending' }>['reason'],
): GuideCopy {
  let status: string;
  switch (reason) {
    case 'dispersion':
      status = 'Measuring the strip for your shown terms…';
      break;
    case 'superseded':
      status = 'Your corpus changed. Measuring the strip again…';
      break;
    case 'extents':
      status = 'Locating the text this mark falls in…';
      break;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
  return {
    kicker: 'Guided tour · reading strip',
    title: MARK_EXACT_TITLE,
    body: MARK_EXACT_BODY,
    status: { tone: 'pending', text: status },
    actions: [
      { id: 'primary', label: 'Open a mark', disabled: true },
      { id: 'exit', label: 'Exit the tour' },
    ],
  };
}

function unavailableMarkCopy(
  reason: Extract<GuideContext['target'], { readonly status: 'unavailable' }>['reason'],
): GuideCopy {
  const content = {
    'no-occurrences': {
      body: 'None of your shown terms occurs in a ready text, so the strip has no mark to open.',
      status: 'Show a term that occurs in a ready text.',
    },
    'no-shown-term': {
      body: 'No terms are shown right now, so the strip has nothing to mark.',
      status: 'Track a term, then replay the tour.',
    },
    'no-corpus': {
      body: 'There are no ready texts right now, so the strip has nothing to mark.',
      status: 'Add a text, then replay the tour.',
    },
    failed: {
      body: 'The strip could not be measured.',
      status: 'Retry it from the chart, then replay the tour.',
    },
  } as const;
  return {
    kicker: 'Guided tour · reading strip',
    title: MARK_EXACT_TITLE,
    body: content[reason].body,
    status: { tone: 'unavailable', text: content[reason].status },
    actions: [
      { id: 'abridge', label: 'Continue without a mark' },
      { id: 'exit', label: 'Exit the tour' },
    ],
  };
}

function markCopy(context: GuideContext): GuideCopy {
  const resolution = context.target;
  if (resolution.status === 'pending') return pendingMarkCopy(resolution.reason);
  if (resolution.status === 'unavailable') return unavailableMarkCopy(resolution.reason);
  if (resolution.target.kind === 'density') {
    return {
      kicker: 'Guided tour · reading strip',
      title: 'These marks are counts',
      body: 'Above a threshold the strip shows density bands rather than single occurrences. A band tells you how many, never which one.',
      actions: [{ id: 'primary', label: 'Open this position' }],
    };
  }
  const hints = exactActivationHints(context);
  return {
    kicker: 'Guided tour · reading strip',
    title: MARK_EXACT_TITLE,
    body: MARK_EXACT_BODY,
    ...(hints === undefined ? {} : { hints }),
    actions: [{ id: 'primary', label: 'Open this reference' }],
  };
}

function returnCopy(phase: GuideStepPhase): GuideCopy {
  const revealed = phase === 'revealed';
  return {
    kicker: 'Guided tour · return',
    title: 'The place comes with you',
    body: revealed
      ? 'You are back on the chart, at the passage you just read.'
      : 'Back returns to the workbench, and the cursor in the charts is now the passage you just read.',
    actions: [{ id: 'primary', label: revealed ? 'Finish' : 'Go back' }],
  };
}

function finishCopy(phase: GuideStepPhase): GuideCopy {
  const abridged = phase === 'abridged';
  return {
    kicker: abridged
      ? 'Guided tour · stopped before the source'
      : 'Guided tour · complete',
    title: 'Start with a word. End with the text.',
    body: 'Every measurement here points at a position you can open. Matches lists every reference in corpus order; Compare weighs one passage against the rest.',
    ...(abridged
      ? {
          status: {
            tone: 'unavailable' as const,
            text: 'The tour did not open a mark this time. Replay it once the strip has one.',
          },
        }
      : {}),
    actions: FINISH_ACTIONS,
    // Contextual note ids land with their definitions so every link resolves
    // in every independently revertible commit. Invitation completion later
    // excludes this card's abridged phase.
  };
}

/** A stage describes the current card's primary action, never card entry. */
export const GUIDED_TOUR: GuideDefinition = {
  id: 'guided-tour',
  version: GUIDED_TOUR_VERSION,
  title: 'A reading instrument',
  summary: 'Follow one shown term from the chart into its source and back.',
  places: ['inputs', 'trends', 'matches', 'vocabulary', 'compare'],
  requires: guidedTourReadiness,
  steps: [
    {
      id: 'welcome',
      kind: 'welcome',
      cardSide: 'block-start',
      copy: () => ({
        kicker: 'textTrends · guided tour',
        title: 'A reading instrument',
        body: 'textTrends measures your texts so you can find your way back into them. About a minute, on the texts you already have.',
        status: {
          tone: 'neutral',
          text: 'Processed in your browser · never uploaded.',
        },
        actions: [
          { id: 'primary', label: 'Begin' },
          { id: 'exit', label: 'Not now' },
        ],
      }),
      advance: { kind: 'manual' },
    },
    {
      id: 'terms',
      kind: 'scene',
      anchor: 'terms-rail',
      cardSide: 'block-start',
      copy: () => ({
        kicker: 'Guided tour · terms',
        title: 'The terms you track',
        body: 'Terms are a notebook, not a search box. Up to five are shown at once, and those terms travel through Trends, Matches, the reading strip, and Reader.',
        hints: ['Add term opens quick entry; Manage opens the full editor.'],
        actions: PRIMARY_NEXT,
      }),
      stage: () => ({ kind: 'place', place: 'trends' }),
      advance: { kind: 'manual' },
    },
    {
      id: 'axis',
      kind: 'scene',
      anchor: 'trend-plate',
      cardSide: 'block-end',
      copy: axisCopy,
      advance: { kind: 'manual' },
    },
    {
      id: 'mark',
      kind: 'scene',
      anchor: 'dispersion-strip',
      cardSide: 'block-end',
      copy: markCopy,
      stage: (context) => context.target.status === 'ready'
        ? { kind: 'reader-open', intent: context.target.target.intent }
        : null,
      advance: { kind: 'action', event: 'reader-opened' },
    },
    {
      id: 'source',
      kind: 'scene',
      anchor: 'reader-prose',
      cardSide: 'block-end',
      copy: () => ({
        kicker: 'Guided tour · source',
        title: 'The text is the evidence',
        body: 'This is canonical extracted text from your browser-local library, opened at the reference you chose.',
        hints: ['w and b step to the next and previous reference anywhere in the corpus.'],
        actions: PRIMARY_NEXT,
      }),
      advance: { kind: 'manual' },
    },
    {
      id: 'return',
      kind: 'scene',
      anchor: 'chart-cursor',
      cardSide: 'block-end',
      copy: (_context, phase) => returnCopy(phase),
      stage: () => ({ kind: 'reader-close' }),
      advance: { kind: 'action', event: 'reader-closed' },
    },
    {
      id: 'finish',
      kind: 'finish',
      cardSide: 'block-start',
      copy: (_context, phase) => finishCopy(phase),
      advance: { kind: 'manual' },
    },
  ],
};

const REGISTRY: Readonly<Partial<Record<GuideId, GuideDefinition>>> = Object.freeze({
  'guided-tour': GUIDED_TOUR,
});

export function guideDefinition(id: GuideId): GuideDefinition | null {
  return REGISTRY[id] ?? null;
}
