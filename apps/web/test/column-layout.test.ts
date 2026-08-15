import { describe, expect, it } from 'vitest';
import {
  displayCells,
  fitTextColumn,
  partitionedGridTemplate,
  proportionalPairFromPixels,
} from '../src/lib/column-layout.ts';

describe('shared column layout primitives', () => {
  it('builds elastic and shrinkable fixed tracks without intrinsic floors', () => {
    expect(partitionedGridTemplate([
      { kind: 'elastic', weight: 1 },
      { kind: 'fixed', preferred: '80px' },
      { kind: 'elastic', weight: 2 },
    ])).toBe('minmax(0, 1fr) minmax(0, 80px) minmax(0, 2fr)');
    expect(() => partitionedGridTemplate([])).toThrow(RangeError);
    expect(() => partitionedGridTemplate([{ kind: 'elastic', weight: 0 }]))
      .toThrow(RangeError);
  });

  it('measures graphemes as monospace display cells', () => {
    expect(displayCells('wolf')).toBe(4);
    expect(displayCells('e\u0301')).toBe(1);
    expect(displayCells('界')).toBe(2);
    expect(displayCells('👩‍💻')).toBe(2);
    expect(fitTextColumn(['fox', '界界'], 1, 10)).toBe(4);
  });

  it('normalizes a rendered split into stable integer weights', () => {
    expect(proportionalPairFromPixels(100, 200)).toEqual({ first: 33, second: 67 });
    expect(proportionalPairFromPixels(0, 0)).toEqual({ first: 50, second: 50 });
    expect(proportionalPairFromPixels(1_000, 1)).toEqual({ first: 99, second: 1 });
  });
});
