import { describe, expect, it } from 'vitest';
import { occurrenceStepAnchor, validOccurrenceHit } from '../src/lib/occurrence-step.ts';
import type { AppState } from '../src/lib/app-state.ts';

type State = Parameters<typeof occurrenceStepAnchor>[0];
const state = (patch: Partial<State> = {}): State => ({
  readerPlace: null, readerPage: null, readerVisibleRange: null,
  readerCursorToken: null, scrub: null, corpusTokenCounts: new Map([['a', 10], ['empty', 0], ['b', 20]]),
  ...patch,
});
describe('occurrence stepping geometry', () => {
  it('wraps from proven nonempty corpus edges and refuses unknown extents', () => {
    expect(occurrenceStepAnchor(state(), ['a', 'empty', 'b'], 1)).toEqual({ anchor: { doc: 'b', token: 19 }, synthetic: true });
    expect(occurrenceStepAnchor(state(), ['empty', 'a', 'b'], -1)).toEqual({ anchor: { doc: 'a', token: 0 }, synthetic: true });
    expect(occurrenceStepAnchor(state(), ['unknown', 'a'], 1)).toBeNull();
    expect(occurrenceStepAnchor(state(), ['empty'], 1)).toBeNull();
  });
  it('uses settled Find ahead of scrub and refuses departed documents', () => {
    const s = state({ scrub: { doc: 'a', token: 2 } });
    expect(occurrenceStepAnchor(s, ['a', 'b'], 1, { doc: 'b', token: 3 })?.anchor).toEqual({ doc: 'b', token: 3 });
    expect(occurrenceStepAnchor(s, ['b'], 1)).toBeNull();
  });
  it('uses the live Reader cursor ahead of page alignment or Find', () => {
    const place: NonNullable<AppState['readerPlace']> = { snapshot: 's', doc: 'a', cursor: { kind: 'around', token: 48 }, from: 'footer', anchor: 'position' };
    const s = state({ readerPlace: place, readerCursorToken: 48,
      readerPage: { snapshot: 's', place, state: { status: 'ready', page: { doc: 'a', anchor: { token: 42 }, tokens: { start: 40, end: 60 } } } } as AppState['readerPage'] });
    expect(occurrenceStepAnchor(s, ['a'], 1, { doc: 'a', token: 2 })?.anchor).toEqual({ doc: 'a', token: 48 });
  });
  it('rejects unowned, overflowing or malformed occurrence hits', () => {
    const hit = { doc: 'a', token: 9, spanTokens: 1, members: [0] };
    expect(validOccurrenceHit(hit, ['a'], 10, 1)).toBe(true);
    for (const bad of [{ ...hit, doc: 'gone' }, { ...hit, spanTokens: 2 }, { ...hit, members: [] }, { ...hit, members: [1] }, { ...hit, token: Number.MAX_SAFE_INTEGER }]) {
      expect(validOccurrenceHit(bad, ['a'], 10, 1)).toBe(false);
    }
  });
});
