export type ShortcutHelpContext = 'workbench' | 'reader';

export type ShortcutId =
  | 'show-help'
  | 'focus-horizontal-previous'
  | 'focus-horizontal-next'
  | 'focus-term-previous'
  | 'focus-term-next'
  | 'focus-book-previous'
  | 'focus-book-next'
  | 'go-catalog'
  | 'go-trends'
  | 'go-concordance'
  | 'go-vocabulary'
  | 'go-compare'
  | 'go-footer'
  | 'go-terms'
  | 'row-previous'
  | 'row-next'
  | 'row-page-previous'
  | 'row-page-next'
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
  | 'reader-page-previous'
  | 'reader-page-next'
  | 'reader-occurrence-previous'
  | 'reader-occurrence-next'
  | 'reader-book-start'
  | 'reader-book-end'
  | 'reader-close';

interface ShortcutStroke {
  readonly key: string;
  readonly shift?: true;
}

interface ShortcutDefinition {
  readonly id: ShortcutId;
  readonly group: 'General' | 'Navigation' | 'Focus' | 'Rows' | 'Trends' | 'Reading footer' | 'Reader';
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
    group: 'General',
    helpContexts: ['workbench', 'reader'],
    label: 'Toggle keyboard shortcuts',
    strokes: [{ key: '?', shift: true }],
  },
  {
    id: 'focus-horizontal-previous',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Previous term or lens',
    strokes: [{ key: 'h' }, { key: 'ArrowLeft' }],
  },
  {
    id: 'focus-horizontal-next',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Next term or lens',
    strokes: [{ key: 'l' }, { key: 'ArrowRight' }],
  },
  {
    id: 'focus-term-previous',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Previous active term',
    strokes: [],
    sequence: [{ key: '[' }, { key: 't' }],
  },
  {
    id: 'focus-term-next',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Next active term',
    strokes: [],
    sequence: [{ key: ']' }, { key: 't' }],
  },
  {
    id: 'focus-book-previous',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Previous ready book',
    strokes: [],
    sequence: [{ key: '[' }, { key: 'b' }],
  },
  {
    id: 'focus-book-next',
    group: 'Focus',
    helpContexts: ['workbench'],
    label: 'Next ready book',
    strokes: [],
    sequence: [{ key: ']' }, { key: 'b' }],
  },
  {
    id: 'go-catalog',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Catalog',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'c' }],
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
    id: 'go-concordance',
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Go to Concordance',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'k' }],
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
    sequence: [{ key: 'g' }, { key: 'd' }],
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
    group: 'Navigation',
    helpContexts: ['workbench'],
    label: 'Focus Terms',
    strokes: [],
    sequence: [{ key: 'g' }, { key: 'q' }],
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
    label: 'Toggle series / by-book view',
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
    label: 'Previous exact focused-term occurrence',
    strokes: [{ key: 'W', shift: true }],
  },
  {
    id: 'footer-occurrence-next',
    group: 'Reading footer',
    helpContexts: ['workbench'],
    label: 'Next exact focused-term occurrence',
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
    label: 'Previous exact focused-term occurrence',
    strokes: [{ key: 'W', shift: true }],
  },
  {
    id: 'reader-occurrence-next',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Next exact focused-term occurrence',
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
]);

const byId = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut] as const));

function definition(id: ShortcutId): ShortcutDefinition {
  const shortcut = byId.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut: ${id}`);
  return shortcut;
}

function shiftIsImpliedByResolvedKey(stroke: ShortcutStroke): boolean {
  return stroke.key === '?'
    || (stroke.key.length === 1 && stroke.key >= 'A' && stroke.key <= 'Z');
}

function strokeMatches(event: ShortcutEventLike, stroke: ShortcutStroke): boolean {
  // `KeyboardEvent.key` already contains the printable character. Browsers
  // report the real `?` chord with Shift, while automation and alternative
  // layouts may synthesize the same character without exposing that physical
  // modifier; the resolved character is the stable contract here.
  if (shiftIsImpliedByResolvedKey(stroke)) {
    return event.key === stroke.key;
  }
  return event.key === stroke.key && event.shiftKey === (stroke.shift === true);
}

export function shortcutMatches(event: ShortcutEventLike, id: ShortcutId): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
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
        ?.closest?.('[role="dialog"]')
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
  Home: 'Home',
  End: 'End',
});

function displayStroke(stroke: ShortcutStroke): string {
  const key = DISPLAY_KEY[stroke.key] ?? stroke.key;
  if (!stroke.shift || shiftIsImpliedByResolvedKey(stroke)) return key;
  return `Shift + ${key}`;
}

function ariaStroke(stroke: ShortcutStroke): string {
  if (!stroke.shift || (shiftIsImpliedByResolvedKey(stroke) && stroke.key === '?')) return stroke.key;
  return `Shift+${stroke.key}`;
}

export function shortcutAria(ids: readonly ShortcutId[]): string {
  const keys = new Set<string>();
  for (const id of ids) {
    for (const stroke of definition(id).strokes) keys.add(ariaStroke(stroke));
  }
  return [...keys].join(' ');
}

export function shortcutHelpSections(context: ShortcutHelpContext): readonly ShortcutHelpSection[] {
  const order: readonly ShortcutDefinition['group'][] = context === 'reader'
    ? ['General', 'Reader']
    : ['General', 'Navigation', 'Focus', 'Rows', 'Trends', 'Reading footer'];
  return order.flatMap((group) => {
    const entries = SHORTCUTS
      .filter((shortcut) => shortcut.group === group && shortcut.helpContexts.includes(context))
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
