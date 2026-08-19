import { describe, expect, it } from 'vitest';
import { ebookPathToRepositoryName, extractXhtml, parsePackage } from '../src/index.js';
import { chapterXhtml, packageXml } from './fixtures.js';

describe('OPF and XHTML parsing', () => {
  it('extracts canonical metadata and spine order', () => {
    const parsed = parsePackage(packageXml);
    expect(parsed.metadata).toMatchObject({
      identifier: 'https://standardebooks.org/ebooks/test-author/test-book',
      title: 'Test Book',
      subtitle: 'A Tale',
      fullTitle: 'Test Book: A Tale',
      authors: ['Test Author'],
      translators: ['Test Translator'],
      wordCount: 42,
    });
    expect(parsed.spine.map(({ idref }) => idref)).toEqual([
      'titlepage.xhtml',
      'chapter-1.xhtml',
      'endnotes.xhtml',
    ]);
  });

  it('extracts belongs-to-collection declarations with type and position refinements', () => {
    const parsed = parsePackage(packageXml);
    expect(parsed.metadata.collections).toEqual([
      { title: 'Test Series', type: 'series', position: 3 },
      { title: 'Test Set', type: 'set', position: null },
      { title: 'Bare Collection', type: null, position: null },
    ]);
  });

  it('maps ebook URL paths to repository names (segments may contain underscores)', () => {
    expect(ebookPathToRepositoryName('/ebooks/mary-shelley/frankenstein')).toBe('mary-shelley_frankenstein');
    expect(ebookPathToRepositoryName('/ebooks/homer/the-odyssey/william-cullen-bryant')).toBe(
      'homer_the-odyssey_william-cullen-bryant',
    );
    expect(ebookPathToRepositoryName('/ebooks/leo-tolstoy/war-and-peace/louise-maude_aylmer-maude')).toBe(
      'leo-tolstoy_war-and-peace_louise-maude_aylmer-maude',
    );
    for (const bad of ['/ebooks/only-author', '/ebooks/a//b', '/other/a/b', 'a/b']) {
      expect(() => ebookPathToRepositoryName(bad)).toThrowError(/Not a Standard Ebooks ebook URL path/);
    }
  });

  it('ignores foreign-namespace impostors for meta, link, and identifier facts', () => {
    // Same local names, wrong namespace: none of these may become OPF facts.
    const impostors = `
      <evil:identifier xmlns:evil="urn:not-dc" id="decoy">urn:evil-identity</evil:identifier>
      <evil:link xmlns:evil="urn:not-opf" href="https://github.com/standardebooks/evil_repo" rel="schema:codeRepository"/>
      <evil:meta xmlns:evil="urn:not-opf" id="evil-collection" property="belongs-to-collection">Evil Series</evil:meta>
      <evil:meta xmlns:evil="urn:not-opf" property="collection-type" refines="#evil-collection">series</evil:meta>`;
    const parsed = parsePackage(packageXml.replace('</metadata>', `${impostors}</metadata>`));
    expect(parsed.metadata.identifier).toBe('https://standardebooks.org/ebooks/test-author/test-book');
    expect(parsed.metadata.repositoryUrl).toBe(
      'https://github.com/standardebooks/test-author_test-book_test-translator',
    );
    expect(parsed.metadata.collections.map(({ title }) => title)).not.toContain('Evil Series');

    // Independent pins: REPLACE each real fact with its foreign-namespace
    // impostor (same local name, id, and value) so each assertion fails on
    // its own if selection ever regresses to local-name-only lookup.
    const identifierReplaced = packageXml.replace(
      '<dc:identifier id="uid">https://standardebooks.org/ebooks/test-author/test-book</dc:identifier>',
      '<evil:identifier xmlns:evil="urn:not-dc" id="uid">https://standardebooks.org/ebooks/test-author/test-book</evil:identifier>',
    );
    expect(() => parsePackage(identifierReplaced)).toThrowError(/unique-identifier "uid" does not resolve/);

    const linkReplaced = packageXml.replace(
      '<link href="https://github.com/standardebooks/test-author_test-book_test-translator" rel="schema:codeRepository"/>',
      '<evil:link xmlns:evil="urn:not-opf" href="https://github.com/standardebooks/test-author_test-book_test-translator" rel="schema:codeRepository"/>',
    );
    expect(parsePackage(linkReplaced).metadata.repositoryUrl).toBeNull();
  });

  it('resolves the identifier through unique-identifier, never first-match', () => {
    // A decoy dc:identifier BEFORE the canonical one must not win.
    const decoyed = packageXml.replace(
      '<dc:identifier id="uid">',
      '<dc:identifier id="decoy">https://standardebooks.org/ebooks/decoy/book</dc:identifier><dc:identifier id="uid">',
    );
    expect(parsePackage(decoyed).metadata.identifier).toBe(
      'https://standardebooks.org/ebooks/test-author/test-book',
    );
    // A package whose unique-identifier does not resolve is rejected outright.
    expect(() => parsePackage(packageXml.replace('unique-identifier="uid"', 'unique-identifier="missing"'))).toThrowError(
      /unique-identifier "missing" does not resolve/,
    );
    expect(() => parsePackage(packageXml.replace(' unique-identifier="uid"', ''))).toThrowError(
      /declares no unique-identifier/,
    );
  });

  it('preserves prose boundaries and removes navigation markers', () => {
    const extracted = extractXhtml(chapterXhtml);
    expect(extracted.partition).toBe('bodymatter');
    expect(extracted.semanticTypes).toEqual(['bodymatter', 'z3998:fiction', 'chapter']);
    expect(extracted.title).toBe('Chapter I');
    expect(extracted.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');
    expect(extracted.text).not.toContain('1');
    expect(extracted.text).not.toContain('2');
  });
});
