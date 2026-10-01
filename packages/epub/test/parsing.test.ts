import { describe, expect, it } from 'vitest';
import { extractXhtml, parsePackage } from '../src/epub-reader.js';
import { chapterXhtml, packageXml } from './fixtures.js';

describe('OPF and XHTML parsing', () => {
  it('decodes XHTML entities and preserves visible structural boundaries', () => {
    const extracted = extractXhtml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <p>one&nbsp;two &mdash; don&rsquo;t</p><table><tr><td>left</td><th>right</th></tr></table>
      <details><summary>heading</summary>body</details><p hidden="">hidden</p><iframe>frame</iframe>
      <pre>first
<span>second</span>
third</pre></body></html>`);
    expect(extracted.text).toBe('one\u00a0two — don’t\n\nleft\n\nright\n\nheading\n\nbody\n\nfirst\nsecond\nthird');
  });

  it('accepts legal replacement characters despite XML parser warnings', () => {
    expect(extractXhtml('<html><body><p>literal \ufffd character</p></body></html>').text).toBe('literal \ufffd character');
  });

  it.each(['<html><body><p></body></html>', '<html><body>&unknown;</body></html>'])('maps parser failures to domain errors: %s', (source) => {
    expect(() => extractXhtml(source)).toThrowError(expect.objectContaining({ code: 'INVALID_EPUB' }));
  });

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
