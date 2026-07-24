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
  epubExtractionRecipe,
  extractDocument,
  finalizeExtraction,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashSourceBytes,
  hashStructureCandidates,
  hashStructureOverride,
  hashStructureRecipe,
  hashText,
  makeReadyDocument,
  scanMarkdownHeadings,
  structureHashOf,
  upgradeStoredManifest,
  validateExtractionArtifact,
  validateProjectManifest,
  validateStructureArtifactV2,
  type PreparedExtraction,
  type StructureArtifactV2,
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
    // A text descriptor with hadReplacementChars:true is impossible under the
    // total-decode policy (the count is structurally zero → the flag is false).
    const disagree = { ...artifact, descriptor: { ...artifact.descriptor, encoding: { detected: 'utf-8', hadReplacementChars: true } } };
    await expect(validateExtractionArtifact(disagree, key, md)).rejects.toThrow(/descriptor invalid/);
    const nonzero = { ...artifact, evidence: { ...artifact.evidence, decoderReplacementCount: 1 } };
    await expect(validateExtractionArtifact(nonzero, key, md)).rejects.toThrow(/evidence invalid/);
    // Extra descriptor field.
    await expect(validateExtractionArtifact({ ...artifact, descriptor: { ...artifact.descriptor, extra: 1 } }, key, md)).rejects.toThrow(ArtifactCorruptError);
  });

  it('every finalizeExtraction result self-admits (literal AND transformed)', async () => {
    // Literal: a cold txt/md extraction admits against its own key + text.
    const { md } = await defaultExtractionRecipes();
    const lit = await extractDocument(utf8(BOOK_LIKE_MD), md);
    const litKey = { source: lit.artifact.source, recipe: lit.artifact.recipe };
    expect((await validateExtractionArtifact(lit.artifact, litKey, md, lit.text)).schema).toBe('texttrends/extraction/1');

    // Transformed: a container extraction the adapter would produce admits too —
    // the builder enforces the same ABI admission checks (Codex review §HIGH-2).
    const recipe = epubExtractionRecipe(['bodymatter']);
    const text = 'Chapter One\n\nThe body.';
    const bytes = utf8('PK epub');
    const hash = await hashSourceBytes(bytes);
    const prepared = {
      kind: 'transformed',
      source: { kind: 'container', hash, byteLength: bytes.length, format: 'epub', container: { internalDecoding: 'utf-8-strict', documentCount: 1 } },
      text,
      candidates: [{ kind: 'epub-section', level: 1, title: 'Chapter One', chars: { start: 0, end: 11 } }],
      evidence: { decoderReplacementCount: 0, suspiciousControlCount: 0 },
    } as unknown as PreparedExtraction;
    const tr = await finalizeExtraction(prepared, recipe);
    const trKey = { source: tr.artifact.source, recipe: tr.artifact.recipe };
    // A source-recipe artifact admits WITHOUT a text rescan (its candidates are
    // container-derived, not a function of the text).
    expect((await validateExtractionArtifact(tr.artifact, trKey, recipe, text)).descriptor.kind).toBe('container');
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

  it('GOLDEN: the StructureHash of a fixed V2 artifact is pinned — every persisted identity depends on it', async () => {
    // A hand-written artifact literal, deliberately NOT built by
    // composeStructure, so this pins the canonical serialization + hash alone.
    // If this test ever fails, every durable StructureHash (cache keys,
    // manifests, snapshots) moves: that is a SCHEMA/VERSION decision, never a
    // refactor side effect — bump the artifact schema instead of the pin.
    // `satisfies` (no cast): an unversioned change to the V2 persisted shape
    // fails HERE at compile time, so the golden guards both the shape and the
    // canonical hash.
    const artifact = {
      schema: 'texttrends/structure/2',
      text: 't',
      candidates: 'c',
      recipe: 'r',
      override: 'o',
      sections: [
        { key: 'root', origin: 'fixed', level: 0, chars: { start: 0, end: 27 } },
        { key: 'sec-0000', origin: 'heuristic', parent: 'root', level: 1, title: 'Chapter 1', chars: { start: 0, end: 27 } },
      ],
    } as const satisfies StructureArtifactV2;
    expect(await structureHashOf(artifact)).toBe(
      'd83bc30e9a686b804bada387b64ba5694b5b35016d30a9b81b3e772e13776a57',
    );
  });
});

describe('validateProjectManifest', () => {
  // Every claimed hash is now RECOMPUTED and verified (engine-v4 consult §Q3),
  // so the fixture carries REAL recipe/override hashes, not placeholders. The
  // doc's extraction identities the override status is judged against are the
  // real text/candidate identities of a genuine extraction of BOOK_LIKE_MD.
  async function realHashes() {
    const { md } = await defaultExtractionRecipes();
    const extraction = await extractDocument(utf8(BOOK_LIKE_MD), md);
    return {
      md,
      indexRecipeHash: await hashIndexRecipe(DEFAULT_INDEX_RECIPE),
      extractionRecipeHash: await hashExtractionRecipe(md),
      structureRecipeHash: await hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE),
      text: extraction.artifact.text,
      candidates: extraction.artifact.candidateHash,
      textLengthUtf16: extraction.artifact.textLengthUtf16,
    };
  }
  /** A persisted override with a REAL hash of its value. */
  async function persistedOverride(status: 'active' | 'needs-review', value: ReturnType<typeof emptyOverride>) {
    return { status, value, hash: await hashStructureOverride(value) };
  }
  async function manifest() {
    const h = await realHashes();
    return {
      schema: 'texttrends/project/1', id: 'proj-1', revision: 1, order: ['d1'],
      docs: [{
        doc: 'd1', sourceName: 'book.md',
        meta: { title: 'Book', language: 'en', tags: [] },
        source: { kind: 'text', hash: 'sh', byteLength: 10, format: 'md', encoding: { detected: 'utf-8', hadReplacementChars: false } },
        sourceAvailability: 'persisted',
        extraction: { recipe: h.md, recipeHash: h.extractionRecipeHash, text: h.text, textLengthUtf16: h.textLengthUtf16, candidates: h.candidates },
        structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: h.structureRecipeHash, override: { status: 'none' } },
      }],
      indexRecipe: DEFAULT_INDEX_RECIPE, indexRecipeHash: h.indexRecipeHash,
    };
  }
  const withOverride = (m: Record<string, unknown>, override: unknown): Record<string, unknown> => ({
    ...m,
    docs: (m.docs as Record<string, unknown>[]).map((d) => ({ ...d, structure: { ...(d.structure as object), override } })),
  });

  it('admits a well-formed manifest', async () => {
    expect((await validateProjectManifest(await manifest())).id).toBe('proj-1');
  });

  it('upgradeStoredManifest migrates a pre-container manifest, preserving revision + content', async () => {
    // Downgrade a current manifest to the shape a prior build persisted: no
    // source.kind, no recipe.candidateReconstruction, recipeHash over the old
    // recipe value.
    const m = (await manifest()) as Record<string, unknown>;
    const doc0 = (m.docs as Record<string, unknown>[])[0]!;
    const oldRecipe = { ...(doc0.extraction as { recipe: Record<string, unknown> }).recipe };
    delete oldRecipe.candidateReconstruction;
    const oldSource = { ...(doc0.source as Record<string, unknown>) };
    delete oldSource.kind;
    const old = {
      ...m,
      docs: [{
        ...doc0,
        source: oldSource,
        extraction: { ...(doc0.extraction as object), recipe: oldRecipe, recipeHash: await hashExtractionRecipe(oldRecipe as never) },
      }],
    };
    // The old shape FAILS current validation (proving the migration is needed)…
    await expect(validateProjectManifest(old)).rejects.toThrow(ManifestInvalidError);
    // …and the upgrade makes it admit, unchanged in revision + identity.
    const upgraded = await validateProjectManifest(await upgradeStoredManifest(old));
    expect(upgraded.revision).toBe(m.revision);
    const src = upgraded.docs[0]!.source;
    expect(src.kind).toBe('text');
    expect(upgraded.docs[0]!.extraction.recipe.candidateReconstruction).toBe('text');
    // Idempotent: a current-shape manifest is returned unchanged.
    expect(await validateProjectManifest(await upgradeStoredManifest(m))).toBeTruthy();

    // The upgrader must NEVER repair genuine corruption: a legacy record whose
    // recipeHash does not match its legacy recipe is left unchanged, so deep
    // validation still rejects it (Codex review).
    const oldDoc = (old.docs as Record<string, unknown>[])[0]!;
    const tampered = {
      ...old,
      docs: [{ ...oldDoc, extraction: { ...(oldDoc.extraction as object), recipeHash: 'tampered-legacy-claim' } }],
    };
    await expect(validateProjectManifest(await upgradeStoredManifest(tampered))).rejects.toThrow(ManifestInvalidError);
  });

  it('recomputes and enforces every claimed recipe/override hash', async () => {
    const m = await manifest();
    // A wrong index recipe hash is caught even though the recipe VALUE is valid.
    await expect(validateProjectManifest({ ...m, indexRecipeHash: 'wrong' })).rejects.toThrow(/indexRecipeHash/);
    const wrongExtraction = { ...m, docs: [{ ...m.docs[0], extraction: { ...(m.docs[0] as { extraction: object }).extraction, recipeHash: 'wrong' } }] };
    await expect(validateProjectManifest(wrongExtraction)).rejects.toThrow(/extraction recipeHash/);
    const wrongStructure = { ...m, docs: [{ ...m.docs[0], structure: { ...(m.docs[0] as { structure: object }).structure, recipeHash: 'wrong' } }] };
    await expect(validateProjectManifest(wrongStructure)).rejects.toThrow(/structure recipeHash/);
  });

  it('closes the detected-encoding union and enforces source/recipe format agreement', async () => {
    const m = await manifest();
    const badEnc = { ...m, docs: [{ ...m.docs[0], source: { ...(m.docs[0] as { source: object }).source, encoding: { detected: 'latin-1', hadReplacementChars: false } } }] };
    // Closed-encoding enforcement now flows through the shared descriptor guard
    // (one admission authority with the artifact boundary), so the message is
    // the uniform invalid-descriptor error rather than an encoding-specific one.
    await expect(validateProjectManifest(badEnc)).rejects.toThrow(ManifestInvalidError);
    // Source claims txt while the extraction recipe is md — inconsistent.
    const badFormat = { ...m, docs: [{ ...m.docs[0], source: { ...(m.docs[0] as { source: object }).source, format: 'txt' } }] };
    await expect(validateProjectManifest(badFormat)).rejects.toThrow(/format disagrees/);
  });

  it('rejects a durable descriptor asserting hadReplacementChars:true — impossible at the artifact boundary (descriptor-admission parity)', async () => {
    // The manifest and the extraction-artifact boundary must admit exactly the
    // same descriptors; the implemented decoders never insert replacements, so
    // `hadReplacementChars` is structurally false. A hand-rolled manifest arm
    // used to accept `true`, letting a durable record assert a descriptor the
    // artifact boundary rejects.
    const m = await manifest();
    const replaced = { ...m, docs: [{ ...m.docs[0], source: { ...(m.docs[0] as { source: object }).source, encoding: { detected: 'utf-8', hadReplacementChars: true } } }] };
    await expect(validateProjectManifest(replaced)).rejects.toThrow(ManifestInvalidError);
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

  it('enforces the §12.6 override-status invariant AND the override hash', async () => {
    const m = await manifest();
    const h = await realHashes();
    // active with matching base identities and a real hash is admitted.
    const goodActive = withOverride(m, await persistedOverride('active', emptyOverride(h.text, h.candidates, h.structureRecipeHash)));
    expect((await validateProjectManifest(goodActive)).id).toBe('proj-1');
    // active whose base text differs is rejected (would apply a stale patch).
    const staleActive = withOverride(m, await persistedOverride('active', emptyOverride('OTHER', h.candidates, h.structureRecipeHash)));
    await expect(validateProjectManifest(staleActive)).rejects.toThrow(/active override base identities/);
    // needs-review that STILL matches is rejected (should be active).
    const wrongReview = withOverride(m, await persistedOverride('needs-review', emptyOverride(h.text, h.candidates, h.structureRecipeHash)));
    await expect(validateProjectManifest(wrongReview)).rejects.toThrow(/needs-review/);
    // needs-review that genuinely differs is admitted — but its hash is still
    // verified (an inactive correction must not carry a false identity).
    const goodReview = withOverride(m, await persistedOverride('needs-review', emptyOverride('STALE', h.candidates, h.structureRecipeHash)));
    expect((await validateProjectManifest(goodReview)).id).toBe('proj-1');
    // A correct status/base but a WRONG hash is rejected for both statuses.
    const badHashActive = withOverride(m, { status: 'active', value: emptyOverride(h.text, h.candidates, h.structureRecipeHash), hash: 'wrong' });
    await expect(validateProjectManifest(badHashActive)).rejects.toThrow(/override hash/);
    const badHashReview = withOverride(m, { status: 'needs-review', value: emptyOverride('STALE', h.candidates, h.structureRecipeHash), hash: 'wrong' });
    await expect(validateProjectManifest(badHashReview)).rejects.toThrow(/override hash/);
    // active missing its hash is malformed.
    await expect(validateProjectManifest(withOverride(m, { status: 'active', value: emptyOverride(h.text, h.candidates, h.structureRecipeHash) }))).rejects.toThrow(ManifestInvalidError);
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
