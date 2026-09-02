import { PLACE_HEADING, type Place } from '../places.ts';
import type { ShortcutHelpContext } from '../shortcuts.ts';
import type { GuideId } from './definition.ts';

export interface HelpCopy {
  readonly summary: string;
  readonly hint: string;
  readonly method: string;
}

export interface GuideSynopsis {
  readonly id: GuideId;
  readonly title: string;
  readonly summary: string;
  readonly duration: string;
  readonly places: readonly Place[];
}

const WORKBENCH_HELP: Readonly<Record<Place, HelpCopy>> = Object.freeze({
  inputs: {
    summary: 'Build the corpus you want to study and set its reading order.',
    hint: 'Import a text, try a prepared sample, or open a text row to inspect and rescope it.',
    method: 'The active order governs corpus reading. Reordering or removing a text recomputes analyses without changing saved source files.',
  },
  trends: {
    summary: 'See where tracked terms occur, keep company, and lead into close reading.',
    hint: 'Select a text title to use that whole text, or drag from one title to another to include every text between them. Move through the graph to read exact positions; start and commit a range to compare that passage with the rest of the corpus. Double-click the graph to clear that range. On touch screens, double-tap the graph to clear that range.',
    method: 'Trend bins summarize indexed token positions. Trend settings govern binning, measure, and smoothing in this same workspace.',
  },
  matches: {
    summary: 'Read term occurrences as one continuous, corpus-order sequence.',
    hint: 'Move by row for nearby context, or open a match to read its authenticated source page.',
    method: 'Rows are occurrence-ranked while context is fetched from the indexed source. Sparse source gaps are compressed rather than presented as prose distance.',
  },
  vocabulary: {
    summary: 'See which words characterize the active scope.',
    hint: 'Filter the table live, inspect document spread, and select a term when you want to track it elsewhere.',
    method: 'Counts and dispersion use the active scope. Common-word and text filters remove rows without changing the surviving statistics.',
  },
  compare: {
    summary: 'Contrast a selected passage with what lies outside it, or compare two texts.',
    hint: 'Select a range in Trends, or choose two text sides here; then refine ranking, filters, and interval whiskers in Compare settings.',
    method: 'Whole-distribution divergence is separate from the ranked term rows. Range comparison uses the exact selected tokens as A and their corpus complement as B.',
  },
});

const READER_HELP: HelpCopy = Object.freeze({
  summary: 'Read exact source text at the shared corpus position.',
  hint: 'Use the page controls or page edges to move, jump between tracked references, or enter the speed reader.',
  method: 'Reader presents authenticated plain text from the active corpus. Page fitting preserves the current start position when the viewport or display settings change.',
});

const RSVP_HELP: HelpCopy = Object.freeze({
  summary: 'Advance through the Reader source at a controlled pace.',
  hint: 'Use Space to play or pause, adjust pace with the visible controls, and return to Reader whenever you want the full page.',
  method: 'The speed reader uses the same authenticated, bounded source as Reader. Punctuation and paragraph rests affect timing without inventing text structure.',
});

export function helpCopy(context: ShortcutHelpContext, place: Place): HelpCopy {
  if (context === 'reader') return READER_HELP;
  if (context === 'rsvp') return RSVP_HELP;
  return WORKBENCH_HELP[place];
}

export function helpViewName(context: ShortcutHelpContext, place: Place): string {
  if (context === 'reader') return 'Reader';
  if (context === 'rsvp') return 'Speed reader';
  return PLACE_HEADING[place];
}

export const GUIDED_TOUR_SYNOPSIS = Object.freeze<GuideSynopsis>({
  id: 'guided-tour',
  title: 'A reading instrument',
  summary: 'Follow one shown term from the chart into its source and back.',
  duration: 'about a minute',
  places: ['inputs', 'trends', 'matches', 'vocabulary', 'compare'],
});

export const GUIDE_NOTE_SYNOPSES: readonly GuideSynopsis[] = Object.freeze([
  {
    id: 'terms-and-notebook',
    title: 'Terms and the notebook',
    summary: 'Distinguish durable terms, the five shown terms, and temporary Find.',
    duration: 'about a minute',
    places: ['trends', 'matches', 'vocabulary', 'compare'],
  },
  {
    id: 'reading-a-trend',
    title: 'Reading a trend',
    summary: 'Read layouts, measures, smoothing, and evidence at the right precision.',
    duration: 'about 2 minutes',
    places: ['trends'],
  },
  {
    id: 'reading-the-strip',
    title: 'The reading strip',
    summary: 'Navigate the shared corpus axis and open its source evidence.',
    duration: 'about 2 minutes',
    places: ['trends'],
  },
  {
    id: 'compare-a-passage',
    title: 'Compare a passage',
    summary: 'Select a passage and understand exactly what A and B measure.',
    duration: 'about a minute',
    places: ['compare'],
  },
]);

const GUIDE_SYNOPSES: ReadonlyMap<GuideId, GuideSynopsis> = new Map([
  [GUIDED_TOUR_SYNOPSIS.id, GUIDED_TOUR_SYNOPSIS],
  ...GUIDE_NOTE_SYNOPSES.map((synopsis) => [synopsis.id, synopsis] as const),
]);

export function guideSynopsis(id: GuideId): GuideSynopsis {
  const synopsis = GUIDE_SYNOPSES.get(id);
  if (synopsis === undefined) throw new Error(`Missing guide synopsis: ${id}`);
  return synopsis;
}
