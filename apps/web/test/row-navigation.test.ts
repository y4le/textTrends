import { describe, expect, it } from 'vitest';
import {
  rowNavigationShortcut,
  rowNavigationTarget,
  visibleRowPageSize,
} from '../src/lib/row-navigation.ts';

const event = (key: string) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
});

describe('row navigation', () => {
  it('recognizes Vim and conventional row movement without modifiers', () => {
    expect(rowNavigationShortcut(event('j'))).toBe('row-next');
    expect(rowNavigationShortcut(event('ArrowDown'))).toBe('row-next');
    expect(rowNavigationShortcut(event('k'))).toBe('row-previous');
    expect(rowNavigationShortcut({ ...event('u'), ctrlKey: true }))
      .toBe('row-half-page-previous');
    expect(rowNavigationShortcut({ ...event('d'), ctrlKey: true }))
      .toBe('row-half-page-next');
    expect(rowNavigationShortcut(event('Escape'))).toBe('row-exit');
    expect(rowNavigationShortcut({ ...event('j'), ctrlKey: true })).toBeNull();
  });

  it('clamps one-row, visible-page, and boundary moves', () => {
    expect(rowNavigationTarget(20, 10, 'row-previous', 7)).toBe(9);
    expect(rowNavigationTarget(20, 10, 'row-next', 7)).toBe(11);
    expect(rowNavigationTarget(20, 10, 'row-page-previous', 7)).toBe(3);
    expect(rowNavigationTarget(20, 10, 'row-page-next', 7)).toBe(17);
    expect(rowNavigationTarget(20, 10, 'row-half-page-previous', 8)).toBe(6);
    expect(rowNavigationTarget(20, 10, 'row-half-page-next', 8)).toBe(14);
    expect(rowNavigationTarget(20, 10, 'row-first', 7)).toBe(0);
    expect(rowNavigationTarget(20, 10, 'row-last', 7)).toBe(19);
    expect(rowNavigationTarget(3, 0, 'row-previous', 7)).toBe(0);
    expect(rowNavigationTarget(3, 2, 'row-page-next', 7)).toBe(2);
    expect(rowNavigationTarget(0, 0, 'row-next', 7)).toBe(-1);
  });

  it('derives a page from the smaller visible container or viewport', () => {
    expect(visibleRowPageSize(600, 800, 30)).toBe(20);
    expect(visibleRowPageSize(1_200, 800, 30)).toBe(26);
    expect(visibleRowPageSize(0, 800, 30)).toBe(26);
    expect(visibleRowPageSize(600, 800, 0)).toBe(1);
  });
});
