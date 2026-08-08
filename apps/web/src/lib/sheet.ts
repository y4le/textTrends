import type { Layer, SheetDetent } from './layers.ts';

export const SHEET_SURFACES = ['method'] as const;
export type SheetSurface = (typeof SHEET_SURFACES)[number];

export interface SheetTarget {
  readonly surface: SheetSurface;
}

const surfaceSet = new Set<string>(SHEET_SURFACES);
const detentSet = new Set<string>(['peek', 'half', 'tall']);

export function sheetTarget(value: unknown): SheetTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.surface === 'string' && surfaceSet.has(candidate.surface)
    ? { surface: candidate.surface as SheetSurface }
    : null;
}

export function sheetSurface(layer: Layer | undefined): SheetSurface | null {
  if (layer?.kind !== 'sheet') return null;
  return sheetTarget(layer.target)?.surface ?? null;
}

export function sheetDetent(layer: Layer | undefined): SheetDetent {
  const value = layer?.kind === 'sheet' ? layer.ui?.detent : undefined;
  return typeof value === 'string' && detentSet.has(value)
    ? value as SheetDetent
    : 'peek';
}
