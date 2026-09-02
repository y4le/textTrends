import { describe, expect, it } from 'vitest';
import { extractXhtml, parsePackage } from '../src/epub-reader.js';
import { chapterXhtml, packageXml } from './fixtures.js';

describe('OPF and XHTML parsing', () => {
  it('extracts canonical metadata, collections, and spine order', () => {
    const parsed = parsePackage(packageXml);
    expect(parsed.metadata).toMatchObject({
      identifier: 'urn:test:book',
      title: 'Test Book',
      subtitle: 'A Tale',
      fullTitle: 'Test Book: A Tale',
      authors: ['Test Author'],
      translators: ['Test Translator'],
      wordCount: 42,
      collections: [{ title: 'Test Series', type: 'series', position: 3 }],
    });
    expect(parsed.spine.map(({ idref }) => idref)).toEqual(['titlepage', 'chapter', 'endnotes']);
  });

  it('uses namespace identity for security-relevant OPF facts', () => {
    const decoyed = packageXml.replace(
      '<dc:identifier id="uid">',
      '<evil:identifier xmlns:evil="urn:not-dc" id="decoy">urn:evil</evil:identifier><dc:identifier id="uid">',
    );
    expect(parsePackage(decoyed).metadata.identifier).toBe('urn:test:book');

    const canonicalIdentifierReplaced = packageXml.replace(
      '<dc:identifier id="uid">urn:test:book</dc:identifier>',
      '<evil:identifier xmlns:evil="urn:not-dc" id="uid">urn:test:book</evil:identifier>',
    );
    expect(() => parsePackage(canonicalIdentifierReplaced)).toThrowError(
      /unique-identifier "uid" does not resolve/,
    );
  });

  it('preserves prose boundaries and removes navigation markers', () => {
    const extracted = extractXhtml(chapterXhtml);
    expect(extracted).toMatchObject({
      partition: 'bodymatter',
      semanticTypes: ['bodymatter', 'z3998:fiction', 'chapter'],
      title: 'Chapter I',
      text: 'Chapter I\n\nFirst emphasized line.\nSecond line.',
    });
  });
});
