export const COMPACT_MAX_PX = 599.98;
export const WIDE_MIN_PX = 1024;

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_PX}px)`;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_PX}px)`;
export const COARSE_POINTER_QUERY = '(pointer: coarse)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export type WidthClass = 'compact' | 'regular' | 'wide';
export type PointerClass = 'coarse' | 'fine';
export type ColorScheme = 'dark' | 'light';

export interface Presentation {
  readonly width: WidthClass;
  readonly pointer: PointerClass;
  readonly reducedMotion: boolean;
  readonly colorScheme: ColorScheme;
}

/** Pure threshold authority shared by tests and non-DOM layout decisions. */
export function widthClassFor(width: number): WidthClass {
  if (!Number.isFinite(width) || width < 0) {
    throw new RangeError('layout width must be a finite non-negative number');
  }
  if (width <= COMPACT_MAX_PX) return 'compact';
  if (width < WIDE_MIN_PX) return 'regular';
  return 'wide';
}
