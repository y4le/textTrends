import { describe, expect, it } from 'vitest';
import {
  advanceShortcutSequence,
  chordShortcutAllowed,
  interactionShortcutAllowed,
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
    expect(shortcutMatches(key('/'), 'find-open')).toBe(true);
    expect(shortcutMatches(key('/', { shiftKey: true }), 'find-open')).toBe(true);
    expect(shortcutMatches(key('f', { ctrlKey: true }), 'find-open')).toBe(true);
    expect(shortcutMatches(key('f', { metaKey: true }), 'find-open')).toBe(true);
    expect(shortcutMatches(key('n'), 'find-next')).toBe(true);
    expect(shortcutMatches(key('g', { ctrlKey: true }), 'find-next')).toBe(true);
    expect(shortcutMatches(key('g', { metaKey: true }), 'find-next')).toBe(true);
    expect(shortcutMatches(key('G', { shiftKey: true, ctrlKey: true }), 'find-previous')).toBe(true);
    expect(shortcutMatches(key('G', { shiftKey: true, metaKey: true }), 'find-previous')).toBe(true);
    expect(shortcutMatches(key('g', { ctrlKey: true }), 'find-previous')).toBe(false);
    expect(shortcutMatches(key('h'), 'footer-page-previous')).toBe(true);
    expect(shortcutMatches(key('ArrowLeft'), 'footer-page-previous')).toBe(true);
    expect(shortcutMatches(key('ArrowLeft', { shiftKey: true }), 'footer-page-previous')).toBe(false);
    expect(shortcutMatches(key('ArrowLeft', { shiftKey: true }), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('H'), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('H', { shiftKey: true }), 'footer-token-previous')).toBe(true);
    expect(shortcutMatches(key('b'), 'reader-occurrence-previous')).toBe(true);
    expect(shortcutMatches(key('W'), 'reader-occurrence-previous')).toBe(false);
    expect(shortcutMatches(key('w'), 'reader-occurrence-next')).toBe(true);
    expect(shortcutMatches(key('S', { shiftKey: true }), 'reader-rsvp-toggle')).toBe(true);
    expect(shortcutMatches(key('S'), 'reader-rsvp-toggle')).toBe(false);
    expect(shortcutMatches(key('s'), 'reader-rsvp-toggle')).toBe(false);
    expect(shortcutMatches(key('W', { shiftKey: true }), 'rsvp-pace-editor')).toBe(true);
    expect(shortcutMatches(key('W'), 'rsvp-pace-editor')).toBe(false);
    expect(shortcutMatches(key('w'), 'rsvp-pace-editor')).toBe(false);
    expect(shortcutMatches(key('h'), 'rsvp-word-previous')).toBe(true);
    expect(shortcutMatches(key('ArrowRight'), 'rsvp-word-next')).toBe(true);
    expect(shortcutMatches(key('j'), 'rsvp-pace-down')).toBe(true);
    expect(shortcutMatches(key('ArrowDown'), 'rsvp-pace-down')).toBe(true);
    expect(shortcutMatches(key('k'), 'rsvp-pace-up')).toBe(true);
    expect(shortcutMatches(key('ArrowUp'), 'rsvp-pace-up')).toBe(true);
    expect(shortcutMatches(key(' '), 'term-toggle')).toBe(true);
    expect(shortcutMatches(key('x'), 'term-delete')).toBe(true);
    expect(shortcutMatches(key('Enter'), 'term-open-menu')).toBe(true);
    expect(shortcutMatches(key('Escape'), 'term-exit')).toBe(true);
  });

  it('captures only named browser chords and never composition', () => {
    expect(shortcutMatches(key('?'), 'show-help')).toBe(true);
    expect(shortcutMatches(key('?', { shiftKey: true }), 'show-help')).toBe(true);
    expect(shortcutMatches(key('D', { shiftKey: true }), 'show-debug')).toBe(true);
    expect(shortcutMatches(key('D'), 'show-debug')).toBe(false);
    expect(shortcutMatches(key('d'), 'show-debug')).toBe(false);
    expect(shortcutMatches(key('D', { shiftKey: true, ctrlKey: true }), 'show-debug')).toBe(false);
    expect(shortcutMatches(key('w', { ctrlKey: true }), 'reader-occurrence-next')).toBe(false);
    expect(shortcutMatches(key('u', { ctrlKey: true }), 'row-half-page-previous')).toBe(true);
    expect(shortcutMatches(key('d', { ctrlKey: true }), 'row-half-page-next')).toBe(true);
    expect(shortcutMatches(key('o', { ctrlKey: true }), 'position-previous')).toBe(true);
    expect(shortcutMatches(key('i', { ctrlKey: true }), 'position-next')).toBe(true);
    expect(shortcutMatches(key('o', { metaKey: true }), 'position-previous')).toBe(false);
    expect(shortcutMatches(key('u'), 'row-half-page-previous')).toBe(false);
    expect(shortcutMatches(key('?', { shiftKey: true, metaKey: true }), 'show-help')).toBe(false);
    expect(shortcutMatches(key('w', { metaKey: true }), 'reader-occurrence-next')).toBe(false);
    expect(shortcutMatches(key('l', { isComposing: true }), 'reader-page-next')).toBe(false);
    expect(shortcutMatches(key('['), 'reader-text-previous')).toBe(true);
    expect(shortcutMatches(key(']'), 'reader-text-next')).toBe(true);
  });

  it('lets focused typing controls and locally handled events win at the root', () => {
    const input = ({
      closest: (selector: string) => selector.includes('input') ? { tagName: 'INPUT' } : null,
    }) as unknown as EventTarget;
    const findInput = ({
      closest: (selector: string) => {
        if (selector.includes('input')) return { tagName: 'INPUT' };
        if (selector === '[data-interaction-surface="find"]') {
          return { dataset: { interactionSurface: 'find' } };
        }
        return null;
      },
    }) as unknown as EventTarget;
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

    const interactionEvent = (
      target: EventTarget,
      overrides: Partial<ShortcutEventLike & { defaultPrevented: boolean }> = {},
    ) => ({
      ...key('f', { ctrlKey: true }),
      target,
      defaultPrevented: false,
      ...overrides,
    });
    expect(interactionShortcutAllowed(interactionEvent(plain))).toBe(true);
    expect(interactionShortcutAllowed(interactionEvent(input))).toBe(true);
    expect(interactionShortcutAllowed(interactionEvent(findInput))).toBe(true);
    expect(interactionShortcutAllowed(interactionEvent(input, {
      key: 'x',
      ctrlKey: true,
    }))).toBe(false);
    expect(interactionShortcutAllowed({
      ...interactionEvent(findInput, { ctrlKey: false }),
      key: '/',
    })).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(dialog))).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(menu))).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(plain, { defaultPrevented: true }))).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(plain, {
      ctrlKey: false,
      metaKey: true,
    }))).toBe(true);
    expect(interactionShortcutAllowed(interactionEvent(plain, {
      key: 'x',
      ctrlKey: false,
      metaKey: true,
    }))).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(plain, { altKey: true }))).toBe(false);
    expect(interactionShortcutAllowed(interactionEvent(plain, { isComposing: true }))).toBe(false);

    const chordEvent = (
      target: EventTarget,
      overrides: Partial<ShortcutEventLike & { defaultPrevented: boolean }> = {},
    ) => ({
      ...key('o', { ctrlKey: true }),
      target,
      defaultPrevented: false,
      ...overrides,
    });
    expect(chordShortcutAllowed(chordEvent(plain))).toBe(true);
    expect(chordShortcutAllowed(chordEvent(input))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(dialog))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(menu))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(plain, { metaKey: true }))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(plain, { altKey: true }))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(plain, { isComposing: true }))).toBe(false);
    expect(chordShortcutAllowed(chordEvent(plain, { defaultPrevented: true }))).toBe(false);
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
      trendView: 'by-book',
    });
    expect(trends.map((section) => section.title)).toEqual([
      'Global',
      'Find',
      'Reading position history',
      'Navigation',
      'Terms',
      'Trends',
      'Trend rows',
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
      entry.id === 'footer-selection-start')).toEqual({
        id: 'footer-selection-start',
        label: 'Start a range at the footer cursor',
        keys: ['s', 'S'],
      });
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'show-help')?.keys).toEqual(['?']);
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'show-debug')?.keys).toEqual(['Shift + D']);
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'trend-title-select')).toEqual({
        id: 'trend-title-select',
        label: 'Select the whole focused text',
        keys: ['Enter', 'Space'],
      });
    expect(shortcutAria([
      'trend-title-previous',
      'trend-title-next',
      'trend-title-first',
      'trend-title-last',
      'trend-title-select',
      'trend-title-extend',
    ])).toBe(
      'ArrowLeft ArrowUp ArrowRight ArrowDown Home End Enter Space Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown',
    );
    expect(shortcutAria([
      'trend-rows-step',
      'trend-rows-fine',
      'trend-rows-page',
      'trend-rows-limits',
      'trend-rows-reset',
    ])).toBe('ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown PageUp PageDown Home End Enter');
    expect(trends.find((section) => section.title === 'Trend rows')?.entries
      .map((entry) => entry.id)).toEqual([
        'trend-rows-step',
        'trend-rows-fine',
        'trend-rows-page',
        'trend-rows-limits',
        'trend-rows-reset',
      ]);
    const combined = shortcutHelpSections({
      context: 'workbench',
      place: 'trends',
      activeTextCount: 2,
      footerAvailable: true,
      trendView: 'series',
    });
    expect(combined.map((section) => section.title)).not.toContain('Trend rows');
    expect(trends.flatMap((section) => section.entries).find((entry) =>
      entry.id === 'find-previous')?.keys).toEqual([
        'p',
        'Ctrl + Shift + G',
        'Cmd + Shift + G',
      ]);
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
      entry.id === 'trend-toggle-view')?.label).toBe('Cycle combined / equal / to scale views');
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
      trendView: 'series',
    });
    expect(inputs.map((section) => section.title)).toEqual([
      'Global',
      'Find',
      'Reading position history',
      'Navigation',
      'Terms',
      'Rows',
      'Reading footer',
      'Footer size',
    ]);
    const inputIds = inputs.flatMap((section) => section.entries.map((entry) => entry.id));
    expect(inputIds).not.toContain('go-inputs');
    expect(inputIds).toContain('go-compare');
    expect(inputIds).not.toContain('trend-step-next');

    const empty = shortcutHelpSections({
      context: 'workbench',
      place: 'inputs',
      activeTextCount: 0,
      footerAvailable: false,
      trendView: 'series',
    });
    expect(empty.map((section) => section.title)).toEqual([
      'Global',
      'Find',
      'Reading position history',
      'Navigation',
      'Terms',
    ]);
    expect(empty.flatMap((section) => section.entries.map((entry) => entry.id)))
      .not.toContain('go-footer');

    const readerIds = shortcutHelpSections({ context: 'reader', scale: 'read' })
      .flatMap((section) => section.entries.map((entry) => entry.id));
    expect(readerIds).toContain('reader-page-next');
    expect(readerIds).toContain('reader-text-previous');
    expect(readerIds).toContain('reader-text-next');
    expect(readerIds).toContain('position-previous');
    expect(readerIds).toContain('position-next');
    expect(readerIds).toContain('find-open');
    expect(readerIds).toContain('reader-rsvp-toggle');
    expect(readerIds).not.toContain('footer-page-next');
    expect(readerIds).not.toContain('reader-atlas-descend');

    const atlasIds = shortcutHelpSections({ context: 'reader', scale: 'atlas' })
      .flatMap((section) => section.entries.map((entry) => entry.id));
    expect(atlasIds).toContain('reader-atlas-text-previous');
    expect(atlasIds).toContain('reader-atlas-position-next');
    expect(atlasIds).toContain('reader-atlas-page-next');
    expect(atlasIds).toContain('reader-atlas-descend');
    expect(atlasIds).toContain('reader-occurrence-next');
    expect(atlasIds).toContain('reader-text-next');
    expect(atlasIds).not.toContain('reader-page-next');
    expect(atlasIds).not.toContain('reader-rsvp-toggle');

    const rsvp = shortcutHelpSections({ context: 'rsvp' });
    expect(rsvp.map((section) => section.title)).toEqual(['Global', 'Speed reader']);
    const rsvpIds = rsvp.flatMap((section) => section.entries.map((entry) => entry.id));
    expect(rsvpIds).toEqual([
      'show-help',
      'show-debug',
      'reader-rsvp-toggle',
      'rsvp-exit',
      'rsvp-toggle-play',
      'rsvp-word-previous',
      'rsvp-word-next',
      'rsvp-pace-editor',
      'rsvp-pace-down',
      'rsvp-pace-up',
    ]);
    expect(rsvpIds).not.toContain('find-open');
    expect(rsvpIds).not.toContain('reader-page-next');
    expect(shortcutAria(['reader-rsvp-toggle', 'rsvp-exit']))
      .toBe('Shift+S Escape');
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
    expect(advanceShortcutSequence(null, key('g'), 'rsvp', 100))
      .toEqual({ kind: 'none' });
  });
});
