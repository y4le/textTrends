import type { Layer } from './layers.ts';

export type RowDetailSurface =
  | 'query-editor'
  | 'book-sheet'
  | 'vocab-filter'
  | 'vocab-row'
  | 'compare-settings'
  | 'compare-row';

export type RowDetailWrite = 'push' | 'replace';

/** Return only governed row-detail discriminants; foreign targets stay opaque. */
export function rowDetailSurface(value: unknown): RowDetailSurface | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const surface = (value as Record<string, unknown>).surface;
  switch (surface) {
    case 'query-editor':
    case 'book-sheet':
    case 'vocab-filter':
    case 'vocab-row':
    case 'compare-settings':
    case 'compare-row':
      return surface;
    default:
      return null;
  }
}

/** A governed sheet may sit above an additive detail. Render the last
 * row-detail in the stack while permitting writes only through the actual
 * top layer. */
export function renderedRowDetailLayer(
  layers: readonly Layer[],
): Layer | undefined {
  return layers.findLast((layer) => layer.kind === 'row-detail');
}

/** Lateral details replace the active history depth. */
export function rowDetailWrite(
  topSurface: RowDetailSurface | null,
  nextSurface: RowDetailSurface,
): RowDetailWrite {
  if (topSurface === null) return 'push';
  return 'replace';
}
