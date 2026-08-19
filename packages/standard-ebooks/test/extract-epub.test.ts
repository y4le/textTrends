import { describe, expect, it } from 'vitest';
import { extractEpub, StandardEbooksError } from '../src/index.js';
import { fixtureEpub } from './fixtures.js';

describe('extractEpub (catalog-independent EPUB reader)', () => {
  it('extracts body matter by default with metadata and section ranges', () => {
    const result = extractEpub(fixtureEpub());

    expect(result.selectedPartitions).toEqual(['bodymatter']);
    expect(result.metadata).toMatchObject({ title: 'Test Book', fullTitle: 'Test Book: A Tale' });
    // Only the one body-matter chapter is joined into `text`.
    expect(result.text).toBe('Chapter I\n\nFirst emphasized line.\nSecond line.');

    // Every spine document is reported in reading order; only the selected one
    // carries a range, and that range addresses exactly its slice of `text`.
    expect(result.sections.map((s) => s.partition)).toEqual([
      'frontmatter',
      'bodymatter',
      'backmatter',
    ]);
    const [front, body, back] = result.sections;
    expect(front!.includedInText).toBe(false);
    expect(front!.range).toBeNull();
    expect(back!.includedInText).toBe(false);
    expect(back!.range).toBeNull();
    expect(body!.includedInText).toBe(true);
    expect(body!.range).toEqual({ start: 0, end: result.text.length });
    expect(result.text.slice(body!.range!.start, body!.range!.end)).toBe(body!.text);
  });

  it('joins every requested partition with contiguous, text-addressing ranges', () => {
    const result = extractEpub(fixtureEpub(), {
      partitions: ['frontmatter', 'bodymatter', 'backmatter'],
    });

    const included = result.sections.filter((s) => s.includedInText);
    expect(included).toHaveLength(3);
    // Each range slices back to its own section text, and ranges are separated
    // by exactly the two-character blank-line join.
    let expectedStart = 0;
    for (const section of included) {
      expect(section.range).not.toBeNull();
      expect(section.range!.start).toBe(expectedStart);
      expect(result.text.slice(section.range!.start, section.range!.end)).toBe(section.text);
      expectedStart = section.range!.end + 2;
    }
  });

  it('is deterministic — identical bytes yield identical text and ranges', () => {
    const bytes = fixtureEpub();
    const a = extractEpub(bytes);
    const b = extractEpub(fixtureEpub());
    expect(b.text).toBe(a.text);
    expect(b.sections).toEqual(a.sections);
  });

  it('rejects non-EPUB bytes and empty partition lists', () => {
    expect(() => extractEpub(new Uint8Array([1, 2, 3, 4]))).toThrow(StandardEbooksError);
    expect(() => extractEpub(fixtureEpub(), { partitions: [] })).toThrow(RangeError);
  });
});
