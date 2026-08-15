import { describe, expect, it } from 'vitest';
import { isMethodPlace, METHOD_PLACES } from '../src/lib/method-place.ts';
import { PLACES } from '../src/lib/places.ts';

describe('Method utility places', () => {
  it('allowlists only Trends, Vocabulary, and Compare', () => {
    expect(METHOD_PLACES).toEqual(['trends', 'vocabulary', 'compare']);
    expect(PLACES.filter(isMethodPlace)).toEqual(METHOD_PLACES);
    expect(isMethodPlace('inputs')).toBe(false);
    expect(isMethodPlace('matches')).toBe(false);
  });
});
