import { describe, expect, it } from 'vitest';
import {
  defaultExtractionRecipes,
  type ExtractionRecipeProvisional,
} from '@texttrends/core';
import { extractSource, type ExtractionLimits } from '../src/extract-source.ts';
import { ExtractionFailure } from '../src/failure.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const LIMITS: ExtractionLimits = { maxTextUtf16PerDoc: 32 * 1024 * 1024, maxArchiveInflatedBytesPerDoc: 128 * 1024 * 1024 };
/** LIMITS with a small text cap, so cap tests never allocate megabytes. */
const capped = (maxTextUtf16PerDoc: number): ExtractionLimits => ({ ...LIMITS, maxTextUtf16PerDoc });
const recipes = await defaultExtractionRecipes();

describe('extractSource — the one extraction runtime', () => {
  it('runs the literal path (decode → extract) and returns the canonical artifact', async () => {
    const phases: string[] = [];
    const { artifact, text } = await extractSource(utf8('Hello world.'), recipes.txt, LIMITS, {
      onPhaseStart: (p) => phases.push(p),
    });
    expect(text).toBe('Hello world.');
    expect(artifact.schema).toBe('texttrends/extraction/1');
    expect(artifact.descriptor.kind).toBe('text');
    expect(phases).toEqual(['decode', 'extract']); // literal emits both phases
  });

  it('runs the transformed HTML path (extract only) and derives heading candidates', async () => {
    const phases: string[] = [];
    const { text, artifact } = await extractSource(
      utf8('<html><body><h1>Chapter One</h1><p>The body text.</p></body></html>'),
      recipes.html,
      LIMITS,
      { onPhaseStart: (p) => phases.push(p) },
    );
    expect(text).toContain('Chapter One');
    expect(text).toContain('The body text.');
    expect(artifact.descriptor.kind).toBe('markup');
    expect(artifact.candidates.some((c) => c.title === 'Chapter One')).toBe(true);
    expect(phases).toEqual(['extract']); // transformed has no decode phase
  });

  it('maps a core DecodeError to ExtractionFailure(DECODE_FAILED)', async () => {
    // UTF-16LE BOM followed by a lone high surrogate (0xD800) — ill-formed UTF-16.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0xd8]);
    await expect(extractSource(bytes, recipes.txt, LIMITS)).rejects.toMatchObject({
      name: 'ExtractionFailure',
      code: 'DECODE_FAILED',
    });
  });

  it('maps a malformed container to ExtractionFailure(PARSE_FAILED)', async () => {
    // Not a valid ZIP archive — the epub adapter rejects it.
    await expect(extractSource(utf8('not a zip'), recipes.epub, LIMITS)).rejects.toMatchObject({
      name: 'ExtractionFailure',
      code: 'PARSE_FAILED',
    });
  });

  it('enforces the literal text cap at the POST-DECODE boundary — no extract phase / finalize work runs', async () => {
    const tiny: ExtractionLimits = { maxTextUtf16PerDoc: 4, maxArchiveInflatedBytesPerDoc: 1024 };
    const phases: string[] = [];
    await expect(extractSource(utf8('way past four'), recipes.txt, tiny, { onPhaseStart: (p) => phases.push(p) })).rejects.toMatchObject({
      name: 'ExtractionFailure',
      code: 'CAP_EXCEEDED',
    });
    // Capped BEFORE the extract phase: only 'decode' was announced (moving the
    // check after finalize would leak an 'extract' phase and waste that work).
    expect(phases).toEqual(['decode']);
  });

  it('passes an opaque afterPhase throw through UNCHANGED (cancellation/supersession)', async () => {
    const SUPERSEDED = Symbol('superseded');
    await expect(
      extractSource(utf8('hello'), recipes.txt, LIMITS, {
        afterPhase: () => { throw SUPERSEDED; },
      }),
    ).rejects.toBe(SUPERSEDED);
  });

  it('propagates a non-domain exception UNCHANGED from the LITERAL path (not a domain code)', async () => {
    // A recipe that fails core validation throws RangeError. extractSource must
    // pass it through untouched; the engine (not this package) later classifies
    // it (a RangeError → REQUEST_INVALID; other faults → INTERNAL).
    const badRecipe = { ...recipes.txt, parser: { id: 'not-a-real-parser' } } as unknown as ExtractionRecipeProvisional;
    await expect(extractSource(utf8('hello'), badRecipe, LIMITS)).rejects.toBeInstanceOf(RangeError);
    await expect(extractSource(utf8('hello'), badRecipe, LIMITS)).rejects.not.toBeInstanceOf(ExtractionFailure);
  });

  it('propagates a non-domain exception UNCHANGED from the TRANSFORMED path (adapters map only their domain errors)', async () => {
    // An empty partitions set is structurally well-typed but the EPUB extractor
    // rejects it with a RangeError — a programming fault the adapter must NOT
    // swallow into PARSE_FAILED.
    const emptyPartitions = {
      ...recipes.epub,
      extractor: { ...recipes.epub.extractor, partitions: [] as string[] },
    } as unknown as ExtractionRecipeProvisional;
    const err = await extractSource(utf8('anything'), emptyPartitions, LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err).not.toBeInstanceOf(ExtractionFailure);
  });

  it('runs afterPhase at the phase boundary of the LITERAL path (decode → gate → extract)', async () => {
    const order: string[] = [];
    await extractSource(utf8('literal'), recipes.txt, LIMITS, {
      onPhaseStart: (p) => order.push(`start:${p}`),
      afterPhase: () => { order.push('gate'); },
    });
    expect(order).toEqual(['start:decode', 'gate', 'start:extract']);
  });

  it('runs afterPhase AFTER the adapter on the TRANSFORMED path, and passes its opaque throw through', async () => {
    const order: string[] = [];
    await extractSource(utf8('<h1>x</h1><p>body</p>'), recipes.html, LIMITS, {
      onPhaseStart: (p) => order.push(`start:${p}`),
      afterPhase: () => { order.push('gate'); },
    });
    // transformed: extract (adapter) → gate; no decode phase.
    expect(order).toEqual(['start:extract', 'gate']);

    // A supersession/cancellation thrown at the transformed gate returns unchanged.
    const SUPERSEDED = Symbol('superseded');
    await expect(
      extractSource(utf8('<h1>x</h1><p>body</p>'), recipes.html, LIMITS, {
        afterPhase: () => { throw SUPERSEDED; },
      }),
    ).rejects.toBe(SUPERSEDED);
  });

  it('caps HTML against the EXACT cleaned output, not raw length — collapsed whitespace far over the cap stays ACCEPTED', async () => {
    // Raw source is thousands of chars of whitespace, but clean() collapses the
    // run to ONE space: cleaned output is 'alpha beta' (10). Raw-length
    // accounting would wrongly reject this document; exact accounting accepts.
    const tiny = capped(16);
    const { text } = await extractSource(utf8(`<p>alpha${' '.repeat(4096)}beta</p>`), recipes.html, tiny);
    expect(text).toBe('alpha beta');
  });

  it('rejects HTML the moment the exact accumulated output crosses the cap at a segment JOIN (boundary pinned both ways)', async () => {
    // Two segments: 'aaaa' (4) + blank-line join (2) + heading segment 'bb' (2) = 8.
    const source = utf8('<p>aaaa</p><h1>bb</h1>');
    // Exactly at the cap: accepted, byte-identical text + candidate range.
    const at = await extractSource(source, recipes.html, capped(8));
    expect(at.text).toBe('aaaa\n\nbb');
    expect(at.artifact.candidates).toEqual([
      { kind: 'html-heading', level: 1, title: 'bb', chars: { start: 6, end: 8 } },
    ]);
    // One below: the SECOND flush (join + segment) crosses 7 → CAP_EXCEEDED,
    // thrown from the adapter's during-walk accounting (its message template),
    // not the runtime's outer defensive check.
    const err = await extractSource(source, recipes.html, capped(7)).catch((e) => e);
    expect(err).toMatchObject({ name: 'ExtractionFailure', code: 'CAP_EXCEEDED' });
    expect((err as Error).message).toMatch(/^html extracted text of /);
  });

  it('rejects one giant single HTML segment over the cap during its flush', async () => {
    const err = await extractSource(
      utf8(`<p>${'x'.repeat(5000)}</p>`),
      recipes.html,
      capped(1024),
    ).catch((e) => e);
    expect(err).toMatchObject({ name: 'ExtractionFailure', code: 'CAP_EXCEEDED' });
    expect((err as Error).message).toMatch(/^html extracted text of /);
  });

  it('emits byte-identical text and exact candidate ranges for a below-cap HTML document with headings', async () => {
    const { text, artifact } = await extractSource(
      utf8('<html><body><h1>One</h1><p>alpha</p><h2>Two</h2><p>beta</p></body></html>'),
      recipes.html,
      LIMITS,
    );
    expect(text).toBe('One\n\nalpha\n\nTwo\n\nbeta');
    expect(artifact.candidates).toEqual([
      { kind: 'html-heading', level: 1, title: 'One', chars: { start: 0, end: 10 } },
      { kind: 'html-heading', level: 2, title: 'Two', chars: { start: 12, end: 21 } },
    ]);
  });

  it('reaches the transformed gate ONLY after adapter success — an adapter DECODE failure short-circuits before it', async () => {
    // Ill-formed BOM-declared HTML (UTF-16LE BOM + a lone high surrogate): the
    // html adapter's source decode fails INSIDE the adapter, so the phase-boundary
    // gate is never reached. If the gate ran before the adapter, it would fire.
    let gateReached = false;
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0xd8]);
    await expect(
      extractSource(bytes, recipes.html, LIMITS, { afterPhase: () => { gateReached = true; } }),
    ).rejects.toMatchObject({ name: 'ExtractionFailure', code: 'DECODE_FAILED' });
    expect(gateReached).toBe(false); // pins gate-after-adapter AND the html DecodeError mapping
  });
});
