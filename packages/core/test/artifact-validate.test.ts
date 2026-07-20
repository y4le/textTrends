/**
 * Deep artifact admission + V2 seam (engine-v4 consult, commit 6a). The
 * engine trusts these before admitting untrusted store records; they are the
 * ABI/identity authority beyond the IDB envelope check.
 */
import { describe, expect, it } from 'vitest';
import {
  ArtifactCorruptError,
  ManifestInvalidError,
  bindSectionId,
  buildDetectedSections,
  composeStructure,
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  deriveCandidatesFromText,
  defaultExtractionRecipes,
  emptyOverride,
  extractDocument,
  hashStructureCandidates,
  hashText,
  makeReadyDocument,
  scanMarkdownHeadings,
  structureHashOf,
  validateExtractionArtifact,
  validateProjectManifest,
  validateStructureArtifactV2,
} from '../src/index.ts';
import { BOOK_LIKE_MD } from './fixtures/md/book-like.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('deriveCandidatesFromText', () => {
  it('reproduces the same candidates cold extraction produced (no drift)', async () => {
    const { md } = await defaultExtractionRecipes();
    const cold = await extractDocument(utf8(BOOK_LIKE_MD), md);
    const warm = await deriveCandidatesFromText(BOOK_LIKE_MD, md);
    expect(warm.candidateHash).toBe(cold.artifact.candidateHash);
    expect(warm.candidates.map((c) => c.title)).toEqual(cold.artifact.candidates.map((c) => c.title));
  });

  it('txt yields no candidates', async () => {
    const { txt } = await defaultExtractionRecipes();
    const b = await deriveCandidatesFromText(BOOK_LIKE_MD, txt);
    expect(b.candidates).toEqual([]);
    expect(b.candidateHash).toBe(await hashStructureCandidates([]));
  });
});

describe('validateExtractionArtifact', () => {
  async function keyed() {
    const { md } = await defaultExtractionRecipes();
    const { artifact, text } = await extractDocument(utf8(BOOK_LIKE_MD), md);
    return { md, artifact, text, key: { source: artifact.source, recipe: artifact.recipe } };
  }

  it('admits a genuine artifact against its key and text', async () => {
    const { md, artifact, text, key } = await keyed();
    const admitted = await validateExtractionArtifact(artifact, key, md, text);
    expect(admitted.candidateHash).toBe(artifact.candidateHash);
  });

  it('rejects an artifact whose identity does not match its cache key', async () => {
    const { md, artifact, key } = await keyed();
    await expect(validateExtractionArtifact(artifact, { ...key, source: 'other' }, md)).rejects.toThrow(/cache key/);
    // A key.recipe that is not the hash the recipe produces (artifact carries
    // that same key.recipe) is caught by the recipe-agreement check.
    const tamperedKey = { source: key.source, recipe: 'wronghash' };
    const tamperedArtifact = { ...artifact, recipe: 'wronghash' };
    await expect(validateExtractionArtifact(tamperedArtifact, tamperedKey, md)).rejects.toThrow(/recipe/);
  });

  it('rejects a candidate ending beyond the declared text length (no text supplied)', async () => {
    const { md, artifact, key } = await keyed();
    const past = [{ kind: 'md-heading-atx' as const, level: 2, title: 'x', chars: { start: 0, end: artifact.textLengthUtf16 + 100 } }];
    const bad = { ...artifact, candidates: past, candidateHash: await hashStructureCandidates(past) };
    await expect(validateExtractionArtifact(bad, key, md)).rejects.toThrow(ArtifactCorruptError);
  });

  it('rejects a tampered candidate set whose hash no longer matches', async () => {
    const { md, artifact, key } = await keyed();
    const tampered = { ...artifact, candidates: [...artifact.candidates, { kind: 'md-heading-atx' as const, level: 2, title: 'Ghost', chars: { start: 0, end: 5 } }] };
    await expect(validateExtractionArtifact(tampered, key, md)).rejects.toThrow(ArtifactCorruptError);
  });

  it('rejects a candidate set that no longer matches a fresh scan of the text', async () => {
    const { md, artifact, text, key } = await keyed();
    const alt = scanMarkdownHeadings('# Different\n\nprose').slice(0, 1);
    const wrong = { ...artifact, candidates: alt, candidateHash: await hashStructureCandidates(alt) };
    await expect(validateExtractionArtifact(wrong, key, md, text)).rejects.toThrow(/fresh scan/);
  });

  it('rejects schema and format disagreements', async () => {
    const { md, artifact, key } = await keyed();
    await expect(validateExtractionArtifact({ ...artifact, schema: 'x' }, key, md)).rejects.toThrow(ArtifactCorruptError);
    const { txt } = await defaultExtractionRecipes();
    await expect(validateExtractionArtifact(artifact, key, txt)).rejects.toThrow(ArtifactCorruptError); // md artifact, txt recipe
  });

  it('rejects impossible descriptor/evidence states (open encoding, disagreeing flag, nonzero count)', async () => {
    const { md, artifact, key } = await keyed();
    const badEnc = { ...artifact, descriptor: { ...artifact.descriptor, encoding: { detected: 'bogus', hadReplacementChars: false } } };
    await expect(validateExtractionArtifact(badEnc, key, md)).rejects.toThrow(ArtifactCorruptError);
    const disagree = { ...artifact, descriptor: { ...artifact.descriptor, encoding: { detected: 'utf-8', hadReplacementChars: true } } };
    await expect(validateExtractionArtifact(disagree, key, md)).rejects.toThrow(/disagrees|must be 0/);
    const nonzero = { ...artifact, evidence: { ...artifact.evidence, decoderReplacementCount: 1 } };
    await expect(validateExtractionArtifact(nonzero, key, md)).rejects.toThrow(/must be 0/);
    // Extra descriptor field.
    await expect(validateExtractionArtifact({ ...artifact, descriptor: { ...artifact.descriptor, extra: 1 } }, key, md)).rejects.toThrow(ArtifactCorruptError);
  });
});

describe('validateStructureArtifactV2', () => {
  const candidates = scanMarkdownHeadings(BOOK_LIKE_MD);
  const key = { text: 'th', candidates: 'ch', recipe: 'rh', override: 'oh' };
  const artifact = composeStructure(BOOK_LIKE_MD, candidates, DEFAULT_STRUCTURE_RECIPE, emptyOverride('t', 'c', 'r'), key);

  it('admits a genuine, canonically-ordered V2 artifact against its key and text length', async () => {
    const admitted = await validateStructureArtifactV2(artifact, key, BOOK_LIKE_MD.length);
    expect(admitted.sections.length).toBe(artifact.sections.length);
  });

  it('rejects a key mismatch, wrong text length, wrong schema, and extra fields', async () => {
    await expect(validateStructureArtifactV2(artifact, { ...key, text: 'other' }, BOOK_LIKE_MD.length)).rejects.toThrow(/cache key/);
    await expect(validateStructureArtifactV2(artifact, key, 10)).rejects.toThrow(ArtifactCorruptError);
    await expect(validateStructureArtifactV2({ ...artifact, schema: 'texttrends/structure/1' }, key, BOOK_LIKE_MD.length)).rejects.toThrow(/schema/);
    await expect(validateStructureArtifactV2({ ...artifact, extra: 1 }, key, BOOK_LIKE_MD.length)).rejects.toThrow(/unexpected/);
  });

  it('rejects a non-canonical (reversed) section order that would acquire a foreign hash', async () => {
    const reversed = { ...artifact, sections: [...artifact.sections].reverse() };
    await expect(validateStructureArtifactV2(reversed, key, BOOK_LIKE_MD.length)).rejects.toThrow(/canonical order/);
  });

  it('rejects an EXTRA field on a section record (it would change the hash)', async () => {
    const withExtra = { ...artifact, sections: artifact.sections.map((s, i) => (i === 0 ? { ...s, extra: 1 } : s)) };
    await expect(validateStructureArtifactV2(withExtra, key, BOOK_LIKE_MD.length)).rejects.toThrow(/unexpected shape/);
    const withExtraChars = { ...artifact, sections: artifact.sections.map((s, i) => (i === 0 ? { ...s, chars: { ...s.chars, extra: 1 } } : s)) };
    await expect(validateStructureArtifactV2(withExtraChars, key, BOOK_LIKE_MD.length)).rejects.toThrow(ArtifactCorruptError);
  });

  it('rejects a non-plain wrapper (custom prototype / accessor) that would fail canonical hashing', async () => {
    const proto = Object.create({ inherited: 1 });
    Object.assign(proto, artifact);
    await expect(validateStructureArtifactV2(proto, key, BOOK_LIKE_MD.length)).rejects.toThrow(/unexpected shape/);
    const withGetter: Record<string, unknown> = { ...artifact };
    Object.defineProperty(withGetter, 'text', { get: () => key.text, enumerable: true });
    await expect(validateStructureArtifactV2(withGetter, key, BOOK_LIKE_MD.length)).rejects.toThrow(/unexpected shape/);
  });
});

describe('bindSectionId', () => {
  it('is deterministic and depends on doc + lineage key, NOT the structure hash', async () => {
    const a = await bindSectionId('doc-1', 'sec-0001');
    expect(a).toBe(await bindSectionId('doc-1', 'sec-0001'));
    expect(a).not.toBe(await bindSectionId('doc-2', 'sec-0001')); // doc matters
    expect(a).not.toBe(await bindSectionId('doc-1', 'sec-0002')); // key matters
  });
});

describe('makeReadyDocument with a V2 structure', () => {
  it('hashes a V2 artifact via structureHashOf and binds it to the shard text', async () => {
    const { md } = await defaultExtractionRecipes();
    const { artifact: extraction, text } = await extractDocument(utf8('# Title\n\nbody text here'), md);
    const { createDocumentIndex, segment } = await import('../src/index.ts');
    const shard = await createDocumentIndex(text, await segment(text, 'en'), DEFAULT_INDEX_RECIPE);
    const candidates = await deriveCandidatesFromText(text, md);
    const structure = composeStructure(text, candidates.candidates, DEFAULT_STRUCTURE_RECIPE, emptyOverride(shard.text, extraction.candidateHash, 'rh'), {
      text: shard.text, candidates: extraction.candidateHash, recipe: 'rh', override: 'oh',
    });
    // Bind the V2 artifact's own text identity to the shard.
    const v2 = { ...structure, text: shard.text };
    const ready = await makeReadyDocument('d' as never, shard, v2 as never);
    expect(ready.structure).toBe(await structureHashOf(v2 as never));
  });
});

describe('validateProjectManifest', () => {
  // The doc's extraction/structure identities the override status is judged
  // against: text='th', candidates='ch', structureRecipeHash='sr'.
  async function manifest() {
    const { md } = await defaultExtractionRecipes();
    return {
      schema: 'texttrends/project/1', id: 'proj-1', revision: 1, order: ['d1'],
      docs: [{
        doc: 'd1', sourceName: 'book.md',
        meta: { title: 'Book', language: 'en', tags: [] },
        source: { hash: 'sh', byteLength: 10, format: 'md', encoding: { detected: 'utf-8', hadReplacementChars: false } },
        sourceAvailability: 'persisted',
        extraction: { recipe: md, recipeHash: 'er', text: 'th', textLengthUtf16: 10, candidates: 'ch' },
        structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: 'sr', override: { status: 'none' } },
      }],
      indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: 'ir',
    };
  }
  const withOverride = (m: Record<string, unknown>, override: unknown): Record<string, unknown> => ({
    ...m,
    docs: (m.docs as Record<string, unknown>[]).map((d) => ({ ...d, structure: { ...(d.structure as object), override } })),
  });

  it('admits a well-formed manifest', async () => {
    expect((await validateProjectManifest(await manifest())).id).toBe('proj-1');
  });

  it('enforces a positive safe-integer revision and order/docs agreement', async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(validateProjectManifest({ ...(await manifest()), revision: bad }), String(bad)).rejects.toThrow(/revision/);
    }
    await expect(validateProjectManifest({ ...(await manifest()), order: ['d1', 'ghost'] })).rejects.toThrow(ManifestInvalidError);
    const m = await manifest();
    await expect(validateProjectManifest({ ...m, order: ['d1', 'd1'], docs: [...m.docs, m.docs[0]] })).rejects.toThrow(ManifestInvalidError);
  });

  it('rejects negative/fractional source and text quantities (they feed the cap preflight)', async () => {
    const m = await manifest();
    const badSource = { ...m, docs: [{ ...m.docs[0], source: { ...(m.docs[0] as { source: object }).source, byteLength: -10 } }] };
    await expect(validateProjectManifest(badSource)).rejects.toThrow(ManifestInvalidError);
    const badText = { ...m, docs: [{ ...m.docs[0], extraction: { ...(m.docs[0] as { extraction: object }).extraction, textLengthUtf16: 1.5 } }] };
    await expect(validateProjectManifest(badText)).rejects.toThrow(ManifestInvalidError);
  });

  it('enforces the §12.6 override-status invariant against the doc identities', async () => {
    const m = await manifest();
    // active with matching base identities is admitted.
    const goodActive = withOverride(m, { status: 'active', value: emptyOverride('th', 'ch', 'sr'), hash: 'h' });
    expect((await validateProjectManifest(goodActive)).id).toBe('proj-1');
    // active whose base text differs is rejected (would apply a stale patch).
    const staleActive = withOverride(m, { status: 'active', value: emptyOverride('OTHER', 'ch', 'sr'), hash: 'h' });
    await expect(validateProjectManifest(staleActive)).rejects.toThrow(/active override base identities/);
    // needs-review that STILL matches is rejected (should be active).
    const wrongReview = withOverride(m, { status: 'needs-review', value: emptyOverride('th', 'ch', 'sr'), hash: 'h' });
    await expect(validateProjectManifest(wrongReview)).rejects.toThrow(/needs-review/);
    // needs-review that genuinely differs is admitted.
    const goodReview = withOverride(m, { status: 'needs-review', value: emptyOverride('STALE', 'ch', 'sr'), hash: 'h' });
    expect((await validateProjectManifest(goodReview)).id).toBe('proj-1');
    // active missing its hash is malformed.
    await expect(validateProjectManifest(withOverride(m, { status: 'active', value: emptyOverride('th', 'ch', 'sr') }))).rejects.toThrow(ManifestInvalidError);
  });

  it('is an EXACT total schema — extra fields at any level are rejected', async () => {
    const m = await manifest();
    await expect(validateProjectManifest({ ...m, extra: 1 })).rejects.toThrow(/unexpected/);
    await expect(validateProjectManifest({ ...m, docs: [{ ...m.docs[0], extra: 1 }] })).rejects.toThrow(/unexpected/);
    await expect(validateProjectManifest({ ...m, docs: [{ ...m.docs[0], meta: { title: 'x', language: 'en', tags: [], extra: 1 } }] })).rejects.toThrow(ManifestInvalidError);
  });

  it('order/docs/tags must be DENSE arrays with no smuggled properties', async () => {
    const m = await manifest();
    const namedTags: string[] = [];
    (namedTags as unknown as Record<string, unknown>).ns = 'x'; // named array property
    await expect(validateProjectManifest({ ...m, docs: [{ ...m.docs[0], meta: { title: 'x', language: 'en', tags: namedTags } }] })).rejects.toThrow(ManifestInvalidError);
    const accessorOrder = ['d1'];
    Object.defineProperty(accessorOrder, 0, { get: () => 'd1', enumerable: true, configurable: true });
    await expect(validateProjectManifest({ ...m, order: accessorOrder })).rejects.toThrow(ManifestInvalidError);
  });

  it('a nested recipe fault still throws ManifestInvalidError (total contract)', async () => {
    const m = await manifest();
    const badRecipe = { ...m, docs: [{ ...m.docs[0], extraction: { ...(m.docs[0] as { extraction: object }).extraction, recipe: { schema: 'texttrends/extraction-recipe/0-provisional', format: 'md', decoder: {}, parser: {} } } }] };
    await expect(validateProjectManifest(badRecipe)).rejects.toThrow(ManifestInvalidError);
  });
});
