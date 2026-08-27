import { FIND_SURFACE_SELECTOR } from './interaction.ts';
import type { Place } from './places.ts';

export type ShortcutHelpContext = 'workbench' | 'reader' | 'rsvp';

export type ShortcutId =
  | 'show-help'
  | 'show-debug'
  | 'find-open'
  | 'find-next'
  | 'find-previous'
  | 'find-close'
  | 'focus-horizontal-previous'
  | 'focus-horizontal-next'
  | 'go-inputs'
  | 'go-trends'
  | 'go-matches'
  | 'go-vocabulary'
  | 'go-compare'
  | 'go-footer'
  | 'go-terms'
  | 'term-previous'
  | 'term-next'
  | 'term-toggle'
  | 'term-delete'
  | 'term-add-inline'
  | 'term-open-menu'
  | 'term-exit'
  | 'row-previous'
  | 'row-next'
  | 'row-page-previous'
  | 'row-page-next'
  | 'row-half-page-previous'
  | 'row-half-page-next'
  | 'row-first'
  | 'row-last'
  | 'row-open'
  | 'row-exit'
  | 'trend-step-previous'
  | 'trend-step-next'
  | 'trend-step-five-previous'
  | 'trend-step-five-next'
  | 'trend-bin-previous'
  | 'trend-bin-next'
  | 'trend-book-start'
  | 'trend-book-end'
  | 'trend-selection-start'
  | 'trend-selection-commit'
  | 'trend-selection-cancel'
  | 'trend-toggle-view'
  | 'footer-page-previous'
  | 'footer-page-next'
  | 'footer-token-previous'
  | 'footer-token-next'
  | 'footer-occurrence-previous'
  | 'footer-occurrence-next'
  | 'footer-corpus-start'
  | 'footer-corpus-end'
  | 'footer-open-reader'
  | 'dock-resize-step'
  | 'dock-resize-fine'
  | 'dock-resize-page'
  | 'dock-resize-limits'
  | 'dock-resize-reset'
  | 'reader-page-previous'
  | 'reader-page-next'
  | 'reader-occurrence-previous'
  | 'reader-occurrence-next'
  | 'reader-book-start'
  | 'reader-book-end'
  | 'reader-close'
  | 'reader-rsvp-toggle'
  | 'rsvp-exit'
  | 'rsvp-toggle-play'
  | 'rsvp-pace-editor'
  | 'rsvp-pace-down'
  | 'rsvp-pace-up';

interface ShortcutStroke {
  readonly key: string;
  readonly shift?: true;
  /** Require the physical Shift modifier even when `key` is already an
   * uppercase resolved character. Used when the modifier is part of the
   * shortcut contract rather than merely how the character is typed. */
  readonly explicitShift?: true;
  readonly ctrl?: true;
  readonly meta?: true;
}

interface ShortcutDefinition {
  readonly id: ShortcutId;
  readonly group: 'Global' | 'Find' | 'Navigation' | 'Terms' | 'Rows' | 'Trends' | 'Reading footer' | 'Footer size' | 'Reader' | 'Speed reader';
  readonly helpContexts: readonly ShortcutHelpContext[];
  readonly label: string;
  readonly strokes: readonly ShortcutStroke[];
  readonly sequence?: readonly [ShortcutStroke, ShortcutStroke];
}

export interface ShortcutEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

export interface ShortcutHelpEntry {
  readonly id: ShortcutId;
  readonly label: string;
  readonly keys: readonly string[];
}

export interface ShortcutHelpSection {
  readonly title: string;
  readonly entries: readonly ShortcutHelpEntry[];
}

export type ShortcutHelpScope =
  | { readonly context: 'reader' }
  | { readonly context: 'rsvp' }
  | {
      readonly context: 'workbench';
      readonly place: Place;
      readonly activeTextCount: number;
      readonly footerAvailable: boolean;
    };

export const SHORTCUT_SEQUENCE_TIMEOUT_MS = 900;

export interface ShortcutSequenceState {
  readonly prefix: string;
  readonly expiresAt: number;
}

export type ShortcutSequenceAdvance =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly state: ShortcutSequenceState }
  | { readonly kind: 'matched'; readonly id: ShortcutId };

const SHORTCUTS: readonly ShortcutDefinition[] = Object.freeze([
  {
    id: 'show-help',
    group: 'Global',
    helpContexts: ['workbench', 'reader', 'rsvp'],
    label: 'Toggle keyboard shortcuts',
    strokes: [{ key: '?', shift: true }],
  },
  {
    id: 'show-debug',
    group: 'Global',
    helpContexts: ['workbench', 'reader', 'rsvp'],
    label: 'Open debug menu',
    strokes: [{ key: 'D', shift: true, explicitShift: true }],
  },
  {
    id: 'find-open',
    group: 'Find',
    helpContexts: ['workbench', 'reader'],
    label: 'Find a term or aliases in the corpus',
    strokes: [{ key: '/' }, { key: 'f', ctrl: true }, { key: 'f', meta: true }],
  },
  {
    id: 'find-next',
    group: 'Find',
    helpContexts: ['workbench', 'reader'],
    label: 'Next find match',
    strokes: [{ key: 'n' }, { key: 'g', ctrl: true }, { key: 'g', meta: true }],
  },
  {
    id: 'find-previous',
    group: 'Find',
    helpContexts: ['workbench', 'reader'],
    label: 'Previous find match',
    strokes: [
      { key: 'p' },
      { key: 'G', shift: true, ctrl: true },
      { key: 'G', shift: true, meta: true },
    ],
  },
  {
    id: 'find-close',
    group: 'Find',
    helpContexts: ['workbench', 'reader'],
    label: 'Close find',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'focus-horizontal-previous',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Previous workbench section',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }],
  },
  {
    id: 'focus-horizontal-next',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Next workbench section',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }],
  },
  {
    id: 'go-inputs',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Inputs',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'i' }],
  },
  {
    id: 'go-trends',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Trends',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 't' }],
  },
  {
    id: 'go-matches',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Matches',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'm' }],
  },
  {
    id: 'go-vocabulary',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Vocabulary',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'v' }],
  },
  {
    id: 'go-compare',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Compare',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'c' }],
  },
  {
    id: 'go-footer',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Focus the reading footer',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'f' }],
  },
  {
    id: 'go-terms',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Focus Terms',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'q' }],
  },
  {
    id: 'term-previous',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Previous term',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }],
  },
  {
    id: 'term-next',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Next term',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }],
  },
  {
    id: 'term-toggle',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Toggle focused term',
    strokes: [{ key: ' ' }],
  },
  {
    id: 'term-delete',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Delete focused term',
    strokes: [{ key: 'x' }, { key: 'Backspace' }, { key: 'Delete' }],
  },
  {
    id: 'term-add-inline',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Add a term inline',
    strokes: [{ key: 'a' }],
  },
  {
    id: 'term-open-menu',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Open focused term actions',
    strokes: [{ key: 'Enter' }],
  },
  {
    id: 'term-exit',
    group: 'Terms',
    helpContexts: ['workbench'],
    label: 'Leave term navigation',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'row-previous',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Previous result row',
    strokes: [{ key: 'k' }, { key: 'ArrowUp' }],
  },
  {
    id: 'row-next',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Next result row',
    strokes: [{ key: 'j' }, { key: 'ArrowDown' }],
  },
  {
    id: 'row-page-previous',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Previous visible page of rows',
    strokes: [{ key: 'PageUp' }],
  },
  {
    id: 'row-page-next',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Next visible page of rows',
    strokes: [{ key: 'PageDown' }],
  },
  {
    id: 'row-half-page-previous',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Previous half page of rows',
    strokes: [{ key: 'u', ctrl: true }],
  },
  {
    id: 'row-half-page-next',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Next half page of rows',
    strokes: [{ key: 'd', ctrl: true }],
  },
  {
    id: 'row-first',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'First result row',
    strokes: [{ key: 'Home' }],
  },
  {
    id: 'row-last',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Last result row',
    strokes: [{ key: 'End' }],
  },
  {
    id: 'row-open',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Open or toggle the focused row',
    strokes: [{ key: 'Enter' }],
  },
  {
    id: 'row-exit',
    group: 'Rows',
    helpContexts: ['workbench'],
    label: 'Close detail or leave row navigation',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'trend-step-previous',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Previous trend position',
    strokes: [{ key: 'ArrowLeft' }],
  },
  {
    id: 'trend-step-next',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Next trend position',
    strokes: [{ key: 'ArrowRight' }],
  },
  {
    id: 'trend-step-five-previous',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Five positions back; one while selecting a range',
    strokes: [{ key: 'ArrowLeft', shift: true }],
  },
  {
    id: 'trend-step-five-next',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Five positions forward; one while selecting a range',
    strokes: [{ key: 'ArrowRight', shift: true }],
  },
  {
    id: 'trend-bin-previous',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Previous trend bin',
    strokes: [{ key: 'PageUp' }],
  },
  {
    id: 'trend-bin-next',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Next trend bin',
    strokes: [{ key: 'PageDown' }],
  },
  {
    id: 'trend-book-start',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Start of current book',
    strokes: [{ key: 'Home' }],
  },
  {
    id: 'trend-book-end',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'End of current book',
    strokes: [{ key: 'End' }],
  },
  {
    id: 'trend-selection-start',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Start a range at the cursor',
    strokes: [{ key: 's' }, { key: 'S', shift: true }],
  },
  {
    id: 'trend-selection-commit',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Commit the keyboard range',
    strokes: [{ key: 'Enter' }],
  },
  {
    id: 'trend-selection-cancel',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Cancel the keyboard range',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'trend-toggle-view',
    group: 'Trends',
    helpContexts: ['workbench'],
    label: 'Cycle combined / equal / to scale views',
    strokes: [{ key: 'v' }],
  },
  {
    id: 'footer-page-previous',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Previous rendered passage',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }, { key: 'PageUp' }],
  },
  {
    id: 'footer-page-next',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Next rendered passage',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }, { key: 'PageDown' }],
  },
  {
    id: 'footer-token-previous',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Previous token',
    strokes: [{ key: 'H', shift: true }, { key: 'ArrowLeft', shift: true }],
  },
  {
    id: 'footer-token-next',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Next token',
    strokes: [{ key: 'L', shift: true }, { key: 'ArrowRight', shift: true }],
  },
  {
    id: 'footer-occurrence-previous',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Previous reference from any term',
    strokes: [{ key: 'b' }],
  },
  {
    id: 'footer-occurrence-next',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Next reference from any term',
    strokes: [{ key: 'w' }],
  },
  {
    id: 'footer-corpus-start',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Start of corpus',
    strokes: [{ key: 'Home' }],
  },
  {
    id: 'footer-corpus-end',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'End of corpus',
    strokes: [{ key: 'End' }],
  },
  {
    id: 'footer-open-reader',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Open Reader at this token',
    strokes: [{ key: 'Enter' }, { key: 'o' }],
  },
  {
    id: 'dock-resize-step',
    group: 'Footer size',
    helpContexts: ['workbench'],
    label: 'Resize the footer',
    strokes: [{ key: 'ArrowUp' }, { key: 'ArrowDown' }],
  },
  {
    id: 'dock-resize-fine',
    group: 'Footer size',
    helpContexts: ['workbench'],
    label: 'Resize by one pixel',
    strokes: [{ key: 'ArrowUp', shift: true }, { key: 'ArrowDown', shift: true }],
  },
  {
    id: 'dock-resize-page',
    group: 'Footer size',
    helpContexts: ['workbench'],
    label: 'Resize by a large step',
    strokes: [{ key: 'PageUp' }, { key: 'PageDown' }],
  },
  {
    id: 'dock-resize-limits',
    group: 'Footer size',
    helpContexts: ['workbench'],
    label: 'Minimum or maximum size',
    strokes: [{ key: 'Home' }, { key: 'End' }],
  },
  {
    id: 'dock-resize-reset',
    group: 'Footer size',
    helpContexts: ['workbench'],
    label: 'Restore the default size',
    strokes: [{ key: 'Enter' }],
  },
  {
    id: 'reader-page-previous',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Previous page',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }, { key: 'PageUp' }],
  },
  {
    id: 'reader-page-next',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Next page',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }, { key: 'PageDown' }],
  },
  {
    id: 'reader-occurrence-previous',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Previous reference from any term',
    strokes: [{ key: 'b' }],
  },
  {
    id: 'reader-occurrence-next',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Next reference from any term',
    strokes: [{ key: 'w' }],
  },
  {
    id: 'reader-book-start',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Start of book',
    strokes: [{ key: 'Home' }],
  },
  {
    id: 'reader-book-end',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'End of book',
    strokes: [{ key: 'End' }],
  },
  {
    id: 'reader-close',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Return to the workbench',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'reader-rsvp-toggle',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Return to normal Reader',
    strokes: [{ key: 'S', shift: true, explicitShift: true }],
  },
  {
    id: 'rsvp-exit',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Return to normal Reader',
    strokes: [{ key: 'Escape' }],
  },
  {
    id: 'rsvp-toggle-play',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Pause or resume',
    strokes: [{ key: ' ' }],
  },
  {
    id: 'rsvp-pace-editor',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Edit pace',
    strokes: [{ key: 'W', shift: true, explicitShift: true }],
  },
  {
    id: 'rsvp-pace-down',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Reduce pace',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }],
  },
  {
    id: 'rsvp-pace-up',
    group: 'Speed reader',
    helpContexts: ['rsvp'],
    label: 'Increase pace',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }],
  },
]);

const byId = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut] as const));

function definition(id: ShortcutId): ShortcutDefinition {
  const shortcut = byId.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut: ${id}`);
  return shortcut;
}

function shiftIsImpliedByResolvedKey(stroke: ShortcutStroke): boolean {
  return stroke.explicitShift !== true && (stroke.key === '?' || stroke.key === '/'
    || (stroke.key.length === 1 && stroke.key >= 'A' && stroke.key <= 'Z'));
}

function strokeMatches(event: ShortcutEventLike, stroke: ShortcutStroke): boolean {
  // `KeyboardEvent.key` already contains the printable character. Browsers
  // report the real `?` chord with Shift, while automation and alternative
  // layouts may synthesize the same character without exposing that physical
  // modifier; the resolved character is the stable contract here.
  if (shiftIsImpliedByResolvedKey(stroke)) {
    return event.key === stroke.key
      && event.ctrlKey === (stroke.ctrl === true)
      && event.metaKey === (stroke.meta === true);
  }
  return event.key === stroke.key
    && event.shiftKey === (stroke.shift === true)
    && event.ctrlKey === (stroke.ctrl === true)
    && event.metaKey === (stroke.meta === true);
}

export function shortcutMatches(event: ShortcutEventLike, id: ShortcutId): boolean {
  if (event.altKey || event.isComposing) return false;
  return definition(id).strokes.some((stroke) => strokeMatches(event, stroke));
}

function sequenceDefinitions(context: ShortcutHelpContext): readonly ShortcutDefinition[] {
  return SHORTCUTS.filter((shortcut) =>
    shortcut.sequence !== undefined && shortcut.helpContexts.includes(context));
}

/**
 * Advance one two-key Vim sequence. Prefixes expire rather than becoming a
 * hidden mode; a non-matching second key clears the prefix and remains native.
 */
export function advanceShortcutSequence(
  state: ShortcutSequenceState | null,
  event: ShortcutEventLike,
  context: ShortcutHelpContext,
  now: number,
): ShortcutSequenceAdvance {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return { kind: 'none' };
  }
  const definitions = sequenceDefinitions(context);
  const live = state !== null && now <= state.expiresAt ? state : null;
  if (live !== null) {
    const matched = definitions.find((shortcut) =>
      shortcut.sequence?.[0].key === live.prefix
      && strokeMatches(event, shortcut.sequence[1]));
    if (matched) return { kind: 'matched', id: matched.id };
  }
  const prefix = definitions.find((shortcut) =>
    shortcut.sequence !== undefined && strokeMatches(event, shortcut.sequence[0]));
  return prefix?.sequence
    ? {
        kind: 'pending',
        state: { prefix: prefix.sequence[0].key, expiresAt: now + SHORTCUT_SEQUENCE_TIMEOUT_MS },
      }
    : { kind: 'none' };
}

export function isShortcutTypingTarget(target: EventTarget | null): boolean {
  const candidate = target as (EventTarget & { closest?: (selector: string) => unknown }) | null;
  return typeof candidate?.closest === 'function'
    && candidate.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    ) !== null;
}

export function rootShortcutAllowed(
  event: ShortcutEventLike & { readonly defaultPrevented: boolean; readonly target: EventTarget | null },
): boolean {
  return !event.defaultPrevented
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.isComposing
    && !isShortcutTypingTarget(event.target)
    && !(
      (event.target as (EventTarget & { closest?: (selector: string) => unknown }) | null)
        ?.closest?.('[role="dialog"], [role="menu"]')
    );
}

/** Narrow gate for explicit interaction-mode chords. Named Ctrl/Cmd Find
 * chords intentionally outrank browser/text-field search behavior; every
 * other native text, modal, Meta/browser, Alt, composition, and local-handler
 * meaning remains authoritative. */
export function interactionShortcutAllowed(
  event: ShortcutEventLike & { readonly defaultPrevented: boolean; readonly target: EventTarget | null },
): boolean {
  const target = event.target as (EventTarget & { closest?: (selector: string) => unknown }) | null;
  const nativeFindChord = event.ctrlKey !== event.metaKey
    && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'g');
  return !event.defaultPrevented
    && !event.altKey
    && !event.isComposing
    && (!event.metaKey || nativeFindChord)
    && (
      !isShortcutTypingTarget(event.target)
      || nativeFindChord
      || (event.ctrlKey && target?.closest?.(FIND_SURFACE_SELECTOR) != null)
    )
    && !(
      target?.closest?.('[role="dialog"], [role="menu"]')
    );
}

const DISPLAY_KEY: Readonly<Record<string, string>> = Object.freeze({
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Escape: 'Esc',
  Enter: 'Enter',
  ' ': 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
});

function displayStroke(stroke: ShortcutStroke): string {
  const key = DISPLAY_KEY[stroke.key] ?? stroke.key;
  const modified = !stroke.shift
    || (shiftIsImpliedByResolvedKey(stroke) && stroke.ctrl !== true && stroke.meta !== true)
    ? key
    : `Shift + ${key}`;
  if (stroke.ctrl) return `Ctrl + ${modified}`;
  if (stroke.meta) return `Cmd + ${modified}`;
  return modified;
}

function ariaStroke(stroke: ShortcutStroke): string {
  const key = stroke.key === ' ' ? 'Space' : stroke.key;
  const modified = !stroke.shift || (shiftIsImpliedByResolvedKey(stroke) && stroke.key === '?')
    ? key
    : `Shift+${key}`;
  if (stroke.ctrl) return `Control+${modified}`;
  if (stroke.meta) return `Meta+${modified}`;
  return modified;
}

export function shortcutAria(ids: readonly ShortcutId[]): string {
  const keys = new Set<string>();
  for (const id of ids) {
    for (const stroke of definition(id).strokes) keys.add(ariaStroke(stroke));
  }
  return [...keys].join(' ');
}

const ROW_PLACES: ReadonlySet<Place> = new Set([
  'inputs',
  'matches',
  'vocabulary',
  'compare',
]);

const GO_PLACE: Readonly<Partial<Record<ShortcutId, Place>>> = Object.freeze({
  'go-inputs': 'inputs',
  'go-trends': 'trends',
  'go-matches': 'matches',
  'go-vocabulary': 'vocabulary',
  'go-compare': 'compare',
});

/** Build help from the commands that are usable in the active surface. The
 * registry still owns every binding; this projection only removes no-op or
 * unavailable sections from the menu. */
export function shortcutHelpSections(scope: ShortcutHelpScope): readonly ShortcutHelpSection[] {
  const order: readonly ShortcutDefinition['group'][] = scope.context === 'reader'
    ? ['Global', 'Find', 'Reader']
    : scope.context === 'rsvp'
      ? ['Global', 'Speed reader']
      : [
        'Global',
        'Find',
        'Navigation',
        'Terms',
        ...(scope.activeTextCount > 0 && ROW_PLACES.has(scope.place) ? ['Rows' as const] : []),
        ...(scope.place === 'trends' ? ['Trends' as const] : []),
        ...(scope.footerAvailable ? ['Reading footer' as const] : []),
        ...(scope.footerAvailable ? ['Footer size' as const] : []),
      ];
  return order.flatMap((group) => {
    const entries = SHORTCUTS
      .filter((shortcut) => {
        if (
          shortcut.group !== group
          || !shortcut.helpContexts.includes(scope.context)
        ) return false;
        if (scope.context !== 'workbench') return true;
        if (GO_PLACE[shortcut.id] === scope.place) return false;
        if (shortcut.id === 'go-compare' && scope.activeTextCount < 1) return false;
        if (shortcut.id === 'go-footer' && !scope.footerAvailable) return false;
        if (shortcut.id === 'trend-toggle-view' && scope.activeTextCount < 2) return false;
        return true;
      })
      .map((shortcut) => ({
        id: shortcut.id,
        label: shortcut.label,
        keys: [
          ...shortcut.strokes.map(displayStroke),
          ...(shortcut.sequence
            ? [shortcut.sequence.map(displayStroke).join('')]
            : []),
        ],
      }));
    return entries.length === 0 ? [] : [{ title: group, entries }];
  });
}
