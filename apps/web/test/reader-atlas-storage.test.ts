import { describe, expect, it } from 'vitest';
import {
  loadAtlasNormalization,
  READER_ATLAS_STORAGE_KEY,
  saveAtlasNormalization,
} from '../src/lib/reader-atlas-storage.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    removeItem: () => { value = null; },
    value: () => value,
  };
}

describe('Reader Atlas local storage', () => {
  it('round-trips one strict device-local normalization record', () => {
    const storage = memoryStorage();
    saveAtlasNormalization(storage, 'to-scale');
    expect(loadAtlasNormalization(storage)).toBe('to-scale');
    expect(JSON.parse(storage.value()!)).toEqual({ normalization: 'to-scale' });
    expect(READER_ATLAS_STORAGE_KEY).toBe('texttrends/reader-atlas/1');
  });

  it('rejects malformed, extended, and unknown records', () => {
    const read = (value: unknown) => loadAtlasNormalization(memoryStorage(
      typeof value === 'string' ? value : JSON.stringify(value),
    ));
    expect(read('{broken')).toBeNull();
    expect(read({ normalization: 'equal', extra: true })).toBeNull();
    expect(read({ normalization: 'combined' })).toBeNull();
  });

  it('keeps unavailable storage non-fatal', () => {
    const unavailable = {
      getItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      setItem: () => { throw new DOMException('disabled', 'SecurityError'); },
      removeItem: () => { throw new DOMException('disabled', 'SecurityError'); },
    };
    expect(loadAtlasNormalization(unavailable)).toBeNull();
    expect(() => saveAtlasNormalization(unavailable, 'equal')).not.toThrow();
  });
});
