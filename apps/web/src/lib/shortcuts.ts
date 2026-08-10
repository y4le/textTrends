export type ShortcutHelpContext = 'workbench' | 'reader';

export type ShortcutId =
  | 'show-help'
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
  | 'reader-line-up'
  | 'reader-line-down'
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
  readonly group: 'General' | 'Reading footer' | 'Reader';
  readonly helpContexts: readonly ShortcutHelpContext[];
  readonly label: string;
  readonly strokes: readonly ShortcutStroke[];
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

const SHORTCUTS: readonly ShortcutDefinition[] = Object.freeze([
  {
    id: 'show-help',
    group: 'General',
    helpContexts: ['workbench', 'reader'],
    label: 'Show keyboard shortcuts',
    strokes: [{ key: '?', shift: true }],
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
    id: 'reader-line-up',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Scroll up one line',
    strokes: [{ key: 'k' }],
  },
  {
    id: 'reader-line-down',
    group: 'Reader',
    helpContexts: ['reader'],
    label: 'Scroll down one line',
    strokes: [{ key: 'j' }],
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
    : ['General', 'Reading footer'];
  return order.flatMap((group) => {
    const entries = SHORTCUTS
      .filter((shortcut) => shortcut.group === group && shortcut.helpContexts.includes(context))
      .map((shortcut) => ({
        id: shortcut.id,
        label: shortcut.label,
        keys: shortcut.strokes.map(displayStroke),
      }));
    return entries.length === 0 ? [] : [{ title: group, entries }];
  });
}
