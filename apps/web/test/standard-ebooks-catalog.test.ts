/**
 * Schema/version invariants of the CHECKED-IN baked catalog artifact
 * (standard-ebooks-catalog.json). The adapter pins only the compile-time
 * shape; everything the app and the update script promise about the data —
 * exactly 100 popularity ranks, globally unique repository names in the
 * client's grammar, resolvable ordered series, canonical ordering, and no
 * unexpected keys (so book text/descriptions/covers can never leak into the
 * artifact) — is proven here against the real file.
 */
import { REPOSITORY_NAME } from '@texttrends/standard-ebooks';
import { describe, expect, it } from 'vitest';
import {
  STANDARD_EBOOKS_CATALOG,
  type CatalogBook,
} from '../src/lib/standard-ebooks-catalog.ts';

const catalog = STANDARD_EBOOKS_CATALOG;
const TOP_COUNT = 100;

const isTrimmedNonEmpty = (value: string) => value !== '' && value === value.trim();

describe('baked Standard Ebooks catalog artifact', () => {
  it('carries schema version 1, a valid ISO timestamp, and only expected sources', () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(new Date(catalog.generatedAt).toISOString()).toBe(catalog.generatedAt);
    expect(catalog.source.popularityUrl).toBe('https://standardebooks.org/ebooks?sort=popularity&per-page=48');
    for (const series of catalog.series) {
      expect(series.sourceUrl).toBe(`https://standardebooks.org/collections/${series.slug}`);
    }
  });

  it('has no unexpected keys anywhere (no text/descriptions/covers can leak in)', () => {
    expect(Object.keys(catalog).sort()).toEqual(['books', 'generatedAt', 'schemaVersion', 'series', 'source']);
    expect(Object.keys(catalog.source)).toEqual(['popularityUrl']);
    for (const book of catalog.books) {
      const keys = Object.keys(book).sort();
      expect(['author', 'name', 'popularityRank', 'title'].filter((k) => keys.includes(k))).toEqual(keys);
      expect(keys).toContain('name');
      expect(keys).toContain('title');
      expect(keys).toContain('author');
    }
    for (const series of catalog.series) {
      expect(Object.keys(series).sort()).toEqual(['members', 'slug', 'sourceUrl', 'title']);
      for (const member of series.members) {
        expect(Object.keys(member).sort()).toEqual(['name', 'position']);
      }
    }
  });

  it('holds exactly 100 distinct popularity ranks covering 1..100, first and in rank order', () => {
    const ranked = catalog.books.filter((b) => b.popularityRank !== undefined);
    expect(ranked.length).toBe(TOP_COUNT);
    expect(catalog.books.slice(0, TOP_COUNT)).toEqual(ranked);
    ranked.forEach((book, index) => expect(book.popularityRank).toBe(index + 1));
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

  it('ships exactly the configured series, in allowlist order', () => {
    // The generator's SERIES_SLUGS allowlist, pinned so a configuration
    // change is review-visible here rather than only in the script.
    expect(catalog.series.map((s) => s.slug)).toEqual(['sherlock-holmes', 'palliser']);
  });

  it('resolves every series member to exactly one book, uniquely positioned per series', () => {
    expect(catalog.series.length).toBeGreaterThan(0);
    const byName = new Map(catalog.books.map((b) => [b.name, b]));
    const slugs = new Set(catalog.series.map((s) => s.slug));
    expect(slugs.size).toBe(catalog.series.length);
    for (const series of catalog.series) {
      expect(isTrimmedNonEmpty(series.title)).toBe(true);
      expect(series.members.length).toBeGreaterThan(1);
      const positions = new Set(series.members.map((m) => m.position));
      expect(positions.size).toBe(series.members.length);
      for (const member of series.members) {
        expect(byName.has(member.name)).toBe(true);
        expect(Number.isFinite(member.position)).toBe(true);
        expect(member.position).toBeGreaterThan(0);
      }
      const sorted = [...series.members].sort((a, b) => a.position - b.position);
      expect(series.members).toEqual(sorted);
    }
  });

  it('orders series-only books canonically after the top 100', () => {
    const topNames = new Set(catalog.books.slice(0, TOP_COUNT).map((b) => b.name));
    const expected: string[] = [];
    for (const series of catalog.series) {
      for (const member of series.members) {
        if (!topNames.has(member.name) && !expected.includes(member.name)) expected.push(member.name);
      }
    }
    expect(catalog.books.slice(TOP_COUNT).map((b: CatalogBook) => b.name)).toEqual(expected);
    for (const book of catalog.books.slice(TOP_COUNT)) {
      expect('popularityRank' in book).toBe(false);
    }
  });
});
