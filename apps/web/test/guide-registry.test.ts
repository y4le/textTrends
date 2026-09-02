import { TREND_RATE_DENOMINATOR } from '@texttrends/core';
import { describe, expect, it } from 'vitest';
import type { ObservedOccurrenceActivation } from '../src/lib/guide/activation.ts';
import { GUIDE_ANCHOR_IDS } from '../src/lib/guide/anchors.ts';
import type { GuideContext } from '../src/lib/guide/context.ts';
import { guidedTourReadiness } from '../src/lib/guide/context.ts';
import type {
  GuideCopy,
  GuideStep,
  GuideStepPhase,
} from '../src/lib/guide/definition.ts';
import { GUIDE_IDS } from '../src/lib/guide/definition.ts';
import {
  GUIDE_NOTE_SYNOPSES,
  guideSynopsis,
} from '../src/lib/guide/help-content.ts';
import {
  COMPARE_A_PASSAGE,
  GUIDED_TOUR,
  GUIDED_TOUR_VERSION,
  READING_A_TREND,
  READING_THE_STRIP,
  TERMS_AND_NOTEBOOK,
  guideDefinition,
} from '../src/lib/guide/registry.ts';
import { GUIDE_STAGE_KINDS } from '../src/lib/guide/stage.ts';
import type {
  GuideTargetResolution,
} from '../src/lib/guide/target.ts';

const PRIVATE_LABEL = 'Private reader term';

const EXACT: GuideTargetResolution = {
  status: 'ready',
  target: {
    kind: 'exact',
    seriesId: 'series-private',
    label: PRIVATE_LABEL,
    doc: 'private-doc',
    token: 42,
    intent: {
      snapshot: 'snapshot-1',
      doc: 'private-doc',
      token: 42,
      from: 'barcode',
      anchor: 'occurrence',
    },
  },
};

const DENSITY: GuideTargetResolution = {
  status: 'ready',
  target: {
    kind: 'density',
    seriesId: 'series-private',
    label: PRIVATE_LABEL,
    doc: 'private-doc',
    token: 51,
    bucketCount: 12,
    intent: {
      snapshot: 'snapshot-1',
      doc: 'private-doc',
      token: 51,
      from: 'barcode',
      anchor: 'position',
    },
  },
};

const TARGETS: readonly GuideTargetResolution[] = [
  EXACT,
  DENSITY,
  { status: 'pending', reason: 'dispersion' },
  { status: 'pending', reason: 'superseded' },
  { status: 'pending', reason: 'extents' },
  { status: 'unavailable', reason: 'no-corpus' },
  { status: 'unavailable', reason: 'no-shown-term' },
  { status: 'unavailable', reason: 'no-occurrences' },
  { status: 'unavailable', reason: 'failed' },
];

const ACTIVATIONS: readonly ObservedOccurrenceActivation[] = [
  'available', 'minimized', 'coarse', 'unknown',
];

function context({
  target = EXACT,
  measure = 'rate',
  activation = 'available',
  readyTexts = 1,
  shown = true,
  readerOpen = false,
  rsvpActive = false,
}: {
  readonly target?: GuideTargetResolution;
  readonly measure?: GuideContext['measure'];
  readonly activation?: ObservedOccurrenceActivation;
  readonly readyTexts?: number;
  readonly shown?: boolean;
  readonly readerOpen?: boolean;
  readonly rsvpActive?: boolean;
} = {}): GuideContext {
  return {
    place: 'trends',
    readerOpen,
    rsvpActive,
    snapshotId: readyTexts > 0 ? 'snapshot-1' : null,
    readyDocs: readyTexts > 0 ? ['private-doc'] : [],
    readyTexts,
    shownTerms: shown
      ? [{ seriesId: 'series-private', label: PRIVATE_LABEL }]
      : [],
    measure,
    rateDenominator: TREND_RATE_DENOMINATOR,
    occurrenceActivation: activation,
    target,
  };
}

function guideStep(id: string): GuideStep {
  const found = GUIDED_TOUR.steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing guide step ${id}`);
  return found;
}

function copy(
  id: string,
  ctx = context(),
  phase: GuideStepPhase = 'presenting',
): GuideCopy {
  return guideStep(id).copy(ctx, phase);
}

describe('guided tour registry structure', () => {
  it('declares the seven authority cards in order', () => {
    expect(GUIDED_TOUR).toMatchObject({
      id: 'guided-tour',
      version: GUIDED_TOUR_VERSION,
      title: 'A reading instrument',
    });
    expect(GUIDED_TOUR.steps.map((candidate) => candidate.id)).toEqual([
      'welcome', 'terms', 'axis', 'mark', 'source', 'return', 'finish',
    ]);
    expect(GUIDED_TOUR.steps.map((candidate) => candidate.kind)).toEqual([
      'welcome', 'scene', 'scene', 'scene', 'scene', 'scene', 'finish',
    ]);
    expect(guideDefinition('guided-tour')).toBe(GUIDED_TOUR);
    expect(guideDefinition('reading-a-trend')).toBe(READING_A_TREND);
  });

  it('places stages on primary actions only and stays inside closed authority', () => {
    expect(guideStep('welcome').stage).toBeUndefined();
    expect(guideStep('terms').stage?.(context())).toEqual({
      kind: 'place', place: 'trends',
    });
    expect(guideStep('axis').stage).toBeUndefined();
    expect(guideStep('source').stage).toBeUndefined();
    expect(guideStep('finish').stage).toBeUndefined();
    expect(guideStep('return').stage?.(context())).toEqual({ kind: 'reader-close' });

    for (const target of TARGETS) {
      for (const candidate of GUIDED_TOUR.steps) {
        const stage = candidate.stage?.(context({ target }));
        if (stage !== undefined && stage !== null) {
          expect(GUIDE_STAGE_KINDS).toContain(stage.kind);
        }
      }
    }
  });

  it('uses only declared semantic anchors and resolvable note links', () => {
    for (const candidate of GUIDED_TOUR.steps) {
      if (candidate.anchor !== undefined) {
        expect(GUIDE_ANCHOR_IDS).toContain(candidate.anchor);
      }
      for (const noteId of candidate.copy(context(), 'presenting').noteIds ?? []) {
        expect(guideDefinition(noteId)).not.toBeNull();
      }
    }
  });
});

describe('guides for this view', () => {
  const notes = [
    TERMS_AND_NOTEBOOK,
    READING_A_TREND,
    READING_THE_STRIP,
    COMPARE_A_PASSAGE,
  ] as const;

  it('resolves every declared id through one synopsis and one definition', () => {
    expect(GUIDE_IDS).toEqual([
      'guided-tour',
      'terms-and-notebook',
      'reading-a-trend',
      'reading-the-strip',
      'compare-a-passage',
    ]);
    expect(GUIDE_NOTE_SYNOPSES.map((synopsis) => synopsis.id))
      .toEqual(GUIDE_IDS.slice(1));
    for (const id of GUIDE_IDS) {
      const definition = guideDefinition(id);
      expect(definition).not.toBeNull();
      expect(definition).toMatchObject({
        id,
        title: guideSynopsis(id).title,
        summary: guideSynopsis(id).summary,
        places: guideSynopsis(id).places,
      });
    }
  });

  it('keeps every note pull-only, manual, short, and independently readable', () => {
    for (const note of notes) {
      expect(note.steps.length).toBeGreaterThanOrEqual(2);
      expect(note.steps.length).toBeLessThanOrEqual(4);
      expect(note.requires(context({ readyTexts: 0, shown: false })))
        .toEqual({ status: 'ready' });
      note.steps.forEach((step, index) => {
        expect(step.advance).toEqual({ kind: 'manual' });
        expect(step.stage).toBeUndefined();
        if (step.anchor !== undefined) expect(GUIDE_ANCHOR_IDS).toContain(step.anchor);
        const authored = step.copy(context(), 'presenting');
        expect(() => JSON.stringify(authored)).not.toThrow();
        expect(authored.actions).toEqual([{
          id: 'primary',
          label: index === note.steps.length - 1 ? 'Done' : 'Next',
        }]);
        expect(JSON.stringify(authored)).not.toContain(PRIVATE_LABEL);
      });
    }
  });

  it('covers the four promised concepts without implying an exercise', () => {
    const bodies = (definition: (typeof notes)[number]) => definition.steps
      .map((step) => step.copy(context(), 'presenting').body)
      .join(' ');
    expect(bodies(TERMS_AND_NOTEBOOK)).toMatch(/notebook.*five shown terms|five shown terms.*notebook/i);
    expect(bodies(READING_A_TREND)).toMatch(/Combined.*Equal.*To scale/s);
    expect(bodies(READING_A_TREND)).toMatch(/exact.*density/s);
    expect(bodies(READING_THE_STRIP)).toMatch(/press-drag.*touch/s);
    expect(bodies(READING_THE_STRIP))
      .toMatch(/keyboard moves by token, page, reference, or corpus edge/i);
    expect(bodies(READING_THE_STRIP)).not.toMatch(/reference, text/i);
    expect(bodies(COMPARE_A_PASSAGE)).toMatch(/corpus complement/s);
    expect(bodies(COMPARE_A_PASSAGE)).toMatch(/never filters Matches/s);
  });
});

describe('guided tour authority copy', () => {
  it('authors the welcome, Terms, Source, and normal Finish promises verbatim', () => {
    expect(copy('welcome')).toEqual({
      kicker: 'textTrends · guided tour',
      title: 'A reading instrument',
      body: 'textTrends measures your texts so you can find your way back into them. About a minute, on the texts you already have.',
      status: { tone: 'neutral', text: 'Processed in your browser · never uploaded.' },
      actions: [
        { id: 'primary', label: 'Begin' },
        { id: 'exit', label: 'Not now' },
      ],
    });
    expect(copy('terms')).toMatchObject({
      title: 'The terms you track',
      body: 'Terms are a notebook, not a search box. Up to five are shown at once, and those terms travel through Trends, Matches, the reading strip, and Reader.',
      hints: ['Add term opens quick entry; Manage opens the full editor.'],
    });
    expect(copy('source')).toMatchObject({
      title: 'The text is the evidence',
      body: 'This is canonical extracted text from your browser-local library, opened at the reference you chose.',
      actions: [{ id: 'primary', label: 'Next' }],
    });
    expect(copy('finish')).toMatchObject({
      kicker: 'Guided tour · complete',
      title: 'Start with a word. End with the text.',
      actions: [
        { id: 'exit', label: 'Stay here' },
        { id: 'restore-origin', label: 'Back to where I was' },
        { id: 'replay', label: 'Replay' },
      ],
    });
  });

  it('derives the ordered-axis measurement from live context', () => {
    expect(copy('axis', context({ measure: 'rate' })).hints).toEqual([
      `Height is a rate per ${TREND_RATE_DENOMINATOR.toLocaleString('en-US')} tokens.`,
    ]);
    expect(copy('axis', context({ measure: 'count' })).hints)
      .toEqual(['Height is a raw count.']);
  });

  it('pairs exact and density copy with the matching Reader evidence claim', () => {
    const exactCopy = copy('mark', context({ target: EXACT }));
    const exactStage = guideStep('mark').stage?.(context({ target: EXACT }));
    expect(exactCopy).toMatchObject({
      title: 'Every mark is a position',
      actions: [{ id: 'primary', label: 'Open this reference' }],
    });
    expect(exactStage).toMatchObject({
      kind: 'reader-open', intent: { anchor: 'occurrence', from: 'barcode' },
    });

    const densityCopy = copy('mark', context({ target: DENSITY }));
    const densityStage = guideStep('mark').stage?.(context({ target: DENSITY }));
    expect(densityCopy).toEqual({
      kicker: 'Guided tour · reading strip',
      title: 'These marks are counts',
      body: 'Above a threshold the strip shows density bands rather than single occurrences. A band tells you how many, never which one.',
      actions: [{ id: 'primary', label: 'Open this position' }],
    });
    expect(densityStage).toMatchObject({
      kind: 'reader-open', intent: { anchor: 'position', from: 'barcode' },
    });
  });

  it('makes exact native-activation claims only when the semantic fact supports them', () => {
    expect(copy('mark', context({ activation: 'available' })).hints)
      .toEqual(['You can also activate any mark directly.']);
    expect(copy('mark', context({ activation: 'coarse' })).hints)
      .toEqual(['On touch these marks are read-only; this card opens the one it found.']);
    expect(copy('mark', context({ activation: 'minimized' })).hints)
      .toEqual(['These marks are minimized at this row height. This card opens the one it found.']);
    expect(copy('mark', context({ activation: 'unknown' })).hints).toBeUndefined();
    expect(copy('mark', context({ target: DENSITY, activation: 'available' })).hints)
      .toBeUndefined();
  });

  it('keeps pending actions disabled, reasoned, and representation-neutral', () => {
    const expectedStatus = {
      dispersion: 'Measuring the strip for your shown terms…',
      superseded: 'Your corpus changed. Measuring the strip again…',
      extents: 'Locating the text this mark falls in…',
    } as const;
    for (const [reason, text] of Object.entries(expectedStatus)) {
      const mark = copy('mark', context({
        target: { status: 'pending', reason: reason as keyof typeof expectedStatus },
      }));
      expect(mark).toMatchObject({
        status: { tone: 'pending', text },
        actions: [
          { id: 'primary', label: 'Open a mark', disabled: true },
          { id: 'exit', label: 'Exit the tour' },
        ],
      });
      expect(guideStep('mark').stage?.(context({
        target: { status: 'pending', reason: reason as keyof typeof expectedStatus },
      }))).toBeNull();
    }
  });

  it('offers an honest abridged route for every unavailable target', () => {
    for (const reason of ['no-corpus', 'no-shown-term', 'no-occurrences', 'failed'] as const) {
      const mark = copy('mark', context({ target: { status: 'unavailable', reason } }));
      expect(mark.status?.tone).toBe('unavailable');
      expect(mark.actions).toEqual([
        { id: 'abridge', label: 'Continue without a mark' },
        { id: 'exit', label: 'Exit the tour' },
      ]);
      expect(mark.body).not.toContain('Open one and you are in the text');
      expect(guideStep('mark').stage?.(context({
        target: { status: 'unavailable', reason },
      }))).toBeNull();
    }
  });

  it('makes Source and Return independent of later target churn', () => {
    for (const phase of ['presenting', 'awaiting-action', 'revealed'] as const) {
      const source = copy('source', context({ target: TARGETS[0]! }), phase);
      const returned = copy('return', context({ target: TARGETS[0]! }), phase);
      for (const target of TARGETS.slice(1)) {
        expect(copy('source', context({ target }), phase)).toEqual(source);
        expect(copy('return', context({ target }), phase)).toEqual(returned);
      }
    }
    expect(copy('return', context(), 'revealed')).toMatchObject({
      body: 'You are back on the chart, at the passage you just read.',
      actions: [{ id: 'primary', label: 'Finish' }],
    });
  });

  it('labels an abridged Finish without changing its product truth or choices', () => {
    const normal = copy('finish', context(), 'presenting');
    const abridged = copy('finish', context({ target: EXACT }), 'abridged');
    expect(abridged).toMatchObject({
      kicker: 'Guided tour · stopped before the source',
      status: {
        tone: 'unavailable',
        text: 'The tour did not open a mark this time. Replay it once the strip has one.',
      },
    });
    expect(abridged.title).toBe(normal.title);
    expect(abridged.body).toBe(normal.body);
    expect(abridged.actions).toBe(normal.actions);
  });

  it('keeps every copy branch serializable and free of reader-authored strings', () => {
    for (const target of TARGETS) {
      for (const measure of ['rate', 'count'] as const) {
        for (const activation of ACTIVATIONS) {
          for (const candidate of GUIDED_TOUR.steps) {
            for (const phase of ['presenting', 'awaiting-action', 'revealed', 'abridged'] as const) {
              const authored = candidate.copy(context({ target, measure, activation }), phase);
              expect(JSON.parse(JSON.stringify(authored))).toEqual(authored);
              expect(JSON.stringify(authored)).not.toContain(PRIVATE_LABEL);
              expect(JSON.stringify(authored)).not.toContain('private-doc');
            }
          }
        }
      }
    }
  });
});

describe('guided tour launch readiness', () => {
  it('allows ready and still-settling resident targets', () => {
    expect(guidedTourReadiness(context({ target: EXACT }))).toEqual({ status: 'ready' });
    expect(guidedTourReadiness(context({
      target: { status: 'pending', reason: 'superseded' },
    }))).toEqual({ status: 'ready' });
  });

  it('prioritizes Speed reader, Reader, text, and term prerequisites', () => {
    expect(guidedTourReadiness(context({ rsvpActive: true, readerOpen: true })))
      .toEqual({ status: 'disabled', reason: 'Exit Speed reader to start.' });
    expect(guidedTourReadiness(context({ readerOpen: true })))
      .toEqual({ status: 'disabled', reason: 'Return to Trends to start the guided tour.' });
    expect(guidedTourReadiness(context({ readyTexts: 0 }))).toMatchObject({
      status: 'disabled', remedy: { id: 'add-text', label: 'Add a text' },
    });
    expect(guidedTourReadiness(context({ shown: false }))).toMatchObject({
      status: 'disabled', remedy: { id: 'track-term', label: 'Track a term' },
    });
  });

  it('disables targets that cannot produce a live example', () => {
    expect(guidedTourReadiness(context({
      target: { status: 'unavailable', reason: 'no-occurrences' },
    }))).toEqual({
      status: 'disabled', reason: 'Show a term that occurs in a ready text.',
    });
    expect(guidedTourReadiness(context({
      target: { status: 'unavailable', reason: 'failed' },
    }))).toEqual({
      status: 'disabled', reason: 'Retry the reading strip from the chart before starting.',
    });
  });
});
