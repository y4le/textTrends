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

export interface DensityMetrics {
  readonly cssVars: Readonly<Record<
    | '--text-xs'
    | '--text-sm'
    | '--text-md'
    | '--text-lg'
    | '--density-chrome-target-block-size'
    | '--density-data-header-block-size'
    | '--density-kwic-header-block-size'
    | '--density-compact-data-header-block-size',
    string
  >>;
  readonly matchesRowHeight: number;
  readonly frequencyRowHeight: number;
  readonly frequencyCompactRowHeight: number;
  readonly dock: {
    readonly railBlockSize: number;
    readonly compactRailBlockSize: number;
    readonly termTargetBlockSize: number;
    readonly compactTermTargetBlockSize: number;
    readonly readerTermTargetBlockSize: number;
  };
}

/** UI density scales authored type, chrome, and data-row pitch only. It never
 * scales structural spacing, plots, barcode geometry, strokes, series
 * encodings, tolerance thresholds, Reader prose, or RSVP type. Compact is
 * the exact pre-preference geometry; Standard deliberately becomes default. */
export const DENSITY_METRICS: Readonly<Record<Density, DensityMetrics>> = Object.freeze({
  compact: Object.freeze({
    cssVars: Object.freeze({
      '--text-xs': '0.6875rem',
      '--text-sm': '0.8125rem',
      '--text-md': '0.9375rem',
      '--text-lg': '1.25rem',
      '--density-chrome-target-block-size': '44px',
      '--density-data-header-block-size': '36px',
      '--density-kwic-header-block-size': '32px',
      '--density-compact-data-header-block-size': '44px',
    }),
    matchesRowHeight: 32,
    frequencyRowHeight: 34,
    frequencyCompactRowHeight: 44,
    dock: Object.freeze({
      railBlockSize: 48,
      compactRailBlockSize: 50,
      termTargetBlockSize: 34,
      compactTermTargetBlockSize: 36,
      readerTermTargetBlockSize: 24,
    }),
  }),
  standard: Object.freeze({
    cssVars: Object.freeze({
      '--text-xs': '0.75rem',
      '--text-sm': '0.875rem',
      '--text-md': '1rem',
      '--text-lg': '1.3125rem',
      '--density-chrome-target-block-size': '46px',
      '--density-data-header-block-size': '40px',
      '--density-kwic-header-block-size': '36px',
      '--density-compact-data-header-block-size': '46px',
    }),
    matchesRowHeight: 36,
    frequencyRowHeight: 38,
    frequencyCompactRowHeight: 48,
    dock: Object.freeze({
      railBlockSize: 52,
      compactRailBlockSize: 54,
      termTargetBlockSize: 38,
      compactTermTargetBlockSize: 40,
      readerTermTargetBlockSize: 28,
    }),
  }),
  comfortable: Object.freeze({
    cssVars: Object.freeze({
      '--text-xs': '0.8125rem',
      '--text-sm': '0.9375rem',
      '--text-md': '1.0625rem',
      '--text-lg': '1.375rem',
      '--density-chrome-target-block-size': '48px',
      '--density-data-header-block-size': '44px',
      '--density-kwic-header-block-size': '40px',
      '--density-compact-data-header-block-size': '48px',
    }),
    matchesRowHeight: 40,
    frequencyRowHeight: 42,
    frequencyCompactRowHeight: 52,
    dock: Object.freeze({
      railBlockSize: 56,
      compactRailBlockSize: 58,
      termTargetBlockSize: 42,
      compactTermTargetBlockSize: 44,
      readerTermTargetBlockSize: 32,
    }),
  }),
});

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
