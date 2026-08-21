/**
 * Schema/version invariants of the CHECKED-IN baked catalog artifact
 * (standard-ebooks-catalog.json). The adapter pins only the compile-time
 * shape; everything the app and the update script promise about the data —
 * exactly 1,000 popularity ranks, globally unique repository names in the
 * client's grammar, canonical ordering, and no unexpected keys (so book
 * text/descriptions/covers can never leak into the artifact) — is proven
 * here against the real file.
 */
import { REPOSITORY_NAME } from '@texttrends/standard-ebooks';
import { describe, expect, it } from 'vitest';
import catalogJson from '../src/lib/standard-ebooks-catalog.json';
import type { StandardEbooksCatalog } from '../src/lib/standard-ebooks-catalog.ts';

// The typed assignment IS the compile-time shape pin over the real artifact —
// the adapter now ships only the asset URL (fetched on demand), so the static
// structural check lives here instead.
const catalog: StandardEbooksCatalog = catalogJson;
const TOP_COUNT = 1_000;

const isTrimmedNonEmpty = (value: string) => value !== '' && value === value.trim();

describe('baked Standard Ebooks catalog artifact', () => {
  it('carries schema version 2, a valid ISO timestamp, and the expected source', () => {
    expect(catalog.schemaVersion).toBe(2);
    expect(new Date(catalog.generatedAt).toISOString()).toBe(catalog.generatedAt);
    expect(catalog.source.popularityUrl).toBe('https://standardebooks.org/ebooks?sort=popularity&per-page=48');
  });

  it('has no unexpected keys anywhere (no text/descriptions/covers can leak in)', () => {
    expect(Object.keys(catalog).sort()).toEqual(['books', 'generatedAt', 'schemaVersion', 'source']);
    expect(Object.keys(catalog.source)).toEqual(['popularityUrl']);
    for (const book of catalog.books) {
      expect(Object.keys(book).sort()).toEqual(['author', 'name', 'popularityRank', 'title']);
    }
  });

  it('holds exactly 1,000 books with distinct ranks covering 1..1,000 in order', () => {
    expect(catalog.books).toHaveLength(TOP_COUNT);
    catalog.books.forEach((book, index) => expect(book.popularityRank).toBe(index + 1));
  });

  it('lists globally unique repository names in the client grammar with real labels', () => {
    const names = catalog.books.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const book of catalog.books) {
      expect(book.name).toMatch(REPOSITORY_NAME);
      expect(isTrimmedNonEmpty(book.title)).toBe(true);
      expect(isTrimmedNonEmpty(book.author)).toBe(true);
    }
  });

});
