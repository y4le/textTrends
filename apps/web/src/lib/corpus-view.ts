import type {
  InventoryDocumentRowV1,
  InventoryResultV1,
} from '@texttrends/core';
import {
  rhythmBinsForDocument,
  type RhythmBinView,
} from './corpus-dashboard-view.ts';
import { selectionRangeForDoc, type TokenRangeSelectionV1 } from './selection.ts';

export interface BookSheetTarget {
  readonly surface: 'book-sheet';
  readonly doc: string;
}

function encodedDocId(doc: string): string {
  return encodeURIComponent(doc);
}

export function bookTitleControlId(doc: string): string {
  return `corpus-book-title-${encodedDocId(doc)}`;
}

export function bookDetailRegionId(doc: string): string {
  return `book-detail-${encodedDocId(doc)}`;
}

export function bookInventoryHeadingId(doc: string): string {
  return `book-inventory-${encodedDocId(doc)}`;
}

export function bookGrowthHeadingId(doc: string): string {
  return `book-growth-${encodedDocId(doc)}`;
}

export function bookRhythmHeadingId(doc: string): string {
  return `book-rhythm-${encodedDocId(doc)}`;
}

export type BookGrowthState = 'scoped' | 'unscoped' | 'absent';

export interface BookDetailVM {
  readonly doc: string;
  readonly title: string;
  readonly stats: InventoryDocumentRowV1;
  readonly rhythm: readonly RhythmBinView[];
  readonly growth: BookGrowthState;
  readonly vocabularyLabel: string;
}

/** Total parser for presentation-only book-detail targets. */
export function bookSheetTarget(value: unknown): BookSheetTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.surface !== 'book-sheet'
    || typeof candidate.doc !== 'string'
    || candidate.doc === ''
  ) {
    return null;
  }
  return { surface: 'book-sheet', doc: candidate.doc };
}

export function isWholeBookSelection(
  selection: TokenRangeSelectionV1 | null,
  doc: string,
  fullTokens: number,
): boolean {
  const range = selectionRangeForDoc(selection, doc);
  return selection?.ranges.length === 1
    && range !== null
    && range.tokens.start === 0
    && range.tokens.end === fullTokens;
}

function vocabularyLabel(
  selection: TokenRangeSelectionV1 | null,
  wholeBook: boolean,
): string {
  if (wholeBook) return 'vocabulary for this book';
  if (selection !== null) return 'vocabulary for the active range';
  return 'vocabulary (all books)';
}

/** One resident-data projection for every responsive book-detail presentation. */
export function bookDetailView(input: {
  readonly target: BookSheetTarget;
  readonly title: string;
  readonly result: InventoryResultV1;
  readonly snapshotDocOrdinal: number;
  readonly selection: TokenRangeSelectionV1 | null;
}): BookDetailVM | null {
  const stats = input.result.documents.find((row) => row.doc === input.target.doc);
  if (!stats) return null;
  const wholeBook = isWholeBookSelection(
    input.selection,
    input.target.doc,
    stats.fullTokens,
  );
  return {
    doc: input.target.doc,
    title: input.title,
    stats,
    rhythm: input.result.rhythm
      ? rhythmBinsForDocument(input.result.rhythm, input.snapshotDocOrdinal)
      : [],
    growth: input.result.growth === null
      ? 'absent'
      : wholeBook
        ? 'scoped'
        : 'unscoped',
    vocabularyLabel: vocabularyLabel(input.selection, wholeBook),
  };
}
