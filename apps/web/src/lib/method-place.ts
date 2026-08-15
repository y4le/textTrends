import type { Place } from './places.ts';

export const METHOD_PLACES = Object.freeze([
  'trends',
  'vocabulary',
  'compare',
] as const);

export type MethodPlace = typeof METHOD_PLACES[number];

export function isMethodPlace(place: Place): place is MethodPlace {
  return METHOD_PLACES.some((candidate) => candidate === place);
}
