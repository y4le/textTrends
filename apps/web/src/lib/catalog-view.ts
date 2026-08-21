/**
 * Pure view-model over the baked Standard Ebooks catalog. One filter matches
 * title and author while preserving the catalog's popularity order.
 */

import type { CatalogBook, StandardEbooksCatalog } from './standard-ebooks-catalog.ts';

export function catalogBooks(catalog: StandardEbooksCatalog, query: string): readonly CatalogBook[] {
  const needle = query.trim().toLowerCase();
  return catalog.books.filter((book) =>
    needle === '' || book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle));
}
