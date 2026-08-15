/** Canonical workbench destinations shared by the tab bar, routing, and
 * method surfaces. Inputs is composition; the remaining places analyze it. */
export const PLACES = [
  'inputs',
  'trends',
  'matches',
  'vocabulary',
  'compare',
] as const;

export type Place = (typeof PLACES)[number];

export const DEFAULT_PLACE: Place = 'trends';

export const PLACE_HEADING: Readonly<Record<Place, string>> = Object.freeze({
  inputs: 'Inputs',
  trends: 'Trends',
  matches: 'Matches',
  vocabulary: 'Vocabulary',
  compare: 'Compare',
});
