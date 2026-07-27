/**
 * VerifiedText capability — weakening-risk suite (Phase D workstream D2).
 *
 * The capability's authentication is the module-private WeakMap, NOT the
 * TypeScript brand: every test here attacks the runtime mechanism (forged
 * objects, clones, claimed hashes, cross-document substitution, mutated
 * wrappers) and proves the fast lanes reject anything `verifyText` did not
 * mint, while the plain-string APIs keep their existing self-verifying
 * behavior. The performance contract (ONE text digest for a cold pipeline)
 * is proven by counting crypto.subtle.digest invocations whose input IS the
 * encoded text — the same spy seam as decode-table-hash.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId, TextHash } from '../src/contract/brands.ts';
import { hashText } from '../src/contract/hash.ts';
import * as verifiedTextModule from '../src/contract/verified-text.ts';
import { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from '../src/contract/verified-text.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { segment, segmentVerified } from '../src/segment/intl.ts';
import {
  createDocumentIndex,
  createDocumentIndexVerified,
  type DocumentIndexV1,
} from '../src/index/build.ts';
import { bindShards, bindTexts, bindTextsVerified, type BoundShards } from '../src/ops/binding.ts';
import { composeSnapshot, makeReadyDocument, type CorpusSnapshotV1 } from '../src/snapshot/compose.ts';
import { defaultExtractionRecipes, extractDocument } from '../src/extract/extraction.ts';
import { validateExtractionArtifact, validateExtractionArtifactVerified } from '../src/extract/validate.ts';
import { rootOnlyV2 } from './support/root-only-structure.ts';

/** Available in every supported runtime; core's ambient globals deliberately
 *  exclude it (environment-agnostic package), so the TEST declares it. */
declare const structuredClone: <T>(v: T) => T;

const R = DEFAULT_INDEX_RECIPE;
const GEN = 'g' as BuildGeneration;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A minimal bound world over plain-lane construction (the fixture, not the
 *  system under test — the verified lanes are attacked against it). */
async function boundWorld(texts: Record<string, string>): Promise<{
  snapshot: CorpusSnapshotV1;
  bound: BoundShards;
  shards: Map<string, DocumentIndexV1>;
}> {
  const shards = new Map<string, DocumentIndexV1>();
  const ready = new Map();
  const ids = Object.keys(texts) as ProjectDocId[];
  for (const id of ids) {
    const text = texts[id] as string;
    const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
    shards.set(id, shard);
    ready.set(id, await makeReadyDocument(id, shard, rootOnlyV2(text, shard.text)));
  }
  const snapshot = await composeSnapshot(GEN, ids, ready);
  const bound = await bindShards(snapshot, shards);
  return { snapshot, bound, shards };
}

/** Count digests whose input is EXACTLY the encoded text (other digests —
 *  recipes, fingerprints, artifact identities, source bytes — pass through
 *  uncounted; byte-equality is the discriminator). */
function spyTextDigests(text: string): { count: () => number } {
  const expected = utf8(text);
  const real = crypto.subtle.digest.bind(crypto.subtle);
  let count = 0;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(((alg, data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    if (bytes.length === expected.length && bytes.every((b, i) => b === expected[i])) count++;
    return real(alg, data);
  }) as typeof crypto.subtle.digest);
  return { count: () => count };
}

const TEXT = 'the wolf ran far over the hill';

describe('verifyText minting and accessors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mints a frozen capability whose accessors return the text and its true hash', async () => {
    const v = await verifyText(TEXT);
    expect(Object.isFrozen(v)).toBe(true);
    expect(verifiedTextOf(v)).toBe(TEXT);
    expect(verifiedHashOf(v)).toBe(await hashText(TEXT));
    // The wrapper carries NO public data fields — nothing to trust or tamper.
    expect(Object.keys(v)).toEqual([]);
  });

  it('accepts a correct expected hash and REJECTS claimed-hash substitution', async () => {
    const right = (await hashText(TEXT)) as TextHash;
    await expect(verifyText(TEXT, right)).resolves.toBeDefined();
    const wrong = (await hashText('other text')) as TextHash;
    await expect(verifyText(TEXT, wrong)).rejects.toThrow(RangeError);
  });

  it('rejects ill-formed UTF-16 exactly like the plain paths', async () => {
    const lone = 'ab\ud800cd';
    await expect(verifyText(lone)).rejects.toThrow(/ill-formed/);
    // Existing plain-path behavior preserved.
    await expect(segment(lone, 'en')).rejects.toThrow(/ill-formed/);
    const seg = await segment(TEXT, 'en');
    await expect(createDocumentIndex(lone, seg, R)).rejects.toThrow(/ill-formed/);
    const w = await boundWorld({ a: TEXT });
    await expect(bindTexts(w.snapshot, w.bound, new Map([['a', lone]]))).rejects.toThrow(/ill-formed/);
  });

  it('supports the empty text: an authentic empty capability reads back empty', async () => {
    const empty = await verifyText('');
    expect(verifiedTextOf(empty)).toBe('');
    expect(verifiedHashOf(empty)).toBe(await hashText(''));
    const batch = await segmentVerified(empty, 'en');
    expect(batch.text).toBe(verifiedHashOf(empty));
    expect(batch.startsUtf16.length).toBe(0);
  });

  it('mutation attempts on the frozen wrapper fail and never affect authenticated reads', async () => {
    const v = await verifyText(TEXT);
    expect(() => {
      (v as unknown as Record<string, unknown>).text = 'evil';
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(v, 'hash', { value: 'evil' })).toThrow(TypeError);
    expect(verifiedTextOf(v)).toBe(TEXT);
    expect(verifiedHashOf(v)).toBe(await hashText(TEXT));
  });
});

describe('forgery rejection (WeakMap authentication, not the type brand)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function forgeries(): Promise<Array<[string, VerifiedText]>> {
    const authentic = await verifyText(TEXT);
    const authenticEmpty = await verifyText('');
    return [
      ['plain object cast', {} as unknown as VerifiedText],
      ['structural imposter with data fields', { text: TEXT, hash: await hashText(TEXT) } as unknown as VerifiedText],
      ['frozen imposter', Object.freeze({}) as unknown as VerifiedText],
      ['spread copy of an authentic capability', { ...authentic } as VerifiedText],
      ['structuredClone of an authentic capability', structuredClone(authentic)],
      ['spread copy of the authentic EMPTY capability', { ...authenticEmpty } as VerifiedText],
      ['null-prototype imposter', Object.create(null) as VerifiedText],
    ];
  }

  it('verifiedTextOf and verifiedHashOf reject every forgery', async () => {
    for (const [name, forged] of await forgeries()) {
      expect(() => verifiedTextOf(forged), name).toThrow(/unauthenticated/);
      expect(() => verifiedHashOf(forged), name).toThrow(/unauthenticated/);
    }
  });

  it('segmentVerified rejects every forgery', async () => {
    for (const [name, forged] of await forgeries()) {
      await expect(segmentVerified(forged, 'en'), name).rejects.toThrow(/unauthenticated/);
    }
  });

  it('createDocumentIndexVerified rejects every forgery', async () => {
    const seg = await segment(TEXT, 'en');
    for (const [name, forged] of await forgeries()) {
      await expect(createDocumentIndexVerified(forged, seg, R), name).rejects.toThrow(/unauthenticated/);
    }
  });

  it('bindTextsVerified rejects every forgery', async () => {
    const w = await boundWorld({ a: TEXT });
    for (const [name, forged] of await forgeries()) {
      await expect(
        bindTextsVerified(w.snapshot, w.bound, new Map([['a', forged]])),
        name,
      ).rejects.toThrow(/unauthenticated/);
    }
  });

  it('validateExtractionArtifactVerified rejects every forgery', async () => {
    const recipes = await defaultExtractionRecipes();
    const doc = await extractDocument(utf8(TEXT), recipes.txt);
    const key = { source: doc.artifact.source, recipe: doc.artifact.recipe };
    for (const [name, forged] of await forgeries()) {
      await expect(
        validateExtractionArtifactVerified(doc.artifact, key, recipes.txt, forged),
        name,
      ).rejects.toThrow(/unauthenticated/);
    }
    // The authentic capability, by contrast, admits the artifact it describes.
    await expect(
      validateExtractionArtifactVerified(doc.artifact, key, recipes.txt, doc.verified),
    ).resolves.toBeDefined();
  });

  it('no exported API mints from a caller-claimed hash without hashing (module-surface proof)', () => {
    // The module exports EXACTLY the one factory and the two accessors —
    // there is no "trust this (text, hash) pair" constructor to reach.
    expect(Object.keys(verifiedTextModule).sort()).toEqual(['verifiedHashOf', 'verifiedTextOf', 'verifyText']);
    // Grep-prove the exported sources: only verifyText inserts into the
    // authentication store, and only AFTER hashText computed the digest
    // itself; the accessors are read-only.
    // The test transform may rename imported bindings, so match the call by
    // its function-name stem rather than an exact import spelling.
    const factory = verifiedTextModule.verifyText.toString();
    expect(factory).toMatch(/VERIFIED\.set\(/);
    expect(factory).toMatch(/await\s.*hashText.*\(text\)/);
    expect(factory.search(/await\s.*hashText.*\(text\)/)).toBeLessThan(factory.indexOf('VERIFIED.set('));
    for (const accessor of [verifiedTextModule.verifiedTextOf, verifiedTextModule.verifiedHashOf]) {
      expect(accessor.toString()).not.toMatch(/\.set\(/);
      expect(accessor.toString()).toMatch(/VERIFIED\.get\(/);
    }
  });
});

describe('verified fast-lane invariants beyond authentication', () => {
  afterEach(() => vi.restoreAllMocks());

  it('segmentVerified records the capability hash as the batch text identity and matches the plain lane', async () => {
    const v = await verifyText(TEXT);
    const fast = await segmentVerified(v, 'en');
    expect(fast.text).toBe(verifiedHashOf(v));
    const plain = await segment(TEXT, 'en');
    expect(fast.text).toBe(plain.text);
    expect([...fast.startsUtf16]).toEqual([...plain.startsUtf16]);
    expect([...fast.endsUtf16]).toEqual([...plain.endsUtf16]);
  });

  it('createDocumentIndexVerified REJECTS a mismatched intermediate (batch from different text)', async () => {
    const other = 'a completely different document';
    const batchOther = await segment(other, 'en');
    const v = await verifyText(TEXT);
    await expect(createDocumentIndexVerified(v, batchOther, R)).rejects.toThrow(
      /produced from a different text/,
    );
    // And produces the identical shard to the plain lane when the batch agrees.
    const fast = await createDocumentIndexVerified(v, await segmentVerified(v, 'en'), R);
    const plain = await createDocumentIndex(TEXT, await segment(TEXT, 'en'), R);
    expect(fast.text).toBe(plain.text);
    expect(fast.recipe).toBe(plain.recipe);
    expect([...fast.tokenTypeIds]).toEqual([...plain.tokenTypeIds]);
  });

  it('bindTextsVerified REJECTS an AUTHENTIC capability for a different document (cross-document substitution)', async () => {
    const otherText = 'a wolf slept elsewhere entirely';
    const w = await boundWorld({ a: TEXT, b: otherText });
    const verifiedB = await verifyText(otherText); // authentic, wrong document
    await expect(
      bindTextsVerified(w.snapshot, w.bound, new Map([['a', verifiedB]])),
    ).rejects.toThrow(/does not match the bound shard's text identity/);
    // The right capability binds.
    await expect(
      bindTextsVerified(w.snapshot, w.bound, new Map([['a', await verifyText(TEXT)]])),
    ).resolves.toBeDefined();
  });

  it('validateExtractionArtifactVerified still rejects a capability for other text and a length lie', async () => {
    const recipes = await defaultExtractionRecipes();
    const doc = await extractDocument(utf8(TEXT), recipes.txt);
    const key = { source: doc.artifact.source, recipe: doc.artifact.recipe };
    const otherVerified = await verifyText('some other text');
    await expect(
      validateExtractionArtifactVerified(doc.artifact, key, recipes.txt, otherVerified),
    ).rejects.toThrow(/does not describe the supplied text/);
    const lengthLie = { ...doc.artifact, textLengthUtf16: TEXT.length + 1 };
    await expect(
      validateExtractionArtifactVerified(lengthLie, key, recipes.txt, doc.verified),
    ).rejects.toThrow(/does not describe the supplied text/);
    // The plain entry (self-verifying) still admits with the raw string.
    await expect(validateExtractionArtifact(doc.artifact, key, recipes.txt, TEXT)).resolves.toBeDefined();
  });
});

describe('performance contract: ONE text digest per pipeline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cold pipeline (extract → segment → index → bind) digests the text EXACTLY once via the verified lanes', async () => {
    const recipes = await defaultExtractionRecipes(); // prime table-hash memo pre-spy
    // A UTF-8 BOM makes the SOURCE bytes differ from the encoded text, so the
    // source-byte digest can never be confused with a text digest.
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(TEXT)]);
    const spy = spyTextDigests(TEXT);

    const doc = await extractDocument(bytes, recipes.txt); // mints (digest #1)
    expect(verifiedHashOf(doc.verified)).toBe(doc.artifact.text);
    const batch = await segmentVerified(doc.verified, 'en');
    const shard = await createDocumentIndexVerified(doc.verified, batch, R);
    const ready = await makeReadyDocument(
      'a' as ProjectDocId,
      shard,
      rootOnlyV2(TEXT, shard.text),
    );
    const snapshot = await composeSnapshot(GEN, ['a' as ProjectDocId], new Map([['a' as ProjectDocId, ready]]));
    const bound = await bindShards(snapshot, new Map([['a', shard]]));
    await bindTextsVerified(snapshot, bound, new Map([['a', doc.verified]]));

    expect(spy.count()).toBe(1);
  });

  it('the plain-string lanes each still perform their own defensive digest (self-verifying entries)', async () => {
    const spy = spyTextDigests(TEXT);
    const batch = await segment(TEXT, 'en'); // digest #1
    await createDocumentIndex(TEXT, batch, R); // digest #2
    expect(spy.count()).toBe(2);
  });
});
