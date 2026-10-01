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
