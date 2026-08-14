import type {
  InventoryDocumentRowV1,
  InventoryResultV1,
} from '@texttrends/core';
import { selectionRangeForDoc, type TokenRangeSelectionV1 } from './selection.ts';

export interface BookSheetTarget {
  readonly surface: 'book-sheet';
  readonly doc: string;
}

function encodedDocId(doc: string): string {
  return encodeURIComponent(doc);
}

export function bookTitleControlId(doc: string): string {
  return `catalog-book-title-${encodedDocId(doc)}`;
}

export function bookDetailRegionId(doc: string): string {
  return `book-detail-${encodedDocId(doc)}`;
}

export function bookSourceHeadingId(doc: string): string {
  return `book-source-${encodedDocId(doc)}`;
}

export interface BookDetailVM {
  readonly doc: string;
  readonly title: string;
  readonly stats: InventoryDocumentRowV1;
  readonly mattrWindow: number;
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

/** One resident-data projection for every responsive book-detail presentation. */
export function bookDetailView(input: {
  readonly target: BookSheetTarget;
  readonly title: string;
  readonly result: InventoryResultV1;
}): BookDetailVM | null {
  const stats = input.result.documents.find((row) => row.doc === input.target.doc);
  if (!stats) return null;
  return {
    doc: input.target.doc,
    title: input.title,
    stats,
    mattrWindow: input.result.mattrWindow,
  };
}
