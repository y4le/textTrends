import type { Place } from './places.ts';

export const SETTINGS_PLACES = Object.freeze([
  'trends',
] as const);

export type SettingsPlace = typeof SETTINGS_PLACES[number];

export function isSettingsPlace(place: Place): place is SettingsPlace {
  return SETTINGS_PLACES.some((candidate) => candidate === place);
}
