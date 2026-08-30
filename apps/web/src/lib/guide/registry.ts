import type {
  GuideCopy,
  GuideDefinition,
  GuideId,
  GuideStep,
  GuideStepPhase,
} from './definition.ts';
import {
  guidedTourReadiness,
  type GuideContext,
} from './context.ts';
import {
  GUIDED_TOUR_SYNOPSIS,
  GUIDE_NOTE_SYNOPSES,
  guideSynopsis,
} from './help-content.ts';
import type { GuideAnchorId } from './anchors.ts';

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
    noteIds: GUIDE_NOTE_SYNOPSES.map((note) => note.id),
    // Invitation completion later excludes this card's abridged phase.
  };
}

interface NoteStepCopy {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly hints?: readonly string[];
  readonly anchor?: GuideAnchorId;
  readonly side?: GuideStep['cardSide'];
}

function noteSteps(
  guideId: GuideId,
  copies: readonly NoteStepCopy[],
): readonly GuideStep[] {
  const synopsis = guideSynopsis(guideId);
  return copies.map((copy, index) => {
    const last = index === copies.length - 1;
    return {
      id: copy.id,
      kind: last ? 'finish' : 'scene',
      ...(copy.anchor === undefined ? {} : { anchor: copy.anchor }),
      cardSide: copy.side ?? 'block-start',
      copy: () => ({
        kicker: `Guide · ${synopsis.title}`,
        title: copy.title,
        body: copy.body,
        ...(copy.hints === undefined ? {} : { hints: copy.hints }),
        actions: [{ id: 'primary', label: last ? 'Done' : 'Next' }],
      }),
      advance: { kind: 'manual' },
    };
  });
}

function noteDefinition(
  id: Exclude<GuideId, 'guided-tour'>,
  copies: readonly NoteStepCopy[],
): GuideDefinition {
  const synopsis = guideSynopsis(id);
  return {
    id,
    version: 1,
    title: synopsis.title,
    summary: synopsis.summary,
    places: synopsis.places,
    requires: () => ({ status: 'ready' }),
    steps: noteSteps(id, copies),
  };
}

export const TERMS_AND_NOTEBOOK = noteDefinition('terms-and-notebook', [
  {
    id: 'notebook',
    anchor: 'terms-rail',
    title: 'A notebook, not a search box',
    body: 'A term you add becomes part of this workspace. It stays in the notebook as you move among Trends, Matches, Vocabulary, and Compare.',
  },
  {
    id: 'shown',
    anchor: 'terms-rail',
    title: 'Shown is not the same as saved',
    body: 'Up to five enabled notebook groups are shown in analysis at once. Hiding a group removes its line and matches, but keeps the group in the notebook for later.',
  },
  {
    id: 'authoring',
    anchor: 'terms-rail',
    title: 'Write the term you mean',
    body: 'Add term is quick entry. Manage is where one group can collect aliases, exact phrases, and a wildcard at one end. The group travels as one analytical term.',
  },
  {
    id: 'find',
    title: 'Find stays temporary',
    body: 'Find looks for an ad hoc word or phrase without adding it to the notebook or displacing the five shown terms. Close Find and the notebook is unchanged.',
  },
]);

export const READING_A_TREND = noteDefinition('reading-a-trend', [
  {
    id: 'layouts',
    anchor: 'trend-plate',
    side: 'block-end',
    title: 'Three views, one reading order',
    body: 'Combined follows the whole corpus in one sequence. Equal gives every text a full-width row. To scale keeps separate rows on one shared token scale, so shorter texts end earlier.',
  },
  {
    id: 'measure',
    anchor: 'trend-plate',
    side: 'block-end',
    title: 'Height answers a chosen question',
    body: 'Count shows raw occurrences. Rate adjusts for the tokens measured, which makes unlike spans more comparable. Smoothing changes the displayed rate curve; it does not create occurrences.',
  },
  {
    id: 'precision',
    anchor: 'dispersion-strip',
    side: 'block-end',
    title: 'A curve and a mark make different promises',
    body: 'The trend curve summarizes positions into bins. An exact strip mark names one reference; a density band only counts several references near that position.',
  },
  {
    id: 'destinations',
    anchor: 'chart-cursor',
    side: 'block-end',
    title: 'The cursor is a shared place',
    body: 'Moving through Trends updates the same corpus position used by the reading strip, Matches, and Reader. The chart is an index into the text, not a destination by itself.',
  },
]);

export const READING_THE_STRIP = noteDefinition('reading-the-strip', [
  {
    id: 'axis',
    anchor: 'reading-footer',
    title: 'One axis crosses every text',
    body: 'The reading strip lays your ready texts end to end in their declared order. Boundaries change the text; the cursor remains one corpus position.',
  },
  {
    id: 'gestures',
    anchor: 'reading-footer',
    title: 'Point, press, or scrub',
    body: 'With a precise pointer, pause over the strip to seek and press-drag to shuttle. With touch, drag directly across it. The keyboard moves by token, page, reference, or corpus edge.',
  },
  {
    id: 'lanes',
    anchor: 'dispersion-strip',
    title: 'Evidence lanes keep their precision',
    body: 'Each shown term gets a lane. A single occurrence can open that reference; a crowded density band can open only an honest position inside the band.',
  },
  {
    id: 'reader',
    anchor: 'reading-footer',
    title: 'Open the source at any position',
    body: 'Focus the reading position and press Enter to open Reader. Activating an exact mark opens that reference; opening a density band or plain position never pretends it chose one.',
  },
]);

export const COMPARE_A_PASSAGE = noteDefinition('compare-a-passage', [
  {
    id: 'choose',
    anchor: 'compare-sides',
    side: 'block-end',
    title: 'Choose a passage or two texts',
    body: 'A passage comparison starts with a range in Trends. A text comparison starts by choosing one text for each side here. These are two different definitions of A and B.',
  },
  {
    id: 'select',
    anchor: 'reading-footer',
    title: 'Selection has pointer and keyboard paths',
    body: 'In Trends, drag across the graph or from one text title to another. From the focused reading position, press S, extend with the arrow keys, and press Enter to commit the range.',
  },
  {
    id: 'sides',
    anchor: 'compare-sides',
    side: 'block-end',
    title: 'A is exact; B is everything else',
    body: 'For a passage comparison, A is exactly the selected token span and B is its corpus complement. Ranked rows and whole-distribution divergence describe that same split in different ways.',
  },
  {
    id: 'matches',
    title: 'The range does not filter Matches',
    body: 'A range never filters Matches: it remains a corpus-order list of references for the shown terms. That separation lets you compare a passage without losing the wider trail back to every source occurrence.',
  },
]);

/** A stage describes the current card's primary action, never card entry. */
export const GUIDED_TOUR: GuideDefinition = {
  id: 'guided-tour',
  version: GUIDED_TOUR_VERSION,
  title: GUIDED_TOUR_SYNOPSIS.title,
  summary: GUIDED_TOUR_SYNOPSIS.summary,
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
  'terms-and-notebook': TERMS_AND_NOTEBOOK,
  'reading-a-trend': READING_A_TREND,
  'reading-the-strip': READING_THE_STRIP,
  'compare-a-passage': COMPARE_A_PASSAGE,
});

export function guideDefinition(id: GuideId): GuideDefinition | null {
  return REGISTRY[id] ?? null;
}
