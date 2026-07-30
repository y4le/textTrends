import type { InventoryState } from './store.ts';
import type { TokenRangeSelectionV1 } from './selection.ts';
import type { Place } from './places.ts';
import { pinCapacity } from './pin-capacity.ts';

const number = new Intl.NumberFormat();

export interface ScopeProject {
  readonly kind: 'builtin' | 'user';
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
  readonly pins: {
    readonly used: number;
    readonly cap: number;
    readonly needingReview: number;
  };
  readonly loadingPhase: string | null;
}

export interface ScopeRangeVM {
  readonly docTitle: string;
  readonly firstToken: number;
  readonly lastToken: number;
  readonly tokens: number;
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
  return project.kind === 'builtin' ? 'Sherlock Holmes' : 'Imported corpus';
}

function sameSelection(
  left: TokenRangeSelectionV1 | null,
  right: TokenRangeSelectionV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.snapshot === right.snapshot
    && left.doc === right.doc
    && left.tokens.start === right.tokens.start
    && left.tokens.end === right.tokens.end;
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
        const docTitle = input.titleByDoc.get(selection.doc) ?? selection.doc;
        const firstToken = selection.tokens.start + 1;
        const lastToken = selection.tokens.end;
        const tokens = selection.tokens.end - selection.tokens.start;
        return {
          docTitle,
          firstToken,
          lastToken,
          tokens,
          label: `${docTitle} · tokens ${number.format(firstToken)}–${number.format(lastToken)} · ${number.format(tokens)} tokens`,
        };
      })();
  const exception = place === 'compare' && range !== null
    ? 'Compare uses declared sides A and B · the active trend range does not apply'
    : null;

  const segments: string[] = [corpus];
  // Whole-corpus readiness is an honest fallback only when no range is
  // active. During a range query, "6 books in scope" would contradict the
  // single-document range while its issued inventory is still pending.
  const scopeDocs = docsInScope ?? (input.snapshot && range === null ? ready : null);
  if (scopeDocs !== null && scopeDocs > 0) {
    segments.push(range
      ? `${number.format(scopeDocs)} ${scopeDocs === 1 ? 'book' : 'books'} in scope`
      : `all ${number.format(scopeDocs)} ${scopeDocs === 1 ? 'book' : 'books'}`);
  }
  if (tokensInScope !== null) segments.push(`${number.format(tokensInScope)} tokens`);
  if (range) segments.push(range.label);
  segments.push(readyText);
  segments.push(pinCapacity(input.pins.used, input.pins.cap).label);
  if (input.pins.needingReview > 0) {
    segments.push(
      `${input.pins.needingReview} ${input.pins.needingReview === 1 ? 'anchor needs' : 'anchors need'} review`,
    );
  }
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
