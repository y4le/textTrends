export const DISPLAY_DENSITIES = Object.freeze([
  'compact',
  'standard',
  'comfortable',
] as const);

export const DISPLAY_THEMES = Object.freeze([
  'system',
  'dark',
  'light',
] as const);

export type Density = typeof DISPLAY_DENSITIES[number];
export type Theme = typeof DISPLAY_THEMES[number];

export interface DisplayPreference {
  readonly density: Density;
  readonly theme: Theme;
}

export const DEFAULT_DISPLAY_PREFERENCE: DisplayPreference = Object.freeze({
  density: 'standard',
  theme: 'system',
});

export function isDensity(value: unknown): value is Density {
  return DISPLAY_DENSITIES.some((density) => density === value);
}

export function isTheme(value: unknown): value is Theme {
  return DISPLAY_THEMES.some((theme) => theme === value);
}
