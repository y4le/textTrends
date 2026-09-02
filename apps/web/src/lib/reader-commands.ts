import type { ReaderRelativeTarget } from './reader-order.ts';
import type { ReaderPosition } from './reader-position.ts';
import { readerSpeedEntryLabel } from './reader-cursor.ts';
import type { ReaderScale } from './reader-view.ts';
import type { ShortcutId } from './shortcuts.ts';
import type { ReaderNavigationTarget } from './store.ts';

export type ReaderCommandId =
  | 'exit'
  | 'page-previous'
  | 'page-next'
  | 'reference-previous'
  | 'reference-next'
  | 'text-previous'
  | 'text-next'
  | 'text-start'
  | 'text-end'
  | 'scale'
  | 'speed'
  | 'find'
  | 'settings'
  | 'help';

export type ReaderCommandGroup =
  | 'exit'
  | 'page'
  | 'reference'
  | 'text'
  | 'view'
  | 'utility';

export interface ReaderCommand {
  readonly id: ReaderCommandId;
  readonly group: ReaderCommandGroup;
  readonly label: string;
  readonly accessibleName: string;
  readonly shortcut?: ShortcutId;
  readonly present: boolean;
  readonly enabled: boolean;
  readonly reason?: string | undefined;
}

export interface ReaderCommandFacts {
  readonly position: ReaderPosition | null;
  readonly navigation: {
    readonly previous: ReaderNavigationTarget | null;
    readonly next: ReaderNavigationTarget | null;
  } | null;
  readonly scale: ReaderScale;
  readonly atlasAvailable: boolean;
  readonly speedAvailable: boolean;
  readonly speedWord: string | null;
  readonly hasPresentedTerms: boolean;
  readonly occurrencePending: boolean;
  readonly findMode: boolean;
  readonly previousText: ReaderRelativeTarget | null;
  readonly nextText: ReaderRelativeTarget | null;
  readonly titleOf: (doc: string) => string;
}

export function readerCommands(facts: ReaderCommandFacts): readonly ReaderCommand[] {
  const multipleTexts = (facts.position?.textCount ?? 0) > 1;
  const referenceLabel = facts.findMode ? 'find match' : 'reference';
  const atStart = (facts.position?.token ?? 0) <= 0;
  const atEnd = facts.position !== null
    && facts.position.tokenCount > 0
    && facts.position.token >= facts.position.tokenCount - 1;
  const canPagePrevious = facts.navigation?.previous != null;
  const canPageNext = facts.navigation?.next != null;
  const canReference = facts.hasPresentedTerms && !facts.occurrencePending;
  const canStart = facts.position !== null && !atStart;
  const canEnd = facts.position !== null && facts.position.tokenCount > 0 && !atEnd;
  return [
    {
      id: 'exit', group: 'exit', label: 'back', accessibleName: 'Return to workbench',
      shortcut: 'reader-close', present: true, enabled: true,
    },
    {
      id: 'page-previous', group: 'page', label: 'previous page',
      accessibleName: 'Previous page', shortcut: 'reader-page-previous', present: true,
      enabled: canPagePrevious, reason: canPagePrevious ? undefined : 'At start of corpus',
    },
    {
      id: 'page-next', group: 'page', label: 'next page', accessibleName: 'Next page',
      shortcut: 'reader-page-next', present: true, enabled: canPageNext,
      reason: canPageNext ? undefined : 'At end of corpus',
    },
    {
      id: 'reference-previous', group: 'reference', label: `previous ${referenceLabel}`,
      accessibleName: facts.findMode
        ? 'Previous exact Find match'
        : 'Previous exact reference from any term',
      shortcut: 'reader-occurrence-previous', present: facts.hasPresentedTerms,
      enabled: canReference,
      reason: canReference
        ? undefined
        : facts.hasPresentedTerms
          ? 'Reference navigation pending'
          : facts.findMode ? 'No active Find query' : 'No active terms',
    },
    {
      id: 'reference-next', group: 'reference', label: `next ${referenceLabel}`,
      accessibleName: facts.findMode
        ? 'Next exact Find match'
        : 'Next exact reference from any term',
      shortcut: 'reader-occurrence-next', present: facts.hasPresentedTerms,
      enabled: canReference,
      reason: canReference
        ? undefined
        : facts.hasPresentedTerms
          ? 'Reference navigation pending'
          : facts.findMode ? 'No active Find query' : 'No active terms',
    },
    {
      id: 'text-previous', group: 'text', label: 'previous text',
      accessibleName: facts.previousText === null
        ? 'At first readable text'
        : `Previous text: ${facts.titleOf(facts.previousText.doc)}`,
      shortcut: 'reader-text-previous', present: multipleTexts,
      enabled: facts.previousText !== null,
      reason: facts.previousText === null ? 'At first readable text' : undefined,
    },
    {
      id: 'text-next', group: 'text', label: 'next text',
      accessibleName: facts.nextText === null
        ? 'At last readable text'
        : `Next text: ${facts.titleOf(facts.nextText.doc)}`,
      shortcut: 'reader-text-next', present: multipleTexts,
      enabled: facts.nextText !== null,
      reason: facts.nextText === null ? 'At last readable text' : undefined,
    },
    {
      id: 'text-start', group: 'text', label: 'start', accessibleName: 'Start of text',
      shortcut: 'reader-book-start', present: facts.position !== null,
      enabled: canStart, reason: canStart ? undefined : 'At start of text',
    },
    {
      id: 'text-end', group: 'text', label: 'end', accessibleName: 'End of text',
      shortcut: 'reader-book-end', present: facts.position !== null,
      enabled: canEnd, reason: canEnd ? undefined : 'At end of text',
    },
    {
      id: 'scale', group: 'view', label: facts.scale === 'read' ? 'Atlas' : 'Read',
      accessibleName: facts.scale === 'read' ? 'Open document Atlas' : 'Open Read view',
      present: facts.atlasAvailable, enabled: facts.atlasAvailable,
      reason: facts.atlasAvailable ? undefined : 'Atlas requires multiple readable texts',
    },
    {
      id: 'speed', group: 'view', label: 'speed',
      accessibleName: readerSpeedEntryLabel(facts.speedWord),
      shortcut: 'reader-rsvp-toggle', present: facts.scale === 'read',
      enabled: facts.speedAvailable,
      reason: facts.speedAvailable ? undefined : 'Source text is not ready',
    },
    {
      id: 'find', group: 'utility', label: 'find', accessibleName: 'Find in corpus',
      shortcut: 'find-open', present: true, enabled: !facts.findMode,
      reason: facts.findMode ? 'Find is already open' : undefined,
    },
    {
      id: 'settings', group: 'utility', label: 'settings',
      accessibleName: 'Open Reader settings', present: true, enabled: true,
    },
    {
      id: 'help', group: 'utility', label: 'help', accessibleName: 'Open Reader help',
      shortcut: 'show-help', present: true, enabled: true,
    },
  ];
}

export function readerCommand(
  commands: readonly ReaderCommand[],
  id: ReaderCommandId,
): ReaderCommand {
  const command = commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`missing Reader command: ${id}`);
  return command;
}
