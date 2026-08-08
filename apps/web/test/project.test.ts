/**
 * The project layer's pure foundation (commit 7b): the unified working-copy
 * data model, the ONE generation-spec builder shared by every origin, and the
 * statically-described built-in project. The stateful session controller (CAS
 * save, import assembly, reattachment) is tested separately.
 */
import { describe, expect, it } from 'vitest';
import {
  ASOIF,
  BUILTIN_ASOIF_ID,
  BUILTIN_CORPORA,
  BUILTIN_LOTR_ID,
  BUILTIN_SHERLOCK_ID,
  LOTR,
  builtinProjectData,
  builtinProject,
  generationSpecsFromProject,
  manifestForSave,
  overrideInputFromPersisted,
  ReadOnlyProjectError,
  userProjectFromManifest,
  SHERLOCK,
  sherlockProjectData,
  type ProjectDataV1,
} from '../src/lib/project.ts';
import {
  DEFAULT_STRUCTURE_RECIPE,
  buildDetectedSections,
  emptyOverride,
  hashStructureOverride,
  validateProjectManifest,
  type PersistedOverride,
  type ProjectManifestV1,
} from '@texttrends/core';

/** A durable manifest built directly for validation — bypasses the guarded
 *  save path (which correctly rejects the built-in origin). */
const asManifest = (data: ProjectDataV1, revision: number): ProjectManifestV1 => ({ schema: 'texttrends/project/1', revision, ...data });

// THE production constructor — every assertion below covers the object the live
// app actually builds, so a mapping drift in sherlockProjectData fails here.
const builtin = () => sherlockProjectData();

describe('overrideInputFromPersisted', () => {
  it('passes none and active through; sends needs-review as none (never a stale active)', async () => {
    expect(overrideInputFromPersisted({ status: 'none' })).toEqual({ kind: 'none' });
    const value = emptyOverride('t', 'c', 'r');
    const hash = await hashStructureOverride(value);
    const active: PersistedOverride = { status: 'active', value, hash };
    expect(overrideInputFromPersisted(active)).toEqual({ kind: 'active', value, hash });
    const review: PersistedOverride = { status: 'needs-review', value, hash };
    expect(overrideInputFromPersisted(review)).toEqual({ kind: 'none' }); // NOT applied until rebased
  });
});

describe('the built-in Sherlock project', () => {
  it('materializes to a manifest that passes the deep durable validator (hashes/identities correct)', async () => {
    const data = await builtin();
    expect(data.id).toBe(BUILTIN_SHERLOCK_ID);
    expect(data.order).toEqual(SHERLOCK.map((s) => s.doc));
    // A statically-described built-in must be a fully valid manifest — this
    // proves the recipe/candidate hashes match the recipe VALUES (a recipe
    // change would fail here, not drift silently).
    await expect(validateProjectManifest(asManifest(data, 1))).resolves.toMatchObject({ id: BUILTIN_SHERLOCK_ID, revision: 1 });
  });

  it('the built-in origin can NEVER be materialized for a durable save', async () => {
    const data = await builtin();
    expect(() => manifestForSave(builtinProject(data))).toThrow(ReadOnlyProjectError);
  });

  it('carries the real book titles as presentation metadata — doc ids stay identity-only', async () => {
    const data = await builtin();
    expect(data.docs.map((d) => d.meta.title)).toEqual(SHERLOCK.map((s) => s.title));
    // Titles are presentation ("A Study in Scarlet"), never the raw doc id —
    // panels label documents via meta.title, so a doc-id leak regresses UUID
    // labels for user projects.
    for (const d of data.docs) expect(d.meta.title).not.toBe(d.doc);
  });

  it('every built-in doc is bundled, txt, no override', async () => {
    const data = await builtin();
    for (const doc of data.docs) {
      expect(doc.sourceAvailability).toBe('bundled');
      expect(doc.source.format).toBe('txt');
      expect(doc.source.kind).toBe('text');
      if (doc.source.kind !== 'text') throw new Error('built-in docs are text sources');
      expect(doc.source.encoding.detected).toBe('utf-8');
      expect(doc.structure.override).toEqual({ status: 'none' });
    }
  });
});

describe('the bundled demo corpus registry', () => {
  const fixtures = {
    [BUILTIN_SHERLOCK_ID]: SHERLOCK,
    [BUILTIN_ASOIF_ID]: ASOIF,
    [BUILTIN_LOTR_ID]: LOTR,
  } as const;

  it('materializes every demo as a valid read-only TXT manifest with corpus-qualified sources', async () => {
    for (const corpus of BUILTIN_CORPORA) {
      const data = await builtinProjectData(corpus.id);
      expect(data.id).toBe(corpus.id);
      expect(data.order).toEqual(fixtures[corpus.id].map((entry) => entry.doc));
      expect(data.docs.map((doc) => doc.sourceName)).toEqual(
        fixtures[corpus.id].map((entry) => `${corpus.sourceDirectory}/${entry.doc}`),
      );
      await expect(validateProjectManifest(asManifest(data, 1))).resolves.toMatchObject({ id: corpus.id });
    }
  });

  it('matches every shipped source byte-for-byte, including UTF-16 lengths and hashes', async () => {
    const { readFile } = await import('node:fs/promises');
    const { hashSourceBytes, hashText } = await import('@texttrends/core');
    for (const corpus of BUILTIN_CORPORA) {
      const data = await builtinProjectData(corpus.id);
      for (const doc of data.docs) {
        const bytes = await readFile(new URL(`../public/corpora/${doc.sourceName}.txt`, import.meta.url));
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        expect(bytes.byteLength, doc.doc).toBe(doc.source.byteLength);
        expect(decoded.length, doc.doc).toBe(doc.extraction.textLengthUtf16);
        expect(await hashSourceBytes(new Uint8Array(bytes)), doc.doc).toBe(doc.source.hash);
        expect(await hashText(decoded), doc.doc).toBe(doc.extraction.text);
      }
    }
  });

  it('keeps the private TXT demos structurally detectable with titled chapter boundaries', async () => {
    const { readFile } = await import('node:fs/promises');
    const expectedSections = {
      [BUILTIN_ASOIF_ID]: [73, 70, 82, 46, 73],
      [BUILTIN_LOTR_ID]: [24, 23, 21], // two Book headings plus 22/21/19 chapters
    } as const;

    for (const id of [BUILTIN_ASOIF_ID, BUILTIN_LOTR_ID] as const) {
      const data = await builtinProjectData(id);
      for (const [index, doc] of data.docs.entries()) {
        const bytes = await readFile(new URL(`../public/corpora/${doc.sourceName}.txt`, import.meta.url));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const detected = buildDetectedSections(text, [], DEFAULT_STRUCTURE_RECIPE).filter((section) => section.title !== undefined);
        const expected = expectedSections[id][index];
        if (expected === undefined) throw new Error(`missing expected section count for ${doc.doc}`);
        expect(detected, doc.doc).toHaveLength(expected);
        const chapters = detected.filter((section) => section.title!.startsWith('Chapter '));
        expect(chapters.length, doc.doc).toBeGreaterThan(0);
        expect(chapters.every((section) => /^Chapter \d+\. \S/.test(section.title!)), doc.doc).toBe(true);
      }
    }
  });
});

describe('generationSpecsFromProject', () => {
  it('maps the working copy to v4 specs in DECLARED order with expected identities', async () => {
    const data = await builtin();
    const specs = generationSpecsFromProject(data);
    expect(specs.map((s) => s.doc)).toEqual(SHERLOCK.map((s) => s.doc));
    const [first] = specs;
    const s0 = SHERLOCK[0]!;
    expect(first!.source).toMatchObject({ expectedHash: s0.sourceHash, byteLength: s0.bytes, format: 'txt', availability: 'bundled' });
    expect(first!.extraction).toMatchObject({ expectedText: s0.textHash, expectedTextLengthUtf16: s0.textLengthUtf16 });
    expect(first!.structure.override).toEqual({ kind: 'none' });
  });

  it('respects a reordered `order` and an active override', async () => {
    const base = await builtin();
    const value = emptyOverride(base.docs[0]!.extraction.text, base.docs[0]!.extraction.candidates, base.docs[0]!.structure.recipeHash);
    const hash = await hashStructureOverride(value);
    const data: ProjectDataV1 = {
      ...base,
      order: [...base.order].reverse(),
      docs: base.docs.map((d, i) => (i === 0 ? { ...d, structure: { ...d.structure, override: { status: 'active', value, hash } as PersistedOverride } } : d)),
    };
    const specs = generationSpecsFromProject(data);
    expect(specs.map((s) => s.doc)).toEqual([...base.order].reverse());
    const doc0Spec = specs.find((s) => s.doc === base.docs[0]!.doc)!;
    expect(doc0Spec.structure.override).toEqual({ kind: 'active', value, hash });
  });

  it('throws if `order` names a document not in `docs`', async () => {
    const base = await builtin();
    expect(() => generationSpecsFromProject({ ...base, order: [...base.order, 'ghost'] })).toThrow(/not in docs/);
  });
});

describe('manifest <-> user-project round trip', () => {
  it('a loaded manifest becomes a user project whose save materializes the next revision', async () => {
    const data = await builtin();
    const loaded = asManifest(data, 5);
    const project = userProjectFromManifest(loaded);
    expect(project).toEqual({ kind: 'user', data, baseRevision: 5 });
    // Save materializes baseRevision + 1 (the CAS target), same data.
    expect(manifestForSave(project)).toEqual({ ...loaded, revision: 6 });
  });
});
