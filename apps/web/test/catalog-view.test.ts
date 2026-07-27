/**
 * The catalog view-model: series sections first with position-joined members
 * in reading order, then the popular remainder excluding every series name
 * (a book never renders twice), under one filter that matches title, author,
 * and series title while preserving canonical order.
 */
import { describe, expect, it } from 'vitest';
import { catalogSections } from '../src/lib/catalog-view.ts';
import type { StandardEbooksCatalog } from '../src/lib/standard-ebooks-catalog.ts';

/** Two series (one member also popular; one series-only book) + plain popular books. */
const CATALOG: StandardEbooksCatalog = {
  schemaVersion: 1,
  generatedAt: '2026-07-27T00:00:00.000Z',
  source: { popularityUrl: 'https://standardebooks.org/ebooks?sort=popularity&per-page=48' },
  books: [
    { name: 'mary-shelley_frankenstein', title: 'Frankenstein', author: 'Mary Shelley', popularityRank: 1 },
    { name: 'acd_hound', title: 'The Hound of the Baskervilles', author: 'Arthur Conan Doyle', popularityRank: 2 },
    { name: 'homer_odyssey', title: 'The Odyssey', author: 'Homer', popularityRank: 3 },
    { name: 'acd_study', title: 'A Study in Scarlet', author: 'Arthur Conan Doyle' },
    { name: 'trollope_warden', title: 'The Warden', author: 'Anthony Trollope' },
    { name: 'trollope_towers', title: 'Barchester Towers', author: 'Anthony Trollope' },
  ],
  series: [
    {
      slug: 'sherlock-holmes',
      title: 'Sherlock Holmes',
      sourceUrl: 'https://standardebooks.org/collections/sherlock-holmes',
      members: [
        { name: 'acd_study', position: 1 },
        { name: 'acd_hound', position: 5 },
      ],
    },
    {
      slug: 'barsetshire',
      title: 'Chronicles of Barsetshire',
      sourceUrl: 'https://standardebooks.org/collections/barsetshire',
      members: [
        { name: 'trollope_warden', position: 1 },
        { name: 'trollope_towers', position: 2 },
      ],
    },
  ],
};

const names = (sections: ReturnType<typeof catalogSections>) =>
  sections.map((s) => ({ key: s.key, books: s.books.map((b) => b.name) }));

describe('catalogSections', () => {
  it('renders series first in catalog order, positions joined, then deduped popular', () => {
    const sections = catalogSections(CATALOG, '');
    expect(names(sections)).toEqual([
      { key: 'sherlock-holmes', books: ['acd_study', 'acd_hound'] },
      { key: 'barsetshire', books: ['trollope_warden', 'trollope_towers'] },
      // acd_hound is rank 2 but already rendered in its series
      { key: 'popular', books: ['mary-shelley_frankenstein', 'homer_odyssey'] },
    ]);
    expect(sections[0]?.title).toBe('Sherlock Holmes');
    expect(sections[0]?.books.map((b) => b.position)).toEqual([1, 5]);
    expect(sections[2]?.title).toBeNull();
    expect(sections[2]?.books.every((b) => b.position === undefined)).toBe(true);
  });

  it('keeps series-only books out of the popular block (they have no rank)', () => {
    const popular = catalogSections(CATALOG, '').find((s) => s.key === 'popular');
    expect(popular?.books.map((b) => b.name)).not.toContain('acd_study');
    expect(popular?.books.map((b) => b.name)).not.toContain('trollope_warden');
  });

  it('filters by title in place, dropping empty sections, preserving order', () => {
    expect(names(catalogSections(CATALOG, 'hound'))).toEqual([
      { key: 'sherlock-holmes', books: ['acd_hound'] },
    ]);
    expect(names(catalogSections(CATALOG, 'the'))).toEqual([
      { key: 'sherlock-holmes', books: ['acd_hound'] },
      { key: 'barsetshire', books: ['trollope_warden'] },
      { key: 'popular', books: ['homer_odyssey'] },
    ]);
  });

  it('filters by author', () => {
    expect(names(catalogSections(CATALOG, 'trollope'))).toEqual([
      { key: 'barsetshire', books: ['trollope_warden', 'trollope_towers'] },
    ]);
  });

  it('a series-title match keeps the whole series', () => {
    expect(names(catalogSections(CATALOG, 'sherlock'))).toEqual([
      { key: 'sherlock-holmes', books: ['acd_study', 'acd_hound'] },
    ]);
  });

  it('a popular book hidden by the filter never migrates out of its series', () => {
    // "scarlet" matches only the series member acd_study; acd_hound (popular,
    // rank 2) matches nothing and must not appear in a popular block.
    expect(names(catalogSections(CATALOG, 'scarlet'))).toEqual([
      { key: 'sherlock-holmes', books: ['acd_study'] },
    ]);
  });

  it('returns no sections when nothing matches', () => {
    expect(catalogSections(CATALOG, 'zzz-no-such-book')).toEqual([]);
  });
});
