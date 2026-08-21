/**
 * The catalog view-model filters title and author without disturbing frozen
 * popularity order.
 */
import { describe, expect, it } from 'vitest';
import { catalogBooks } from '../src/lib/catalog-view.ts';
import type { StandardEbooksCatalog } from '../src/lib/standard-ebooks-catalog.ts';

const CATALOG: StandardEbooksCatalog = {
  schemaVersion: 2,
  generatedAt: '2026-07-27T00:00:00.000Z',
  source: { popularityUrl: 'https://standardebooks.org/ebooks?sort=popularity&per-page=48' },
  books: [
    { name: 'mary-shelley_frankenstein', title: 'Frankenstein', author: 'Mary Shelley', popularityRank: 1 },
    { name: 'acd_hound', title: 'The Hound of the Baskervilles', author: 'Arthur Conan Doyle', popularityRank: 2 },
    { name: 'homer_odyssey', title: 'The Odyssey', author: 'Homer', popularityRank: 3 },
    { name: 'acd_study', title: 'A Study in Scarlet', author: 'Arthur Conan Doyle', popularityRank: 4 },
  ],
};

const names = (books: ReturnType<typeof catalogBooks>) => books.map((book) => book.name);

describe('catalogBooks', () => {
  it('returns every book in frozen popularity order for an empty query', () => {
    expect(names(catalogBooks(CATALOG, ''))).toEqual([
      'mary-shelley_frankenstein',
      'acd_hound',
      'homer_odyssey',
      'acd_study',
    ]);
  });

  it('filters by title in place, preserving order', () => {
    expect(names(catalogBooks(CATALOG, 'the'))).toEqual(['acd_hound', 'homer_odyssey']);
  });

  it('filters by author', () => {
    expect(names(catalogBooks(CATALOG, 'arthur conan doyle'))).toEqual(['acd_hound', 'acd_study']);
  });

  it('returns no books when nothing matches', () => {
    expect(catalogBooks(CATALOG, 'zzz-no-such-book')).toEqual([]);
  });
});
