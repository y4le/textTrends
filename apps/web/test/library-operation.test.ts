import { describe, expect, it, vi } from 'vitest';
import { libraryOperation } from '../src/lib/library-operation.ts';

describe('libraryOperation', () => {
  it('serializes acquisitions by lease identity and publishes busy changes', () => {
    const listener = vi.fn();
    const unsubscribe = libraryOperation.subscribe(listener);
    const lease = libraryOperation.claim();
    try {
      expect(lease).not.toBeNull();
      expect(libraryOperation.isBusy()).toBe(true);
      expect(libraryOperation.claim()).toBeNull();

      libraryOperation.release(Symbol('not-the-owner'));
      expect(libraryOperation.isBusy()).toBe(true);
      if (lease === null) throw new Error('the first claim must own the lane');
      expect(libraryOperation.owns(lease)).toBe(true);
      libraryOperation.release(lease);
      expect(libraryOperation.isBusy()).toBe(false);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      if (lease !== null) libraryOperation.release(lease);
      unsubscribe();
    }
  });
});
