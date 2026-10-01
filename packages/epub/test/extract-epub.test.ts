import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { EpubError, extractEpub } from '../src/epub-reader.js';
import { fixtureEpub } from './fixtures.js';

describe('extractEpub', () => {
  it('reads unannotated EPUB 2 and 3 linear spine content in order', () => {
    for (const version of ['2.0', '3.0']) {
      const files = unzipSync(fixtureEpub());
      files['epub/content.opf'] = strToU8(strFromU8(files['epub/content.opf']!).replace('version="3.0"', `version="${version}"`).replace('<itemref idref="endnotes"/>', '<itemref idref="endnotes" linear="no"/>'));
      for (const name of Object.keys(files).filter((key) => key.endsWith('.xhtml'))) {
        files[name] = strToU8(strFromU8(files[name]!).replace(/ epub:type="[^"]*"/gu, ''));
      }
      const result = extractEpub(zipSync(files));
      expect(result.text).toContain('Test Book\n\nChapter I');
      expect(result.text).not.toContain('A note.');
      expect(result.sections.map((section) => section.includedInText)).toEqual([true, true, false]);
    }
  });

  it('includes unclassified linear chapters when only front/back partitions are declared', () => {
    const files = unzipSync(fixtureEpub());
    files['epub/text/chapter.xhtml'] = strToU8(strFromU8(files['epub/text/chapter.xhtml']!).replace('epub:type="bodymatter z3998:fiction"', 'epub:type="chapter"'));
    const result = extractEpub(zipSync(files));
    expect(result.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');
    expect(result.sections.map((section) => section.includedInText)).toEqual([false, true, false]);
  });

  it('extracts metadata and body text while retaining spine ranges', () => {
    const result = extractEpub(fixtureEpub());

    expect(result.metadata).toMatchObject({
      identifier: 'urn:test:book',
      fullTitle: 'Test Book: A Tale',
      authors: ['Test Author'],
    });
    expect(result.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');
    expect(result.sections.map(({ partition }) => partition)).toEqual([
      'frontmatter',
      'bodymatter',
      'backmatter',
    ]);
    const [front, body, back] = result.sections;
    expect(front!.range).toBeNull();
    expect(back!.range).toBeNull();
    expect(body!.range).toEqual({ start: 0, end: result.text.length });
    expect(result.text.slice(body!.range!.start, body!.range!.end)).toBe(body!.text);
  });

  it('joins selected partitions with text-addressing ranges', () => {
    const result = extractEpub(fixtureEpub(), {
      partitions: ['frontmatter', 'bodymatter', 'backmatter'],
    });

    let expectedStart = 0;
    for (const section of result.sections) {
      expect(section.range!.start).toBe(expectedStart);
      expect(result.text.slice(section.range!.start, section.range!.end)).toBe(section.text);
      expectedStart = section.range!.end + 2;
    }
  });

  it('is deterministic across equivalent archive member orderings', () => {
    const forward = extractEpub(fixtureEpub());
    const reversed = extractEpub(fixtureEpub(true));

    expect(reversed).toEqual(forward);
  });

  it('distinguishes invalid input and caller option errors', () => {
    expect(() => extractEpub(new Uint8Array([1, 2, 3, 4]))).toThrow(EpubError);
    expect(() => extractEpub(fixtureEpub(), { partitions: [] })).toThrow(RangeError);
  });

  it('enforces the decompressed-text cap', () => {
    expect(() => extractEpub(fixtureEpub(), { maxExtractedBytes: 100 })).toThrowError(
      expect.objectContaining({ name: 'EpubError', code: 'CAP_EXCEEDED' }),
    );
  });
});

describe('bounded extraction pipeline', () => {
  function bookWithChapter(source: string) {
    const files = unzipSync(fixtureEpub());
    files['epub/text/chapter.xhtml'] = strToU8(source);
    return zipSync(files);
  }
  it('fails a selected output cap before parsing later spine content', () => {
    const files = unzipSync(bookWithChapter('<html><body xmlns:epub="http://www.idpf.org/2007/ops" epub:type="bodymatter"><p>' + 'a'.repeat(100) + '</p></body></html>'));
    files['epub/text/endnotes.xhtml'] = strToU8('<broken>');
    expect(() => extractEpub(zipSync(files), { maxTextUtf16: 10, retainSectionText: false }))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
  it('caps fallback output but does not reject excluded unknown text before declared body matter', () => {
    const files = unzipSync(fixtureEpub());
    files['epub/text/titlepage.xhtml'] = strToU8('<html><body><p>' + 'a'.repeat(100) + '</p></body></html>');
    const book = zipSync(files);
    expect(extractEpub(book, { maxTextUtf16: 60, retainSectionText: false }).text).toContain('First emphasized');
    files['epub/text/chapter.xhtml'] = strToU8('<html><body><p>chapter</p></body></html>');
    expect(() => extractEpub(zipSync(files), { maxTextUtf16: 60, retainSectionText: false }))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
  it('keeps metadata and ranges without retaining section text', () => {
    const result = extractEpub(fixtureEpub(), { retainSectionText: false });
    expect(result.sections.every((section) => section.text === '')).toBe(true);
    expect(result.sections[1]!.range).toEqual({ start: 0, end: result.text.length });
    expect(result.text).toContain('First emphasized');
  });
  it('enforces document and aggregate markup budgets before building DOMs', () => {
    const book = bookWithChapter('<html><body>' + '<p>a</p>'.repeat(100) + '</body></html>');
    expect(() => extractEpub(book, { maxMarkupPerDocument: 150 }))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    expect(() => extractEpub(fixtureEpub(), { maxMarkupTotal: 50 }))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    expect(() => extractEpub(fixtureEpub(), { maxDocumentBytes: 100 }))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
  it('rejects attribute-dense and oversized tags before DOM parsing', () => {
    const attributes = Array.from({ length: 257 }, (_, index) => `a${index}=""`).join(' ');
    const bare = Array.from({ length: 257 }, (_, index) => `a${index}`).join(' ');
    expect(() => extractEpub(bookWithChapter(`<html><body><p ${bare}>x</p></body></html>`)))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    expect(() => extractEpub(bookWithChapter(`<html><body><p ${attributes}>x</p></body></html>`)))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    expect(() => extractEpub(bookWithChapter(`<html><body><p title="${'x'.repeat(65_536)}">x</p></body></html>`)))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    const group = '<p ' + Array.from({ length: 250 }, (_, index) => `a${index}=""`).join(' ') + '>x</p>';
    expect(() => extractEpub(bookWithChapter('<html><body>' + group.repeat(201) + '</body></html>')))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
  });
  it('cannot hide attributes in missing spaces or malformed quotes', () => {
    const joined = Array.from({ length: 300 }, (_, index) => `a${index}=""`).join('');
    expect(() => extractEpub(bookWithChapter(`<html><body><p ${joined}>x</p></body></html>`)))
      .toThrowError(expect.objectContaining({ code: 'CAP_EXCEEDED' }));
    const hidden = Array.from({ length: 8_200 }, (_, index) => `a${index}=x`).join(' ');
    expect(() => extractEpub(bookWithChapter(`<html><body>${`<p a=b" ${hidden} c=d">x</p>`.repeat(16)}</body></html>`)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_EPUB' }));
  });
  it('rejects tag separators xmldom repairs into whitespace', () => {
    for (const separator of [0x80, 0x0b, 0x0c, 0x01, 0x85, 0x2028, 0x2029]) {
      const bare = Array.from({ length: 300 }, (_, index) => `a${index}`).join(String.fromCharCode(separator));
      expect(() => extractEpub(bookWithChapter(`<html><body><p ${bare}>x</p></body></html>`)))
        .toThrowError(expect.objectContaining({ code: 'INVALID_EPUB' }));
    }
  });
  it('ignores attribute-like text in quoted values, comments and CDATA', () => {
    const value = '='.repeat(300);
    const book = bookWithChapter(`<html><body><!-- ${value} --><p title="${value} >">visible</p><![CDATA[${value}]]></body></html>`);
    expect(extractEpub(book).text).toContain('visible');
  });
  it('extracts deep nesting without recursive serializer overflow', () => {
    const body = '<div>'.repeat(20_000) + '<p>visible</p>' + '</div>'.repeat(20_000);
    const result = extractEpub(bookWithChapter('<html><body>' + body + '</body></html>'));
    expect(result.text).toBe('visible');
  });
});
