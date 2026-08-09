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
  ReadOnlyProjectError,
  userProjectFromManifest,
  SHERLOCK,
  sherlockProjectData,
  type ProjectDataV1,
} from '../src/lib/project.ts';
import {
  validateProjectManifest,
  type ProjectManifestV2,
} from '@texttrends/core';

/** A durable manifest built directly for validation — bypasses the guarded
 *  save path (which correctly rejects the built-in origin). */
const asManifest = (data: ProjectDataV1, revision: number): ProjectManifestV2 => ({ schema: 'texttrends/project/2', revision, ...data });

// THE production constructor — every assertion below covers the object the live
// app actually builds, so a mapping drift in sherlockProjectData fails here.
const builtin = () => sherlockProjectData();

describe('the built-in Sherlock project', () => {
  it('materializes to a manifest that passes the deep durable validator (hashes/identities correct)', async () => {
    const data = await builtin();
    expect(data.id).toBe(BUILTIN_SHERLOCK_ID);
    expect(data.order).toEqual(SHERLOCK.map((s) => s.doc));
    // A statically-described built-in must be a fully valid manifest — this
    // proves the recipe hashes match the recipe values (a recipe
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

  it('every built-in doc is bundled TXT', async () => {
    const data = await builtin();
    for (const doc of data.docs) {
      expect(doc.sourceAvailability).toBe('bundled');
      expect(doc.source.format).toBe('txt');
      expect(doc.source.kind).toBe('text');
      if (doc.source.kind !== 'text') throw new Error('built-in docs are text sources');
      expect(doc.source.encoding.detected).toBe('utf-8');
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
  });

  it('respects a reordered `order`', async () => {
    const base = await builtin();
    const data: ProjectDataV1 = {
      ...base,
      order: [...base.order].reverse(),
    };
    const specs = generationSpecsFromProject(data);
    expect(specs.map((s) => s.doc)).toEqual([...base.order].reverse());
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
