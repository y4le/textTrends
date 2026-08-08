import { describe, expect, it } from 'vitest';
import { sheetDetent, sheetSurface, sheetTarget } from '../src/lib/sheet.ts';
import type { Layer } from '../src/lib/layers.ts';

const layer = (target: unknown, detent?: 'peek' | 'half' | 'tall'): Layer => ({
  kind: 'sheet',
  id: '00000000-0000-4000-8000-000000000001',
  target,
  returnFocusTo: 'return',
  ...(detent ? { ui: { detent } } : {}),
});

describe('sheet presentation target', () => {
  it('admits only the Method surface', () => {
    expect(sheetTarget({ surface: 'method' })).toEqual({ surface: 'method' });
    expect(sheetTarget({ surface: 'evidence' })).toBeNull();
    expect(sheetTarget({ surface: 'queries' })).toBeNull();
    expect(sheetTarget(null)).toBeNull();
  });

  it('rejects legacy route targets and defaults a missing detent to peek', () => {
    expect(sheetSurface(layer({ source: 'route', evidence: 'sheet' }))).toBeNull();
    expect(sheetDetent(layer({ surface: 'method' }))).toBe('peek');
    expect(sheetSurface(undefined)).toBeNull();
  });

  it('preserves explicit surface and detent', () => {
    const current = layer({ surface: 'method' }, 'tall');
    expect(sheetSurface(current)).toBe('method');
    expect(sheetDetent(current)).toBe('tall');
  });
});
