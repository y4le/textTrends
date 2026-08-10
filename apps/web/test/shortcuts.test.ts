import { describe, expect, it } from 'vitest';
import {
  advanceShortcutSequence,
  rootShortcutAllowed,
  shortcutAria,
  shortcutHelpSections,
  shortcutMatches,
  type ShortcutEventLike,
} from '../src/lib/shortcuts.ts';

const key = (
  value: string,
  overrides: Partial<ShortcutEventLike> = {},
): ShortcutEventLike => ({
  key: value,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...overrides,
});

describe('shortcut registry', () => {
  it('matches Vim and conventional aliases while preserving modifiers', () => {
    expect(shortcutMatches(key('h'), 'footer-page-previous')).toBe(true);
    expect(shortcutMatches(key('ArrowLeft'), 'footer-page-previous')).toBe(true);
    expect(shortcutMatches(key('ArrowLeft', { shiftKey: true }), 'footer-page-previous')).toBe(false);
    expect(shortcutMatches(key('ArrowLeft', { shiftKey: true }), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('H'), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('H', { shiftKey: true }), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('W'), 'reader-occurrence-previous')).toBe(true);
    expect(shortcutMatches(key('W', { shiftKey: true }), 'reader-occurrence-previous')).toBe(true);
    expect(shortcutMatches(key('w'), 'reader-occurrence-next')).toBe(true);
  });

  it('never captures browser chords or composition', () => {
    expect(shortcutMatches(key('?'), 'show-help')).toBe(true);
    expect(shortcutMatches(key('?', { shiftKey: true }), 'show-help')).toBe(true);
    expect(shortcutMatches(key('w', { ctrlKey: true }), 'reader-occurrence-next')).toBe(false);
    expect(shortcutMatches(key('?', { shiftKey: true, metaKey: true }), 'show-help')).toBe(false);
    expect(shortcutMatches(key('l', { isComposing: true }), 'reader-page-next')).toBe(false);
  });

  it('lets focused typing controls and locally handled events win at the root', () => {
    const input = { closest: () => ({ tagName: 'INPUT' }) } as unknown as EventTarget;
    const plain = { closest: () => null } as unknown as EventTarget;
    const dialog = ({
      closest: (selector: string) => selector === '[role="dialog"]' ? {} : null,
    }) as unknown as EventTarget;
    const event = (target: EventTarget, defaultPrevented = false) => ({
      ...key('?', { shiftKey: true }),
      target,
      defaultPrevented,
    });
    expect(rootShortcutAllowed(event(plain))).toBe(true);
    expect(rootShortcutAllowed(event(input))).toBe(false);
    expect(rootShortcutAllowed(event(dialog))).toBe(false);
    expect(rootShortcutAllowed(event(plain, true))).toBe(false);
  });

  it('derives accessibility metadata and contextual help from the same definitions', () => {
    expect(shortcutAria(['footer-page-previous', 'footer-token-previous']))
      .toBe('h ArrowLeft PageUp Shift+H Shift+ArrowLeft');
    const workbench = shortcutHelpSections('workbench');
    expect(workbench.map((section) => section.title)).toEqual([
      'General',
      'Navigation',
      'Focus',
      'Rows',
      'Trends',
      'Reading footer',
    ]);
    expect(workbench.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'footer-page-next')).toEqual({
        id: 'footer-page-next',
        label: 'Next rendered passage',
        keys: ['l', '→', 'Page Down'],
      });
    expect(workbench.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'show-help')?.keys).toEqual(['?']);
    const readerIds = shortcutHelpSections('reader')
      .flatMap((section) => section.entries.map((entry) => entry.id));
    expect(readerIds).toContain('reader-line-down');
    expect(readerIds).not.toContain('footer-page-next');
  });

  it('advances bounded two-key sequences without entering a persistent mode', () => {
    const prefix = advanceShortcutSequence(null, key('g'), 'workbench', 100);
    expect(prefix).toEqual({
      kind: 'pending',
      state: { prefix: 'g', expiresAt: 1_000 },
    });
    if (prefix.kind !== 'pending') throw new Error('expected a pending sequence');
    expect(advanceShortcutSequence(prefix.state, key('c'), 'workbench', 200))
      .toEqual({ kind: 'matched', id: 'go-catalog' });
    expect(advanceShortcutSequence(prefix.state, key('c'), 'workbench', 1_001))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(prefix.state, key('x'), 'workbench', 200))
      .toEqual({ kind: 'none' });
    const restarted = advanceShortcutSequence(prefix.state, key('['), 'workbench', 200);
    expect(restarted).toEqual({
      kind: 'pending',
      state: { prefix: '[', expiresAt: 1_100 },
    });
    if (restarted.kind !== 'pending') throw new Error('expected a restarted sequence');
    expect(advanceShortcutSequence(restarted.state, key('t'), 'workbench', 300))
      .toEqual({ kind: 'matched', id: 'focus-term-previous' });
    expect(advanceShortcutSequence(null, key('g', { ctrlKey: true }), 'workbench', 100))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(null, key('g'), 'reader', 100))
      .toEqual({ kind: 'none' });
    expect(shortcutHelpSections('workbench').flatMap((section) => section.entries)
      .find((entry) => entry.id === 'focus-term-next')?.keys).toEqual([']t']);
  });
});
