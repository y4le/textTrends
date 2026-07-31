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
  it('admits only the two governed surfaces', () => {
    expect(sheetTarget({ surface: 'evidence' })).toEqual({ surface: 'evidence' });
    expect(sheetTarget({ surface: 'method' })).toEqual({ surface: 'method' });
    expect(sheetTarget({ surface: 'queries' })).toBeNull();
    expect(sheetTarget(null)).toBeNull();
  });

  it('normalizes a bare route sheet to Evidence and a missing detent to peek', () => {
    expect(sheetSurface(layer({ source: 'route', evidence: 'sheet' }))).toBe('evidence');
    expect(sheetDetent(layer({ source: 'route', evidence: 'sheet' }))).toBe('peek');
    expect(sheetSurface(undefined)).toBeNull();
  });

  it('preserves explicit surface and detent', () => {
    const current = layer({ surface: 'method' }, 'tall');
    expect(sheetSurface(current)).toBe('method');
    expect(sheetDetent(current)).toBe('tall');
  });
});
