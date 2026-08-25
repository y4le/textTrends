import type { Layer } from './layers.ts';

export type RowDetailSurface =
  | 'query-editor'
  | 'book-sheet'
  | 'vocab-row'
  | 'compare-row';

export type RowDetailWrite = 'push' | 'replace';

/** Return only governed row-detail discriminants; foreign targets stay opaque. */
export function rowDetailSurface(value: unknown): RowDetailSurface | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const surface = (value as Record<string, unknown>).surface;
  switch (surface) {
    case 'query-editor':
    case 'book-sheet':
    case 'vocab-row':
    case 'compare-row':
      return surface;
    default:
      return null;
  }
}

/** Render only the active governed row detail. */
export function renderedRowDetailLayer(
  layers: readonly Layer[],
): Layer | undefined {
  const top = layers.at(-1);
  return top?.kind === 'row-detail' ? top : undefined;
}

/** Lateral details replace the active history depth. */
export function rowDetailWrite(
  topSurface: RowDetailSurface | null,
  nextSurface: RowDetailSurface,
): RowDetailWrite {
  if (topSurface === null) return 'push';
  return 'replace';
}
