/** Canonical workbench destinations. Routing lands later; this module is the
 * pure vocabulary shared by Scope, Method, and the future shell. */
export const PLACES = [
  'corpus',
  'trends',
  'concordance',
  'vocabulary',
  'compare',
] as const;

export type Place = (typeof PLACES)[number];

export const LENS_PLACES = [
  'trends',
  'concordance',
  'vocabulary',
  'compare',
] as const satisfies readonly Place[];

export const DEFAULT_PLACE: Place = 'trends';

export const PLACE_HEADING: Readonly<Record<Place, string>> = Object.freeze({
  corpus: 'Corpus',
  trends: 'Trends',
  concordance: 'Concordance',
  vocabulary: 'Vocabulary',
  compare: 'Compare',
});
