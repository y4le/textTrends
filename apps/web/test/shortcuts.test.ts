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
    expect(shortcutMatches(key('b'), 'reader-occurrence-previous')).toBe(true);
    expect(shortcutMatches(key('W'), 'reader-occurrence-previous')).toBe(false);
    expect(shortcutMatches(key('w'), 'reader-occurrence-next')).toBe(true);
    expect(shortcutMatches(key(' '), 'term-toggle')).toBe(true);
    expect(shortcutMatches(key('x'), 'term-delete')).toBe(true);
    expect(shortcutMatches(key('Enter'), 'term-open-menu')).toBe(true);
    expect(shortcutMatches(key('Escape'), 'term-exit')).toBe(true);
  });

  it('never captures browser chords or composition', () => {
    expect(shortcutMatches(key('?'), 'show-help')).toBe(true);
    expect(shortcutMatches(key('?', { shiftKey: true }), 'show-help')).toBe(true);
    expect(shortcutMatches(key('w', { ctrlKey: true }), 'reader-occurrence-next')).toBe(false);
    expect(shortcutMatches(key('u', { ctrlKey: true }), 'row-half-page-previous')).toBe(true);
    expect(shortcutMatches(key('d', { ctrlKey: true }), 'row-half-page-next')).toBe(true);
    expect(shortcutMatches(key('u'), 'row-half-page-previous')).toBe(false);
    expect(shortcutMatches(key('?', { shiftKey: true, metaKey: true }), 'show-help')).toBe(false);
    expect(shortcutMatches(key('l', { isComposing: true }), 'reader-page-next')).toBe(false);
  });

  it('lets focused typing controls and locally handled events win at the root', () => {
    const input = { closest: () => ({ tagName: 'INPUT' }) } as unknown as EventTarget;
    const plain = { closest: () => null } as unknown as EventTarget;
    const dialog = ({
      closest: (selector: string) => selector.includes('[role="dialog"]') ? {} : null,
    }) as unknown as EventTarget;
    const menu = ({
      closest: (selector: string) => selector.includes('[role="menu"]') ? {} : null,
    }) as unknown as EventTarget;
    const event = (target: EventTarget, defaultPrevented = false) => ({
      ...key('?', { shiftKey: true }),
      target,
      defaultPrevented,
    });
    expect(rootShortcutAllowed(event(plain))).toBe(true);
    expect(rootShortcutAllowed(event(input))).toBe(false);
    expect(rootShortcutAllowed(event(dialog))).toBe(false);
    expect(rootShortcutAllowed(event(menu))).toBe(false);
    expect(rootShortcutAllowed(event(plain, true))).toBe(false);
  });

  it('derives accessibility metadata and contextual help from the same definitions', () => {
    expect(shortcutAria(['footer-page-previous', 'footer-token-previous']))
      .toBe('h ArrowLeft PageUp Shift+H Shift+ArrowLeft');
    expect(shortcutAria([
      'term-previous',
      'term-next',
      'term-toggle',
      'term-delete',
      'term-add-inline',
      'term-open-menu',
      'term-exit',
    ])).toBe('h ArrowLeft l ArrowRight Space x Backspace Delete a Enter Escape');
    const trends = shortcutHelpSections({
      context: 'workbench',
      place: 'trends',
      activeTextCount: 2,
      footerAvailable: true,
    });
    expect(trends.map((section) => section.title)).toEqual([
      'Global',
      'Navigation',
      'Terms',
      'Trends',
      'Reading footer',
      'Footer size',
    ]);
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'footer-page-next')).toEqual({
        id: 'footer-page-next',
        label: 'Next rendered passage',
        keys: ['l', '→', 'Page Down'],
      });
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'show-help')?.keys).toEqual(['?']);
    expect(trends.find((section) => section.title === 'Navigation')?.entries
      .map((entry) => entry.id)).toContain('go-inputs');
    expect(trends.find((section) => section.title === 'Navigation')?.entries
      .map((entry) => entry.id)).not.toContain('go-trends');
    expect(trends.find((section) => section.title === 'Terms')?.entries
      .map((entry) => entry.id)).toContain('go-terms');
    expect(trends.find((section) => section.title === 'Terms')?.entries
      .map((entry) => entry.id)).toEqual([
        'go-terms',
        'term-previous',
        'term-next',
        'term-toggle',
        'term-delete',
        'term-add-inline',
        'term-open-menu',
        'term-exit',
      ]);
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'trend-toggle-view')?.label).toBe('Toggle combined / separate view');
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'footer-occurrence-previous')).toEqual({
        id: 'footer-occurrence-previous',
        label: 'Previous reference from any term',
        keys: ['b'],
      });
    const inputs = shortcutHelpSections({
      context: 'workbench',
      place: 'inputs',
      activeTextCount: 1,
      footerAvailable: true,
    });
    expect(inputs.map((section) => section.title)).toEqual([
      'Global',
      'Navigation',
      'Terms',
      'Rows',
      'Reading footer',
      'Footer size',
    ]);
    const inputIds = inputs.flatMap((section) => section.entries.map((entry) => entry.id));
    expect(inputIds).not.toContain('go-inputs');
    expect(inputIds).not.toContain('go-compare');
    expect(inputIds).not.toContain('trend-step-next');

    const empty = shortcutHelpSections({
      context: 'workbench',
      place: 'inputs',
      activeTextCount: 0,
      footerAvailable: false,
    });
    expect(empty.map((section) => section.title)).toEqual([
      'Global',
      'Navigation',
      'Terms',
    ]);
    expect(empty.flatMap((section) => section.entries.map((entry) => entry.id)))
      .not.toContain('go-footer');

    const readerIds = shortcutHelpSections({ context: 'reader' })
      .flatMap((section) => section.entries.map((entry) => entry.id));
    expect(readerIds).toContain('reader-page-next');
    expect(readerIds).not.toContain('footer-page-next');
  });

  it('advances bounded two-key sequences without entering a persistent mode', () => {
    const prefix = advanceShortcutSequence(null, key('g'), 'workbench', 100);
    expect(prefix).toEqual({
      kind: 'pending',
      state: { prefix: 'g', expiresAt: 1_000 },
    });
    if (prefix.kind !== 'pending') throw new Error('expected a pending sequence');
    expect(advanceShortcutSequence(prefix.state, key('i'), 'workbench', 200))
      .toEqual({ kind: 'matched', id: 'go-inputs' });
    expect(advanceShortcutSequence(prefix.state, key('m'), 'workbench', 200))
      .toEqual({ kind: 'matched', id: 'go-matches' });
    expect(advanceShortcutSequence(prefix.state, key('c'), 'workbench', 200))
      .toEqual({ kind: 'matched', id: 'go-compare' });
    expect(advanceShortcutSequence(prefix.state, key('d'), 'workbench', 200))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(prefix.state, key('k'), 'workbench', 200))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(prefix.state, key('i'), 'workbench', 1_001))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(prefix.state, key('x'), 'workbench', 200))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(prefix.state, key('['), 'workbench', 200))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(null, key('g', { ctrlKey: true }), 'workbench', 100))
      .toEqual({ kind: 'none' });
    expect(advanceShortcutSequence(null, key('g'), 'reader', 100))
      .toEqual({ kind: 'none' });
  });
});
