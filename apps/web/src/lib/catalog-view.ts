/**
 * Pure view-model over the baked Standard Ebooks catalog. The panel renders
 * series sections first (members joined to their book metadata, in reading
 * order), then the remaining popular books with every series name excluded —
 * a book never renders twice. One filter matches title, author, and series
 * title; a series-title match keeps the whole series. Order is always the
 * catalog's canonical order, never re-sorted by the filter.
 */

import type { CatalogBook, StandardEbooksCatalog } from './standard-ebooks-catalog.ts';

export type CatalogSectionBook = CatalogBook & {
  /** Reading-order position when the book renders inside a series section. */
  readonly position?: number;
};

export type CatalogSection = {
  /** The series slug, or 'popular' for the rank-ordered remainder. */
  readonly key: string;
  /** The series title; null for the popular block. */
  readonly title: string | null;
  readonly books: readonly CatalogSectionBook[];
};

export function catalogSections(catalog: StandardEbooksCatalog, query: string): CatalogSection[] {
  const needle = query.trim().toLowerCase();
  const matches = (book: CatalogBook) =>
    needle === '' || book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle);
  const byName = new Map(catalog.books.map((book) => [book.name, book]));
  const sections: CatalogSection[] = [];
  // Every series member is excluded from the popular block, even one the
  // current filter hides — membership, not visibility, decides where a book
  // renders.
  const inSeries = new Set<string>();
  for (const series of catalog.series) {
    const seriesMatch = needle !== '' && series.title.toLowerCase().includes(needle);
    const books: CatalogSectionBook[] = [];
    for (const member of series.members) {
      const book = byName.get(member.name);
      if (book === undefined) continue; // unresolvable members are excluded by the artifact test
      inSeries.add(member.name);
      if (seriesMatch || matches(book)) books.push({ ...book, position: member.position });
    }
    if (books.length > 0) sections.push({ key: series.slug, title: series.title, books });
  }
  const popular = catalog.books.filter(
    (book) => book.popularityRank !== undefined && !inSeries.has(book.name) && matches(book),
  );
  if (popular.length > 0) sections.push({ key: 'popular', title: null, books: popular });
  return sections;
}
