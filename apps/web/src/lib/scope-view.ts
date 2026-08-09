import type { InventoryState } from './store.ts';
import { sameSelection, selectionTokenCount, type TokenRangeSelectionV1 } from './selection.ts';
import type { Place } from './places.ts';
import { builtinCorpusOption } from './project.ts';

const number = new Intl.NumberFormat();

export interface ScopeProject {
  readonly kind: 'builtin' | 'library';
  readonly id: string;
  readonly docCount: number;
}

export interface ScopeInput {
  readonly project: ScopeProject | null;
  readonly snapshot: {
    readonly snapshot: string;
    readonly readyDocs: readonly string[];
    readonly missingDocs: readonly string[];
  } | null;
  readonly inventory: InventoryState | null;
  readonly linkedSelection: TokenRangeSelectionV1 | null;
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly loadingPhase: string | null;
}

export interface ScopeRangeVM {
  /** Human title of the one book, or `first → last` for a cross-book range. */
  readonly docTitle: string;
  /** 1-based inclusive token endpoint in the first selected book. */
  readonly firstToken: number;
  /** 1-based inclusive token endpoint in the last selected book; it is not
   * numerically comparable with firstToken when documents > 1. */
  readonly lastToken: number;
  readonly tokens: number;
  readonly documents: number;
  readonly label: string;
}

export interface ScopeVM {
  readonly corpusName: string;
  readonly readyText: string;
  readonly docsInScope: number | null;
  readonly tokensInScope: number | null;
  readonly range: ScopeRangeVM | null;
  readonly partial: boolean;
  readonly missingDocs: readonly string[];
  readonly exception: string | null;
  readonly announcement: string;
  readonly segments: readonly string[];
}

export function corpusName(project: ScopeProject | null): string {
  if (project === null) return 'Preparing corpus';
  return project.kind === 'builtin'
    ? builtinCorpusOption(project.id)?.label ?? 'Built-in corpus'
    : 'Library corpus';
}

export function scopeView(input: ScopeInput, place: Place): ScopeVM {
  const corpus = corpusName(input.project);
  const ready = input.snapshot?.readyDocs.length ?? 0;
  const missing = input.snapshot?.missingDocs ?? [];
  const declared = ready + missing.length || input.project?.docCount || 0;
  const readyText = input.snapshot
    ? `${ready}/${declared} books ready`
    : input.loadingPhase ?? 'loading…';
  const inventoryMatchesScope = input.inventory !== null
    && input.snapshot !== null
    && input.inventory.snapshot === input.snapshot.snapshot
    && sameSelection(input.inventory.selection, input.linkedSelection);
  const result = inventoryMatchesScope && input.inventory?.state.status === 'ready'
    ? input.inventory.state.result
    : null;
  const docsInScope = result?.totals.selectedDocs ?? null;
  const tokensInScope = result?.totals.tokens ?? null;
  const partial = missing.length > 0 || (result?.missingDocs.length ?? 0) > 0;

  const selection = input.linkedSelection;
  const range = selection === null
    ? null
    : (() => {
        const first = selection.ranges[0]!;
        const last = selection.ranges.at(-1)!;
        const firstTitle = input.titleByDoc.get(first.doc) ?? first.doc;
        const lastTitle = input.titleByDoc.get(last.doc) ?? last.doc;
        const documents = selection.ranges.length;
        const docTitle = documents === 1 ? firstTitle : `${firstTitle} → ${lastTitle}`;
        const firstToken = first.tokens.start + 1;
        const lastToken = last.tokens.end;
        const tokens = selectionTokenCount(selection);
        return {
          docTitle,
          firstToken,
          lastToken,
          tokens,
          documents,
          label: documents === 1
            ? `${docTitle} · tokens ${number.format(firstToken)}–${number.format(lastToken)} · ${number.format(tokens)} tokens`
            : `${firstTitle} token ${number.format(firstToken)} → ${lastTitle} token ${number.format(lastToken)} · ${number.format(tokens)} tokens across ${number.format(documents)} books`,
        };
      })();
  const exception = place === 'compare' && range !== null
    ? 'Compare uses declared sides A and B · the active trend range does not apply'
    : null;

  const segments: string[] = [corpus];
  // Whole-corpus readiness is an honest fallback only when no range is
  // active. During a range query, "6 books in scope" would contradict the
  // linked range while its issued inventory is still pending.
  const scopeDocs = docsInScope ?? (input.snapshot && range === null ? ready : null);
  if (scopeDocs !== null && scopeDocs > 0) {
    segments.push(range
      ? `${number.format(scopeDocs)} ${scopeDocs === 1 ? 'book' : 'books'} in scope`
      : `all ${number.format(scopeDocs)} ${scopeDocs === 1 ? 'book' : 'books'}`);
  }
  if (tokensInScope !== null) segments.push(`${number.format(tokensInScope)} tokens`);
  if (range) segments.push(range.label);
  segments.push(readyText);
  if (partial) segments.push('partial corpus');
  if (exception) segments.push(exception);

  return {
    corpusName: corpus,
    readyText,
    docsInScope,
    tokensInScope,
    range,
    partial,
    missingDocs: missing,
    exception,
    announcement: segments.join(' · '),
    segments,
  };
}
