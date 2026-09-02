import { describe, expect, it } from 'vitest';
import { EpubError, extractEpub } from '../src/epub-reader.js';
import { fixtureEpub } from './fixtures.js';

describe('extractEpub', () => {
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
