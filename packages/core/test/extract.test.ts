/**
 * Extraction core — golden tests (ingest/structure plan, commit 2):
 * decoder policy (BOMs, strict UTF-8, total windows-1252 fallback, exact
 * newline preservation), evidence semantics, the fence-aware heading scan
 * over the committed fixtures, and extraction identity.
 */
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  INGEST_CAPS_V0,
  decodeDocumentSource,
  decodeSource,
  defaultExtractionRecipes,
  deriveCandidatesFromText,
  epubExtractionRecipe,
  extractDocument,
  finalizeExtraction,
  hashExtractionRecipe,
  hashSourceBytes,
  htmlExtractionRecipe,
  hashStructureCandidates,
  hashText,
  scanMarkdownHeadings,
  validateExtractionRecipe,
  windows1252TableHash,
  type PreparedExtraction,
} from '../src/index.ts';
import { BOOK_LIKE_MD } from './fixtures/md/book-like.ts';
import { TECHNICAL_MD } from './fixtures/md/technical.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('decode/finalize seam (honest progress split)', () => {
  it('composes to exactly what the monolithic extractDocument produces', async () => {
    const { md } = await defaultExtractionRecipes();
    const bytes = utf8(BOOK_LIKE_MD);
    const whole = await extractDocument(bytes, md);
    // The engine emits `decode` before this, then `extract` before finalize.
    const decoded = await decodeDocumentSource(bytes, md);
    const split = await finalizeExtraction({ kind: 'literal', decoded }, md);
    expect(split.text).toBe(whole.text);
    expect(split.artifact).toEqual(whole.artifact);
    // The decode phase already carries the source identity and byte length.
    expect(decoded.source).toBe(whole.artifact.source);
    expect(decoded.byteLength).toBe(bytes.length);
    expect(decoded.decoded.text).toBe(whole.text);
  });

  it('the decode phase gates ill-formed input before any candidate work', async () => {
    const { txt } = await defaultExtractionRecipes();
    // A BOM-declared UTF-8 with an invalid continuation byte fails in decode.
    await expect(decodeDocumentSource(Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]), txt)).rejects.toThrow(DecodeError);
  });
});

describe('INGEST_CAPS_V0 (§12.9)', () => {
  it('is the shared provisional cap constant with sane monotonic bounds', () => {
    expect(INGEST_CAPS_V0.schema).toBe('texttrends/ingest-caps/0-provisional');
    // A single file cannot exceed the whole-project byte guard, and per-doc
    // text cannot exceed the project text cap.
    expect(INGEST_CAPS_V0.maxSourceBytesPerFile).toBeLessThanOrEqual(INGEST_CAPS_V0.maxProjectSourceBytes);
    expect(INGEST_CAPS_V0.maxTextUtf16PerDoc).toBeLessThanOrEqual(INGEST_CAPS_V0.maxProjectTextUtf16);
    expect(INGEST_CAPS_V0.maxDocsPerProject).toBeGreaterThan(0);
  });
});

describe('decoder policy bom-utf8-windows1252-v1', () => {
  it('decodes plain UTF-8 strictly with no BOM', () => {
    const d = decodeSource(utf8('naïve — “quotes” 🎉'));
    expect(d.detected).toBe('utf-8');
    expect(d.text).toBe('naïve — “quotes” 🎉');
    expect(d.decoderReplacementCount).toBe(0);
  });

  it('honors and strips a UTF-8 BOM', () => {
    const d = decodeSource(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('after bom')]));
    expect(d.detected).toBe('utf-8-bom');
    expect(d.text).toBe('after bom');
  });

  it('honors UTF-16LE and UTF-16BE BOMs', () => {
    const le = [0xff, 0xfe];
    for (const ch of 'héllo') {
      const c = ch.charCodeAt(0);
      le.push(c & 0xff, c >> 8);
    }
    const dLE = decodeSource(Uint8Array.from(le));
    expect(dLE.detected).toBe('utf-16le-bom');
    expect(dLE.text).toBe('héllo');

    const be = [0xfe, 0xff];
    for (const ch of 'héllo') {
      const c = ch.charCodeAt(0);
      be.push(c >> 8, c & 0xff);
    }
    const dBE = decodeSource(Uint8Array.from(be));
    expect(dBE.detected).toBe('utf-16be-bom');
    expect(dBE.text).toBe('héllo');
  });

  it('NEVER reinterprets malformed BOM-declared data as windows-1252', () => {
    // UTF-8 BOM followed by an invalid UTF-8 sequence.
    expect(() => decodeSource(Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]))).toThrow(DecodeError);
    // UTF-16LE BOM with an odd byte length.
    expect(() => decodeSource(Uint8Array.from([0xff, 0xfe, 0x41]))).toThrow(DecodeError);
    // UTF-16LE BOM with a lone surrogate: the fatal decoder rejects it at
    // decode time (the well-formedness gate in extractDocument is the
    // belt-and-braces backstop for platforms that admit it).
    const lone = Uint8Array.from([0xff, 0xfe, 0x00, 0xd8]); // U+D800
    expect(() => decodeSource(lone)).toThrow(DecodeError);
  });

  it('UNSUPPORTED UTF-32 BOMs are DECODE_FAILED — both byte orders, never fallback data', () => {
    // UTF-32LE's signature BEGINS with UTF-16LE's; UTF-32BE would otherwise
    // reach the total 1252 fallback (review finding).
    const utf32le = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
    expect(() => decodeSource(utf32le)).toThrow(/UTF-32LE/);
    const utf32be = Uint8Array.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]);
    expect(() => decodeSource(utf32be)).toThrow(/UTF-32BE/);
  });

  it('falls back to TOTAL windows-1252: euro at 0x80, C1 for undefined bytes, smart quotes', () => {
    const d = decodeSource(Uint8Array.from([0x80, 0x91, 0x92, 0x9d, 0xe9]));
    expect(d.detected).toBe('windows-1252');
    expect(d.text).toBe('€‘’é');
    expect(d.decoderReplacementCount).toBe(0); // the mapping is total
    expect(d.suspiciousControlCount).toBe(1);  // the C1 control at 0x9d
  });

  it('preserves every newline form exactly — offsets address text as decoded', () => {
    const d = decodeSource(utf8('a\r\nb\rc\nd e'));
    expect(d.text).toBe('a\r\nb\rc\nd e');
  });

  it('an intentional U+FFFD in valid UTF-8 is NOT data loss', () => {
    const d = decodeSource(utf8('ok � here'));
    expect(d.decoderReplacementCount).toBe(0);
    expect(d.text).toContain('�');
  });

  it('the windows-1252 table hash is stable (recipe identity)', async () => {
    expect(await windows1252TableHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(await windows1252TableHash()).toBe(await windows1252TableHash());
  });
});

describe('markdown-heading-scan-v1', () => {
  it('finds ATX and setext headings in the book-like fixture, in text order', () => {
    const c = scanMarkdownHeadings(BOOK_LIKE_MD);
    expect(c.map((x) => [x.level, x.title])).toEqual([
      [1, 'The Adventure of the Copper Manuscript'],
      [2, 'Chapter I. The Letter'],
      [2, 'Chapter II. The Visitor'],
      [3, "The Dealer's Account"],
    ]);
    // Anchors address the heading LINE exactly.
    for (const cand of c) {
      const line = BOOK_LIKE_MD.slice(cand.chars.start, cand.chars.end);
      expect(line).toContain(cand.title);
    }
  });

  it('never produces headings from code fences or front matter (technical fixture)', () => {
    const c = scanMarkdownHeadings(TECHNICAL_MD);
    expect(c.map((x) => [x.kind, x.level, x.title])).toEqual([
      ['md-heading-atx', 1, 'Field Notes on Corpus Tooling'],
      ['md-heading-atx', 2, 'Setup'],
      ['md-heading-atx', 2, 'Results'],
      ['md-heading-setext', 2, 'Setext headings also exist'],
    ]);
    // The fixture's fences contain shell comments; front matter contains
    // 'title:' — none may surface as candidates.
    expect(c.some((x) => x.title.includes('corpus, tooling'))).toBe(false);
  });

  it('handles fence false-positives, empty ATX, CRLF setext, and trailing hashes', () => {
    const text = [
      '```',
      '# not a heading',
      '```',
      '',
      '#',                       // empty ATX — no candidate
      '## Real Heading ##',      // trailing closing hashes stripped
      '',
      'CRLF Title\r',
      '===\r',
      '    # indented code, not a heading',
    ].join('\n');
    const c = scanMarkdownHeadings(text);
    expect(c.map((x) => [x.level, x.title])).toEqual([
      [2, 'Real Heading'],
      [1, 'CRLF Title'],
    ]);
    // The CRLF setext anchor excludes nothing mid-line and lands on the
    // underline's end.
    const setext = c[1]!;
    expect(text.slice(setext.chars.start, setext.chars.end)).toBe('CRLF Title\r\n===');
  });

  it('fence closure matches the OPENING marker: char and at-least length, marker-only line', () => {
    const text = [
      '````',
      '# hidden one',
      '```',              // shorter — does NOT close the ```` fence
      '# hidden two',
      '```js',            // info string — an opening shape, never a close
      '# hidden three',
      '`````',            // longer same-char marker-only — closes
      '# Real Heading',
      '~~~',
      '# tilde hidden',
      '```',              // wrong marker char — does not close ~~~
      '# still hidden',
      '~~~   ',           // trailing whitespace allowed on a close
      '## Also Real',
    ].join('\n');
    const c = scanMarkdownHeadings(text);
    expect(c.map((x) => x.title)).toEqual(['Real Heading', 'Also Real']);
  });

  it('candidate hashing is order-and-content sensitive', async () => {
    const a = await hashStructureCandidates(scanMarkdownHeadings(BOOK_LIKE_MD));
    const b = await hashStructureCandidates(scanMarkdownHeadings(TECHNICAL_MD));
    expect(a).not.toBe(b);
    expect(a).toBe(await hashStructureCandidates(scanMarkdownHeadings(BOOK_LIKE_MD)));
  });
});

describe('PreparedExtraction transformed path (container extraction)', () => {
  // A minimal, valid transformed EPUB input the adapter would produce.
  async function transformedEpub(overrides: {
    text?: string;
    candidates?: readonly { kind: string; level: number; title: string; chars: { start: number; end: number } }[];
    format?: string;
    documentCount?: number;
  } = {}): Promise<{ prepared: PreparedExtraction; recipe: ReturnType<typeof epubExtractionRecipe> }> {
    const text = overrides.text ?? 'Chapter One\n\nThe body of the chapter.';
    const bytes = utf8('PK pretend epub bytes');
    const hash = await hashSourceBytes(bytes);
    const prepared = {
      kind: 'transformed',
      source: {
        kind: 'container',
        hash,
        byteLength: bytes.length,
        format: overrides.format ?? 'epub',
        container: { internalDecoding: 'utf-8-strict', documentCount: overrides.documentCount ?? 1 },
      },
      text,
      candidates: overrides.candidates ?? [
        { kind: 'epub-section', level: 1, title: 'Chapter One', chars: { start: 0, end: 11 } },
      ],
      evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0 },
    } as unknown as PreparedExtraction;
    return { prepared, recipe: epubExtractionRecipe(['bodymatter']) };
  }

  it('builds a canonical artifact from adapter-supplied text + container candidates', async () => {
    const { prepared, recipe } = await transformedEpub();
    const { artifact, text } = await finalizeExtraction(prepared, recipe);
    expect(text).toBe('Chapter One\n\nThe body of the chapter.');
    expect(artifact.descriptor.kind).toBe('container');
    expect(artifact.text).toBe(await hashText(text));
    expect(artifact.recipe).toBe(await hashExtractionRecipe(recipe));
    expect(artifact.candidates[0]!.kind).toBe('epub-section');
    expect(artifact.candidateHash).toBe(await hashStructureCandidates(artifact.candidates));
  });

  it('rejects a transformed input paired with a text-reconstructed (md) recipe', async () => {
    const { md } = await defaultExtractionRecipes();
    const { prepared } = await transformedEpub();
    await expect(finalizeExtraction(prepared, md)).rejects.toThrow(/source-reconstructed recipe|disagrees/);
  });

  it('rejects an out-of-range candidate, a format disagreement, and ill-formed text', async () => {
    const recipe = epubExtractionRecipe(['bodymatter']);
    const past = await transformedEpub({ candidates: [{ kind: 'epub-section', level: 1, title: 'x', chars: { start: 0, end: 9999 } }] });
    await expect(finalizeExtraction(past.prepared, recipe)).rejects.toThrow(RangeError);
    const wrongFormat = await transformedEpub({ format: 'txt' });
    await expect(finalizeExtraction(wrongFormat.prepared, recipe)).rejects.toThrow(/descriptor is not a valid/);
    const illFormed = await transformedEpub({ text: '\uD800', candidates: [] });
    await expect(finalizeExtraction(illFormed.prepared, recipe)).rejects.toThrow(DecodeError);
  });

  it('rejects adversarial-but-otherwise-valid inputs the builder must NOT admit (exact-shape self-admission)', async () => {
    // Codex review: a builder must reject exactly what admission rejects, so an
    // extra descriptor/evidence field or a bogus encoding can never produce an
    // artifact that finalize accepts but validateExtractionArtifact rejects.
    const recipe = epubExtractionRecipe(['bodymatter']);
    const base = await transformedEpub();
    const withExtraDescriptorField = { ...base.prepared, source: { ...base.prepared.source, extra: 1 } };
    await expect(finalizeExtraction(withExtraDescriptorField as never, recipe)).rejects.toThrow(RangeError);
    const withExtraEvidenceField = { ...base.prepared, evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0, extra: 1 } };
    await expect(finalizeExtraction(withExtraEvidenceField as never, recipe)).rejects.toThrow(RangeError);
    // A markup (html) descriptor with a bogus detected encoding is inadmissible.
    const htmlRecipe = await htmlExtractionRecipe();
    const bogusEncoding = {
      kind: 'transformed',
      source: { kind: 'markup', hash: 'e'.repeat(64), byteLength: 3, format: 'html', encoding: { detected: 'klingon', hadReplacementChars: false } },
      text: 'abc',
      candidates: [],
      evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0 },
    };
    await expect(finalizeExtraction(bogusEncoding as never, htmlRecipe)).rejects.toThrow(RangeError);
  });
});

describe('epub extraction recipe + source-reconstruction guard', () => {
  it('epubExtractionRecipe validates and round-trips through validateExtractionRecipe', async () => {
    const recipe = epubExtractionRecipe(['bodymatter']);
    expect(recipe.format).toBe('epub');
    expect(recipe.candidateReconstruction).toBe('source');
    // A recipe hash is stable and order-independent (canonical).
    expect(await hashExtractionRecipe(recipe)).toBe(await hashExtractionRecipe(epubExtractionRecipe(['bodymatter'])));
  });

  it('deriveCandidatesFromText refuses a source-dependent (epub) recipe', async () => {
    await expect(deriveCandidatesFromText('# heading', epubExtractionRecipe())).rejects.toThrow(RangeError);
  });

  it('canonicalizes partitions so equivalent selections share one identity, and rejects non-canonical', async () => {
    // Order + duplicates do not change the operation → one recipe identity.
    const a = epubExtractionRecipe(['bodymatter', 'frontmatter']);
    const b = epubExtractionRecipe(['frontmatter', 'bodymatter', 'bodymatter']);
    expect(await hashExtractionRecipe(a)).toBe(await hashExtractionRecipe(b));
    // A hand-built non-canonical recipe (duplicate / wrong order) is rejected.
    const nonCanonical = {
      schema: 'texttrends/extraction-recipe/0-provisional',
      format: 'epub',
      extractor: { id: 'standard-ebooks-epub-v1', partitions: ['bodymatter', 'bodymatter'], serializer: 'xhtml-block-collapse-v1', sectioning: 'spine-order-v1' },
      candidateReconstruction: 'source',
    };
    await expect(validateExtractionRecipe(nonCanonical)).rejects.toThrow(/canonical/);
  });

  it('decodeDocumentSource refuses an epub recipe (no byte-decode path)', async () => {
    await expect(decodeDocumentSource(utf8('x'), epubExtractionRecipe())).rejects.toThrow(/transformed format/);
  });
});

describe('html extraction recipe + markup transformed finalize', () => {
  it('htmlExtractionRecipe validates and is source-reconstructed', async () => {
    const recipe = await htmlExtractionRecipe();
    expect(recipe.format).toBe('html');
    expect(recipe.candidateReconstruction).toBe('source');
    expect(await hashExtractionRecipe(recipe)).toBe(await hashExtractionRecipe(await htmlExtractionRecipe()));
  });

  it('a markup transformed input builds a self-consistent artifact', async () => {
    const recipe = await htmlExtractionRecipe();
    const text = 'Heading\n\nParagraph text about owls.';
    const bytes = utf8('<html><body><h1>Heading</h1><p>Paragraph text about owls.</p></body></html>');
    const hash = await hashSourceBytes(bytes);
    const prepared = {
      kind: 'transformed',
      source: { kind: 'markup', hash, byteLength: bytes.length, format: 'html', encoding: { detected: 'utf-8', hadReplacementChars: false } },
      text,
      candidates: [{ kind: 'html-heading', level: 1, title: 'Heading', chars: { start: 0, end: 7 } }],
      evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0 },
    } as unknown as PreparedExtraction;
    const { artifact } = await finalizeExtraction(prepared, recipe);
    expect(artifact.descriptor.kind).toBe('markup');
    expect(artifact.candidates[0]!.kind).toBe('html-heading');
    expect(artifact.candidateHash).toBe(await hashStructureCandidates(artifact.candidates));
  });

  it('deriveCandidatesFromText refuses an html recipe', async () => {
    await expect(deriveCandidatesFromText('<h1>x</h1>', await htmlExtractionRecipe())).rejects.toThrow(RangeError);
  });
});

describe('extractDocument', () => {
  it('produces a complete artifact with recipe-bound identities (md)', async () => {
    const { md } = await defaultExtractionRecipes();
    const bytes = utf8(BOOK_LIKE_MD);
    const { artifact, text } = await extractDocument(bytes, md);
    expect(text).toBe(BOOK_LIKE_MD);
    expect(artifact.schema).toBe('texttrends/extraction/1');
    expect(artifact.text).toBe(await hashText(BOOK_LIKE_MD));
    expect(artifact.textLengthUtf16).toBe(BOOK_LIKE_MD.length);
    expect(artifact.candidates.length).toBe(4);
    expect(artifact.candidateHash).toBe(await hashStructureCandidates(artifact.candidates));
    expect(artifact.descriptor.byteLength).toBe(bytes.length);
    expect(artifact.descriptor.kind).toBe('text');
    if (artifact.descriptor.kind !== 'text') throw new Error('expected a text descriptor');
    expect(artifact.descriptor.encoding.detected).toBe('utf-8');
    expect(artifact.descriptor.encoding.hadReplacementChars).toBe(false);
  });

  it('txt recipes scan nothing; same text under txt vs md differs ONLY in recipe/candidates', async () => {
    const { txt, md } = await defaultExtractionRecipes();
    const bytes = utf8(BOOK_LIKE_MD);
    const asTxt = await extractDocument(bytes, txt);
    const asMd = await extractDocument(bytes, md);
    expect(asTxt.artifact.candidates).toEqual([]);
    expect(asTxt.artifact.text).toBe(asMd.artifact.text);       // same TextHash
    expect(asTxt.artifact.source).toBe(asMd.artifact.source);   // same SourceHash
    expect(asTxt.artifact.recipe).not.toBe(asMd.artifact.recipe);
    expect(asTxt.artifact.candidateHash).not.toBe(asMd.artifact.candidateHash);
  });

  it('a BOM changes SourceHash but not TextHash', async () => {
    const { txt } = await defaultExtractionRecipes();
    const plain = await extractDocument(utf8('same text'), txt);
    const bom = await extractDocument(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('same text')]), txt);
    expect(plain.artifact.source).not.toBe(bom.artifact.source);
    expect(plain.artifact.text).toBe(bom.artifact.text);
  });

  it('rejects lone-surrogate UTF-16 at the well-formedness gate', async () => {
    const { txt } = await defaultExtractionRecipes();
    const lone = Uint8Array.from([0xff, 0xfe, 0x00, 0xd8]); // U+D800
    await expect(extractDocument(lone, txt)).rejects.toThrow(DecodeError);
  });

  it('rejects recipes describing operations the extractor does not perform', async () => {
    const { txt, md } = await defaultExtractionRecipes();
    const bytes = utf8('text');
    // format/parser mismatch (well-typed only via cast — wire callers
    // exist); the exact-key guard may fire before the combination check,
    // so assert the CLASS, which is the wire contract.
    await expect(
      extractDocument(bytes, { ...txt, format: 'md' } as never),
    ).rejects.toThrow(RangeError);
    await expect(
      extractDocument(bytes, { ...md, parser: { id: 'txt-literal-v1' } } as never),
    ).rejects.toThrow(RangeError);
    // A claimed table hash that is not the implemented table.
    await expect(
      extractDocument(bytes, { ...txt, decoder: { ...txt.decoder, windows1252TableHash: 'f'.repeat(64) } }),
    ).rejects.toThrow(/table hash/);
    // Unknown schema.
    await expect(
      extractDocument(bytes, { ...txt, schema: 'texttrends/extraction-recipe/9' } as never),
    ).rejects.toThrow(/schema/);
    // EXTRA FIELDS are rejected, not hashed into a second identity for the
    // same behavior (re-review finding) — at every level.
    await expect(
      extractDocument(bytes, { ...txt, decoder: { ...txt.decoder, ignoredPolicy: 'future-v1' } } as never),
    ).rejects.toThrow(RangeError);
    await expect(
      extractDocument(bytes, { ...txt, extra: true } as never),
    ).rejects.toThrow(RangeError);
    await expect(
      extractDocument(bytes, { ...txt, parser: { id: 'txt-literal-v1', extra: 1 } } as never),
    ).rejects.toThrow(RangeError);
    // Nullish and non-object inputs are RangeError (REQUEST_INVALID), never
    // a TypeError escaping the boundary.
    await expect(extractDocument(bytes, null as never)).rejects.toThrow(RangeError);
    await expect(extractDocument(bytes, undefined as never)).rejects.toThrow(RangeError);
    await expect(extractDocument(bytes, 'recipe' as never)).rejects.toThrow(RangeError);
    // NON-PLAIN objects: class instances, symbol extras, non-enumerable
    // extras, and getters are all outside the canonical domain (round 4).
    class RecipeLike {
      schema = txt.schema; format = txt.format; decoder = txt.decoder; parser = txt.parser;
    }
    await expect(extractDocument(bytes, new RecipeLike() as never)).rejects.toThrow(RangeError);
    const withSymbol = { ...txt, [Symbol('extra')]: 1 };
    await expect(extractDocument(bytes, withSymbol as never)).rejects.toThrow(RangeError);
    const withHidden = { ...txt };
    Object.defineProperty(withHidden, 'hidden', { value: 1, enumerable: false });
    await expect(extractDocument(bytes, withHidden as never)).rejects.toThrow(RangeError);
    const withGetter = { ...txt };
    Object.defineProperty(withGetter, 'format', { get: () => 'txt' });
    await expect(extractDocument(bytes, withGetter as never)).rejects.toThrow(RangeError);
  });
});
