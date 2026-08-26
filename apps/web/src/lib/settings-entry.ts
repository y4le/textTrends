import type { Place } from './places.ts';

export type SettingsSection = 'display' | 'this-place';
export type SettingsContext = Place | 'reader';

export interface SettingsEntry {
  readonly section: SettingsSection;
  readonly context: SettingsContext;
}

export function globalSettingsEntry(context: SettingsContext): SettingsEntry {
  return { section: 'display', context };
}

export function contextualSettingsEntry(context: SettingsContext): SettingsEntry {
  return { section: 'this-place', context };
}
