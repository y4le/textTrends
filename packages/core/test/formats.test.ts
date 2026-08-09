import { describe, expect, it } from 'vitest';
import {
  defineSourceFormats,
  isSourceFormat,
  sourceFormatForFilename,
  SOURCE_FORMATS,
  SOURCE_FORMAT_IDS,
  stripSourceExtension,
  type SourceFormat,
  type SourceFormatMetadata,
} from '../src/extract/formats.ts';
import { defaultExtractionRecipes, isValidSourceDescriptor } from '../src/extract/extraction.ts';

describe('the source-format catalog', () => {
  it('is exhaustive and self-consistent: ids match metadata keys, kinds agree', () => {
    expect([...SOURCE_FORMAT_IDS].sort()).toEqual(Object.keys(SOURCE_FORMATS).sort());
    // Pin each format's descriptor sourceKind to what its extractor actually
    // produces — a change here must be a deliberate, test-visible edit.
    const EXPECTED_KIND: Record<SourceFormat, SourceFormatMetadata['sourceKind']> = {
      txt: 'text', md: 'text', epub: 'container', html: 'markup',
    };
    for (const id of SOURCE_FORMAT_IDS) {
      const meta = SOURCE_FORMATS[id];
      expect(meta.extensions.length).toBeGreaterThan(0);
      expect(meta.sourceKind).toBe(EXPECTED_KIND[id]);
    }
  });

  it('descriptor admission uses the catalog sourceKind as its kind↔format authority', () => {
    const HASH = 'h'.repeat(64);
    const KINDS: SourceFormatMetadata['sourceKind'][] = ['text', 'container', 'markup'];
    const descriptorFor = (kind: string, format: SourceFormat): Record<string, unknown> =>
      kind === 'container'
        ? { kind, hash: HASH, byteLength: 5, format, container: { internalDecoding: 'utf-8-strict', documentCount: 1 } }
        : { kind, hash: HASH, byteLength: 5, format, encoding: { detected: 'utf-8', hadReplacementChars: false } };
    for (const format of SOURCE_FORMAT_IDS) {
      const right = SOURCE_FORMATS[format].sourceKind;
      expect(isValidSourceDescriptor(descriptorFor(right, format), HASH, format), `${format} admits ${right}`).toBe(true);
      for (const wrong of KINDS.filter((k) => k !== right)) {
        expect(isValidSourceDescriptor(descriptorFor(wrong, format), HASH, format), `${format} rejects ${wrong}`).toBe(false);
      }
    }
  });

  it('freezes the records and extension arrays (no runtime mutation)', () => {
    expect(Object.isFrozen(SOURCE_FORMATS)).toBe(true);
    expect(Object.isFrozen(SOURCE_FORMATS.md)).toBe(true);
    expect(Object.isFrozen(SOURCE_FORMATS.md.extensions)).toBe(true);
    expect(() => (SOURCE_FORMATS.md.extensions as string[]).push('.x')).toThrow();
  });

  it('isSourceFormat accepts exactly the catalog ids and rejects everything else', () => {
    for (const id of SOURCE_FORMAT_IDS) expect(isSourceFormat(id)).toBe(true);
    for (const bad of ['pdf', 'TXT', '', 'toString', 42, null, undefined, {}]) {
      expect(isSourceFormat(bad)).toBe(false);
    }
  });

  it('maps every declared extension to its format, case-insensitively; unknown → null', () => {
    for (const id of SOURCE_FORMAT_IDS) {
      for (const ext of SOURCE_FORMATS[id].extensions) {
        expect(sourceFormatForFilename(`Some Book${ext}`)).toBe(id);
        expect(sourceFormatForFilename(`Some Book${ext.toUpperCase()}`)).toBe(id);
      }
    }
    expect(sourceFormatForFilename('notes.pdf')).toBeNull();
    expect(sourceFormatForFilename('README')).toBeNull();
    expect(sourceFormatForFilename('archive.epub.bak')).toBeNull();
  });

  it('strips a known extension for a default title, else returns the name', () => {
    expect(stripSourceExtension('A Study in Scarlet.txt')).toBe('A Study in Scarlet');
    expect(stripSourceExtension('notes.MD')).toBe('notes');
    expect(stripSourceExtension('book.markdown')).toBe('book');
    expect(stripSourceExtension('page.xhtml')).toBe('page');
    expect(stripSourceExtension('plain-name')).toBe('plain-name');
    expect(stripSourceExtension('.txt')).toBe('.txt'); // stripping would empty it
  });

  it('defineSourceFormats rejects a case-insensitive extension collision', () => {
    const good = defineSourceFormats({
      a: { extensions: ['.a'], extractionKind: 'literal', sourceKind: 'text' },
      b: { extensions: ['.b'], extractionKind: 'literal', sourceKind: 'text' },
    });
    expect(Object.isFrozen(good)).toBe(true);
    const collide = (): Record<string, SourceFormatMetadata> =>
      defineSourceFormats({
        a: { extensions: ['.dup'], extractionKind: 'literal', sourceKind: 'text' },
        b: { extensions: ['.DUP'], extractionKind: 'transformed', sourceKind: 'markup' },
      });
    expect(collide).toThrow(/duplicate source-format extension/);
  });
});

describe('default extraction recipes agree with the catalog', () => {
  it('has a default recipe per format', async () => {
    const recipes = await defaultExtractionRecipes();
    for (const id of SOURCE_FORMAT_IDS) {
      const recipe = recipes[id as SourceFormat];
      expect(recipe.format).toBe(id);
    }
  });
});
