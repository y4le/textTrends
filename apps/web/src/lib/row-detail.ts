export type RowDetailSurface =
  | 'query-editor'
  | 'book-sheet'
  | 'structure-editor'
  | 'vocab-filter'
  | 'vocab-row';

export type RowDetailWrite = 'push' | 'replace';

/** Return only governed row-detail discriminants; foreign targets stay opaque. */
export function rowDetailSurface(value: unknown): RowDetailSurface | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const surface = (value as Record<string, unknown>).surface;
  switch (surface) {
    case 'query-editor':
    case 'book-sheet':
    case 'structure-editor':
    case 'vocab-filter':
    case 'vocab-row':
      return surface;
    default:
      return null;
  }
}

/**
 * Lateral details replace the active history depth. The sole meaningful nest
 * is a structure editor opened from its book detail, so Back returns to that
 * book before returning to the inventory.
 */
export function rowDetailWrite(
  topSurface: RowDetailSurface | null,
  nextSurface: RowDetailSurface,
): RowDetailWrite {
  if (topSurface === null) return 'push';
  if (topSurface === 'book-sheet' && nextSurface === 'structure-editor') return 'push';
  return 'replace';
}
