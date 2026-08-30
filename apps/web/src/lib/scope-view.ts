import type { InventoryState, KeynessViewV1 } from './store.ts';
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
  /** Imports already chosen by the user but not identity-complete yet. */
  readonly pendingInputCount: number;
  readonly snapshot: {
    readonly snapshot: string;
    readonly readyDocs: readonly string[];
    readonly missingDocs: readonly string[];
  } | null;
  readonly inventory: InventoryState | null;
  readonly linkedSelection: TokenRangeSelectionV1 | null;
  readonly compareMode: KeynessViewV1['mode'];
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly loadingPhase: string | null;
  /** Selection-independent token total retained from authenticated document
   * extents. Null means the full total is not resident yet. */
  readonly totalCorpusTokens: number | null;
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

export interface ScopeChipVM {
  /** Truncating document/status title used when the header has room. */
  readonly expandedTitle: string;
  /** Width-independent fallback title; CSS chooses it without a JS query. */
  readonly shortTitle: string;
  /** Exact magnitude. It is rendered in a non-shrinking span. */
  readonly magnitude: string | null;
  /** Compact but never ellipsized magnitude for the narrowest header. */
  readonly compactMagnitude: string | null;
  /** Complete button name, independent of the visible responsive summary. */
  readonly accessibleName: string;
  readonly narrowed: boolean;
  readonly partial: boolean;
}

export interface ScopeVM {
  readonly corpusName: string;
  readonly readyText: string;
  readonly docsInScope: number | null;
  readonly tokensInScope: number | null;
  readonly range: ScopeRangeVM | null;
  readonly partial: boolean;
  readonly missingDocs: readonly string[];
  readonly missingDocTitles: readonly string[];
  readonly totalCorpusTokens: number | null;
  readonly exception: string | null;
  readonly chip: ScopeChipVM | null;
  readonly announcement: string;
  readonly segments: readonly string[];
}

function compactNumber(value: number): string {
  const magnitude = Math.abs(value);
  const compact = (divisor: number, suffix: string) => {
    const scaled = value / divisor;
    const digits = Math.abs(scaled) < 10 && !Number.isInteger(scaled) ? 1 : 0;
    return `${scaled.toFixed(digits).replace(/\.0$/u, '')}${suffix}`;
  };
  if (magnitude >= 1_000_000) return compact(1_000_000, 'm');
  if (magnitude >= 1_000) return compact(1_000, 'k');
  return number.format(value);
}

export function corpusName(project: ScopeProject | null): string {
  if (project === null) return 'Preparing corpus';
  return project.kind === 'builtin'
    ? builtinCorpusOption(project.id)?.label ?? 'Built-in corpus'
    : 'Library corpus';
}

export function scopeView(input: ScopeInput, place: Place): ScopeVM {
  const corpus = corpusName(input.project);
  const empty = input.project?.docCount === 0 && input.pendingInputCount === 0;
  const ready = input.snapshot?.readyDocs.length ?? 0;
  const missing = input.snapshot?.missingDocs ?? [];
  const declared = ready + missing.length || input.project?.docCount || 0;
  const readyText = empty
    ? 'nothing is being analyzed'
    : input.snapshot
      ? `${ready}/${declared} texts ready`
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
            : `${firstTitle} token ${number.format(firstToken)} → ${lastTitle} token ${number.format(lastToken)} · ${number.format(tokens)} tokens across ${number.format(documents)} texts`,
        };
      })();
  const exception = place === 'compare' && range !== null
    ? input.compareMode === 'selection-rest'
      ? 'Compare is measuring the selected range against the rest of the corpus'
      : 'Compare uses declared sides A and B · the active trend range does not apply'
    : null;

  const segments: string[] = [empty ? 'No active inputs' : corpus];
  // Whole-corpus readiness is an honest fallback only when no range is
  // active. During a range query, "6 texts in scope" would contradict the
  // linked range while its issued inventory is still pending.
  const scopeDocs = docsInScope ?? (input.snapshot && range === null ? ready : null);
  if (scopeDocs !== null && scopeDocs > 0) {
    segments.push(range
      ? `${number.format(scopeDocs)} ${scopeDocs === 1 ? 'text' : 'texts'} in scope`
      : `all ${number.format(scopeDocs)} ${scopeDocs === 1 ? 'text' : 'texts'}`);
  }
  if (tokensInScope !== null) segments.push(`${number.format(tokensInScope)} tokens`);
  if (range) segments.push(range.label);
  segments.push(readyText);
  if (partial) segments.push('partial corpus');
  if (exception) segments.push(exception);

  const missingDocTitles = missing.map((doc) => input.titleByDoc.get(doc) ?? doc);
  const loading = !empty && (
    input.project === null
    || input.snapshot === null
    || input.loadingPhase !== null
  );
  const loadingTitle = input.loadingPhase ?? 'Preparing corpus';
  const chip: ScopeChipVM | null = range !== null
    ? (() => {
        const shortTitle = range.documents === 1
          ? 'range'
          : `${number.format(range.documents)}-text range`;
        const magnitude = `${number.format(range.tokens)} tokens`;
        const compactMagnitude = compactNumber(range.tokens);
        return {
          expandedTitle: range.docTitle,
          shortTitle,
          magnitude,
          compactMagnitude,
          accessibleName: [
            `${shortTitle} · ${magnitude}`,
            compactMagnitude === magnitude ? null : compactMagnitude,
            range.docTitle,
            `Scope: ${range.label}`,
            input.totalCorpusTokens === null
              ? null
              : `${number.format(range.tokens)} of ${number.format(input.totalCorpusTokens)} corpus tokens selected`,
            partial ? 'partial corpus' : null,
            exception,
            'Open scope details',
          ].filter((part): part is string => part !== null).join(' · '),
          narrowed: true,
          partial,
        };
      })()
    : partial
      ? {
          expandedTitle: 'Partial corpus',
          shortTitle: 'partial',
          magnitude: `${number.format(missing.length)} unavailable`,
          compactMagnitude: `${number.format(missing.length)} missing`,
          accessibleName: [
            'Partial corpus',
            'partial',
            `${number.format(missing.length)} unavailable`,
            `${number.format(missing.length)} missing`,
            `Scope: ${segments.join(' · ')}`,
            'Open scope details',
          ].join(' · '),
          narrowed: false,
          partial: true,
        }
      : loading
        ? {
            expandedTitle: loadingTitle,
            shortTitle: 'loading',
            magnitude: null,
            compactMagnitude: null,
            accessibleName:
              `${loadingTitle} · loading · Scope: ${segments.join(' · ')} · Open scope details`,
            narrowed: false,
            partial: false,
          }
        : null;

  return {
    corpusName: corpus,
    readyText,
    docsInScope,
    tokensInScope,
    range,
    partial,
    missingDocs: missing,
    missingDocTitles,
    totalCorpusTokens: input.totalCorpusTokens,
    exception,
    chip,
    announcement: segments.join(' · '),
    segments,
  };
}
