/**
 * Generation-scoped incremental binding — weakening-risk suite (Phase D
 * workstream D1).
 *
 * `bindShardsIncremental` memoizes per-document clone+ABI-validation on an
 * opaque, WeakMap-authenticated session. Every test here attacks the caching
 * layer's trust boundary: hash-confusion (a descriptor hash is NOT proof —
 * only the exact validated source object is), caller aliasing after bind,
 * snapshot-level validation on all-hit publications, failure poisoning,
 * forged sessions, cross-session leakage, multi-snapshot clone sharing, and
 * kernel purity (reuse makes it an explicit contract). The incremental-cost
 * proof counts `validateShardStructure` calls through a module mock — the
 * one validation seam both bind paths share.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BuildGeneration, ProjectDocId } from '../src/contract/brands.ts';
import { DEFAULT_INDEX_RECIPE } from '../src/contract/recipes.ts';
import { indexArtifactHash } from '../src/contract/identity.ts';
import { createDocumentIndex, validateShardStructure, type DocumentIndexV1 } from '../src/index/build.ts';
import {
  bindShards,
  bindShardsIncremental,
  bindTexts,
  createBindingSession,
  internalShardOf,
  type BindingSession,
  type BoundShards,
  type BoundTexts,
} from '../src/ops/binding.ts';
import {
  buildConcordanceAxis,
  materializeConcordanceWindow,
  planConcordanceWindow,
} from '../src/ops/concordance.ts';
import { occurrences, type TermGroupSpec } from '../src/ops/occurrences.ts';
import { trend } from '../src/ops/trend.ts';
import { buildResolver, modeKey, type MatchMode, type Resolver } from '../src/resolve/fold.ts';
import { segment } from '../src/segment/intl.ts';
import {
  composeSnapshot,
  makeReadyDocument,
  type CorpusSnapshotV1,
  type ReadyDocument,
} from '../src/snapshot/compose.ts';
import { resolveSelection } from '../src/snapshot/selection.ts';

// The validation-count seam: binding.ts receives this wrapped (call-counting,
// behavior-preserving) validateShardStructure — the ONE per-doc structural
// validation both bind paths run on every owned clone.
vi.mock('../src/index/build.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index/build.ts')>();
  return { ...actual, validateShardStructure: vi.fn(actual.validateShardStructure) };
});

/** Available in every supported runtime; core's ambient globals deliberately
 *  exclude it (environment-agnostic package), so the TEST declares it. */
declare const structuredClone: <T>(v: T) => T;

const R = DEFAULT_INDEX_RECIPE;
const GEN = 'g' as BuildGeneration;
const FOLD: MatchMode = { case: 'folded', diacritics: 'sensitive' };
const wolfGroup: TermGroupSpec = {
  id: 'g1',
  members: [{ id: 'm1', kind: 'token', surface: 'wolf', match: FOLD }],
  countOverlaps: false,
};

const validations = (): number => vi.mocked(validateShardStructure).mock.calls.length;

interface Doc {
  id: ProjectDocId;
  text: string;
  shard: DocumentIndexV1;
  ready: ReadyDocument;
}

async function docOf(id: string, text: string): Promise<Doc> {
  const shard = await createDocumentIndex(text, await segment(text, 'en'), R);
  const ready = await makeReadyDocument(id as ProjectDocId, shard);
  return { id: id as ProjectDocId, text, shard, ready };
}

function snapshotOf(expected: readonly Doc[], readyDocs?: readonly Doc[]): Promise<CorpusSnapshotV1> {
  const present = readyDocs ?? expected;
  return composeSnapshot(GEN, expected.map((d) => d.id), new Map(present.map((d) => [d.id, d.ready])));
}
const shardsOf = (docs: readonly Doc[]): Map<string, DocumentIndexV1> =>
  new Map(docs.map((d) => [d.id as string, d.shard]));
const textsOf = (docs: readonly Doc[]): Map<string, string> =>
  new Map(docs.map((d) => [d.id as string, d.text]));

/** A plain deep image of every resident field — the before/after comparand
 *  for aliasing and kernel-purity byte comparisons. */
function armor(s: DocumentIndexV1) {
  return {
    tokenTypeIds: Array.from(s.tokenTypeIds),
    startsUtf16: Array.from(s.startsUtf16),
    lengths8: Array.from(s.lengths8),
    longTokenPositions: Array.from(s.longTokenPositions),
    longTokenLengths: Array.from(s.longTokenLengths),
    tokenClasses: Array.from(s.tokenClasses),
    vocabulary: [...s.vocabulary],
    offsets: Array.from(s.postings.offsets),
    positions: Array.from(s.postings.positions),
    sentenceBounds: Array.from(s.sentenceBounds),
    paragraphBounds: Array.from(s.paragraphBounds),
    segmenter: { ...s.segmenter },
  };
}

/** A full query pipeline against the resident owned corpus: occurrences,
 * bounded Concordance planning, and authenticated row materialization. */
async function wolfRows(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  texts: BoundTexts,
): Promise<unknown> {
  const shards = new Map<string, DocumentIndexV1>();
  const resolvers = new Map<string, Map<string, Resolver>>();
  for (const ref of snapshot.docs) {
    const resident = internalShardOf(bound, ref.doc);
    shards.set(ref.doc, resident);
    resolvers.set(ref.doc, new Map([
      [modeKey(FOLD), await buildResolver(resident, R, FOLD)],
    ]));
  }
  const sel = await resolveSelection(snapshot, {
    docs: snapshot.docs.map((ref) => ref.doc),
  });
  const occ = occurrences(snapshot, shards, resolvers, sel, wolfGroup);
  const axis = buildConcordanceAxis(snapshot, sel, [occ]);
  const window = planConcordanceWindow(snapshot, bound, sel, axis, [occ], {
    anchor: { kind: 'rank', rank: 0 },
    before: 0,
    after: Math.max(0, axis.total - 1),
    contextTokens: 1,
  });
  return materializeConcordanceWindow(
    snapshot,
    window,
    texts,
    [{ seriesId: 's', groupId: 'g1' }],
  );
}

describe('session authentication (risk 5: forged session)', () => {
  it('rejects cast, copied, cloned, and derived sessions — including on zero-document input', async () => {
    const empty = await composeSnapshot(GEN, [] as ProjectDocId[], new Map());
    const real = createBindingSession();
    // The real session binds an empty snapshot fine (the zero-row path).
    const bound = await bindShardsIncremental(real, empty, new Map());
    expect(bound.docs()).toEqual([]);
    const forgeries: BindingSession[] = [
      {} as BindingSession,
      Object.freeze({}) as BindingSession,
      structuredClone(real), // loses WeakMap membership in transit
      Object.create(real) as BindingSession, // prototype chains are not membership
      { ...real } as BindingSession,
    ];
    for (const forged of forgeries) {
      await expect(bindShardsIncremental(forged, empty, new Map())).rejects.toThrow(
        /unauthenticated binding session/,
      );
    }
  });
});

describe('cache key discipline (risks 1 and 6)', () => {
  it('risk 1: a DIFFERENT tampered object with the same doc + claimed descriptor hash MISSES and is rejected', async () => {
    const a = await docOf('a', 'the wolf ran far');
    const snapshot = await snapshotOf([a]);
    const session = createBindingSession();
    await bindShardsIncremental(session, snapshot, shardsOf([a]));
    const base = validations();

    // Structurally tampered sibling: same descriptor triple (text/recipe/
    // segmenter), so its CLAIMED IndexArtifactHash equals the snapshot ref's —
    // the descriptor hash alone can never prove the arrays.
    const tampered: DocumentIndexV1 = { ...a.shard, tokenTypeIds: a.shard.tokenTypeIds.slice() };
    (tampered.tokenTypeIds as Uint32Array)[0] = 1 << 30; // out of vocabulary range
    expect(await indexArtifactHash(tampered)).toBe(snapshot.docs[0]!.index);

    await expect(
      bindShardsIncremental(session, snapshot, new Map([['a', tampered]])),
    ).rejects.toThrow(/out of vocabulary range/);
    // The tampered object was validated FRESH (miss), never served as a hit.
    expect(validations()).toBe(base + 1);

    // Conservative failure discipline: the failed attempt removed the doc's
    // entry entirely, so the ORIGINAL object must re-validate — and succeed.
    await expect(bindShardsIncremental(session, snapshot, shardsOf([a]))).resolves.toBeDefined();
    expect(validations()).toBe(base + 2);
    // ... and only now is it a hit again.
    await bindShardsIncremental(session, snapshot, shardsOf([a]));
    expect(validations()).toBe(base + 2);
  });

  it('risk 6: sessions with identical visible (doc, hash) keys share nothing; a fresh session starts empty', async () => {
    const a = await docOf('a', 'the wolf ran');
    const snapshot = await snapshotOf([a]);
    const s1 = createBindingSession();
    const s2 = createBindingSession();
    const before = validations();
    const b1 = await bindShardsIncremental(s1, snapshot, shardsOf([a]));
    expect(validations()).toBe(before + 1);
    const b2 = await bindShardsIncremental(s2, snapshot, shardsOf([a]));
    expect(validations()).toBe(before + 2); // no cross-session reuse
    expect(internalShardOf(b1, 'a')).not.toBe(internalShardOf(b2, 'a')); // distinct owned clones
    // Within one session it IS a hit.
    await bindShardsIncremental(s1, snapshot, shardsOf([a]));
    expect(validations()).toBe(before + 2);
  });
});

describe('caller aliasing (risk 2)', () => {
  it('mutating the original arrays, vocabulary, postings, and segmenter never reaches the owned clone or its results', async () => {
    const a = await docOf('a', 'the wolf saw a wolf cub');
    // Bind a source whose segmenter descriptor is a private copy — the shared
    // module-level fingerprint object must not be mutated across tests. Same
    // descriptor fields, so the snapshot ref still names this artifact.
    const source: DocumentIndexV1 = { ...a.shard, segmenter: { ...a.shard.segmenter } };
    const snapshot = await snapshotOf([a]);
    const session = createBindingSession();
    const bound1 = await bindShardsIncremental(session, snapshot, new Map([['a', source]]));
    const texts1 = await bindTexts(snapshot, bound1, textsOf([a]));
    const baselineRows = await wolfRows(snapshot, bound1, texts1);
    const baselineArmor = armor(internalShardOf(bound1, 'a'));
    const base = validations();

    // Mutate EVERYTHING mutable and reachable on the caller's object.
    (source.tokenTypeIds as Uint32Array)[0] = 3;
    (source.startsUtf16 as Uint32Array)[0] = 999;
    (source.tokenClasses as Uint8Array).fill(0);
    (source.vocabulary as string[])[0] = 'EVIL';
    (source.vocabulary as string[]).push('extra');
    (source.postings.offsets as Uint32Array)[1] = 0;
    (source.postings.positions as Uint32Array).fill(0);
    (source.sentenceBounds as Uint32Array)[0] = 7;
    (source.segmenter as { locale: string }).locale = 'zz-ZZ';
    (source.segmenter as { probeHash: string }).probeHash = '0'.repeat(64);

    // Same object identity + same expected hash → HIT: the capability serves
    // the DETACHED owned clone, and validateSnapshot (which re-derives the
    // resident descriptor hash — including the segmenter) still passes,
    // proving the clone aliases nothing on the caller's object.
    const bound2 = await bindShardsIncremental(session, snapshot, new Map([['a', source]]));
    expect(validations()).toBe(base); // a hit — no re-validation of the mutated source
    const resident = internalShardOf(bound2, 'a');
    expect(resident).toBe(internalShardOf(bound1, 'a'));
    expect(armor(resident)).toEqual(baselineArmor);
    const texts2 = await bindTexts(snapshot, bound2, textsOf([a]));
    const rows = await wolfRows(snapshot, bound2, texts2);
    expect(rows).toEqual(baselineRows);
  });
});

describe('cross-artifact checks not skipped (risk 3)', () => {
  it('an all-cache-hit publication still fails validateSnapshot on tampered snapshot-level relations', async () => {
    const a = await docOf('a', 'wolf beta');
    const b = await docOf('b', 'beta wolf gamma');
    const snapshot = await snapshotOf([a, b]);
    const session = createBindingSession();
    await bindShardsIncremental(session, snapshot, shardsOf([a, b]));
    const base = validations();

    const keyCount = snapshot.vocabulary.keys.length;
    const refB = snapshot.docs[1]!;
    const flippedTranslation: CorpusSnapshotV1 = {
      ...snapshot,
      docs: [
        snapshot.docs[0]!,
        { ...refB, localToCorpusType: Uint32Array.from(refB.localToCorpusType, (v) => keyCount - 1 - v) },
      ],
    };
    await expect(
      bindShardsIncremental(session, flippedTranslation, shardsOf([a, b])),
    ).rejects.toThrow(/canonical merge/);

    const shiftedBase: CorpusSnapshotV1 = {
      ...snapshot,
      docs: [snapshot.docs[0]!, { ...refB, sequenceTokenBase: refB.sequenceTokenBase + 1 }],
    };
    await expect(
      bindShardsIncremental(session, shiftedBase, shardsOf([a, b])),
    ).rejects.toThrow(/sequence base out of order/);

    // Both rejections happened on ALL-HIT publications: zero fresh per-doc
    // validations, so only the retained snapshot-level pass can have thrown.
    expect(validations()).toBe(base);
    // The failures never corrupted the prior good entries.
    await expect(bindShardsIncremental(session, snapshot, shardsOf([a, b]))).resolves.toBeDefined();
    expect(validations()).toBe(base);
  });
});

describe('failed-validation poisoning (risk 4)', () => {
  it('a failed bind installs NO entry; a later repair validates fresh and only then caches', async () => {
    const a = await docOf('a', 'the wolf ran far and fast');
    const snapshot = await snapshotOf([a]);
    const session = createBindingSession();
    const broken: DocumentIndexV1 = { ...a.shard, lengths8: a.shard.lengths8.slice(0, -1) };
    const base = validations();

    await expect(bindShardsIncremental(session, snapshot, new Map([['a', broken]]))).rejects.toThrow(
      /parallel/,
    );
    expect(validations()).toBe(base + 1);
    // A second attempt with the same broken object is validated FRESH again —
    // the failure installed nothing it could be served from.
    await expect(bindShardsIncremental(session, snapshot, new Map([['a', broken]]))).rejects.toThrow(
      /parallel/,
    );
    expect(validations()).toBe(base + 2);

    // Repair: the valid object binds (fresh validation), then hits.
    await expect(bindShardsIncremental(session, snapshot, shardsOf([a]))).resolves.toBeDefined();
    expect(validations()).toBe(base + 3);
    await bindShardsIncremental(session, snapshot, shardsOf([a]));
    expect(validations()).toBe(base + 3);
  });
});

describe('snapshot lifetime (risk 7)', () => {
  it('an older BoundShards stays fully usable next to a newer one sharing owned clones', async () => {
    const a = await docOf('a', 'the wolf ran');
    const b = await docOf('b', 'a second wolf');
    const session = createBindingSession();
    const s1 = await snapshotOf([a, b], [a]); // b still missing
    const bound1 = await bindShardsIncremental(session, s1, shardsOf([a]));
    const texts1 = await bindTexts(s1, bound1, textsOf([a]));
    const rows1Before = await wolfRows(s1, bound1, texts1);

    const s2 = await snapshotOf([a, b]);
    const bound2 = await bindShardsIncremental(session, s2, shardsOf([a, b]));
    const texts2 = await bindTexts(s2, bound2, textsOf([a, b]));

    // Fresh capability + fresh private map per publication; the owned clone
    // itself is shared (strings and validated arrays are safely reusable).
    expect(bound2).not.toBe(bound1);
    expect(bound1.snapshot).toBe(s1.id);
    expect(bound2.snapshot).toBe(s2.id);
    expect(internalShardOf(bound2, 'a')).toBe(internalShardOf(bound1, 'a'));

    // BOTH remain fully queryable after the newer publication.
    expect(await wolfRows(s1, bound1, texts1)).toEqual(rows1Before);
    expect(bound1.docs()).toEqual(['a']);
    expect(bound2.docs()).toEqual(['a', 'b']);
    const rows2 = (await wolfRows(s2, bound2, texts2)) as { rows?: unknown[] } | unknown[];
    expect(rows2).toBeDefined();
  });
});

describe('kernel purity (risk 8)', () => {
  it('occurrences, trend, and Concordance leave the owned artifact byte-identical', async () => {
    const a = await docOf('a', 'the wolf ran and the wolf slept in the den');
    const snapshot = await snapshotOf([a]);
    const session = createBindingSession();
    const bound = await bindShardsIncremental(session, snapshot, shardsOf([a]));
    const texts = await bindTexts(snapshot, bound, textsOf([a]));
    const resident = internalShardOf(bound, 'a');
    const before = armor(resident);

    const byMode = new Map<string, Resolver>([[modeKey(FOLD), await buildResolver(resident, R, FOLD)]]);
    const sel = await resolveSelection(snapshot, { docs: ['a'] as ProjectDocId[] });
    const occ = occurrences(snapshot, new Map([['a', resident]]), new Map([['a', byMode]]), sel, wolfGroup);
    expect(occ.pos.length).toBe(2);
    trend(snapshot, sel, occ, { coordinate: 'document-relative', bins: { mode: 'per-doc', count: 4 } });
    const axis = buildConcordanceAxis(snapshot, sel, [occ]);
    const window = planConcordanceWindow(snapshot, bound, sel, axis, [occ], {
      anchor: { kind: 'rank', rank: 0 },
      before: 0,
      after: axis.total - 1,
      contextTokens: 2,
    });
    materializeConcordanceWindow(
      snapshot,
      window,
      texts,
      [{ seriesId: 's', groupId: 'g1' }],
    );
    // Reuse across snapshots makes kernel purity an explicit contract: every
    // resident byte (and the descriptor) must be exactly as bound.
    expect(armor(resident)).toEqual(before);
  });
});

describe('incremental cost', () => {
  it('publication K+1 with one new document validates/clones ONLY the new document; bindShards stays always-fresh', async () => {
    const a = await docOf('a', 'the wolf ran');
    const b = await docOf('b', 'another wolf here');
    const c = await docOf('c', 'a third wolf');
    const session = createBindingSession();

    const s1 = await snapshotOf([a, b, c], [a, b]);
    const base = validations();
    const bound1 = await bindShardsIncremental(session, s1, shardsOf([a, b]));
    expect(validations()).toBe(base + 2); // both docs fresh

    const s2 = await snapshotOf([a, b, c]);
    const bound2 = await bindShardsIncremental(session, s2, shardsOf([a, b, c]));
    expect(validations()).toBe(base + 3); // ONLY 'c' was validated

    // Clone reuse is proven by object identity: a re-clone would be a fresh
    // object, so identity equality also bounds the clone count at one per doc.
    expect(internalShardOf(bound2, 'a')).toBe(internalShardOf(bound1, 'a'));
    expect(internalShardOf(bound2, 'b')).toBe(internalShardOf(bound1, 'b'));

    // The UNCHANGED public path never consults a session: full re-validation.
    await bindShards(s2, shardsOf([a, b, c]));
    expect(validations()).toBe(base + 6);
  });
});

// ── review-d1-binding findings: dispatch-free copying, descriptor primitive
// validation, and the post-install rollback path. ──
describe('adversarial ownership escapes (review-d1-binding)', () => {
  it('an own `slice` returning the source cannot alias caller memory into the cache', async () => {
    const a = await docOf('a', 'alpha beta gamma');
    // Weaponize the source: an own `slice` that returns the SAME array. The
    // old `.slice()` dispatch would have cached an alias; the non-dispatching
    // copy must produce a detached clone regardless.
    const weapon = a.shard.tokenTypeIds;
    Object.defineProperty(weapon, 'slice', { value: () => weapon, configurable: true });
    const session = createBindingSession();
    const snap = await snapshotOf([a]);
    const bound = await bindShardsIncremental(session, snap, shardsOf([a]));
    const resident = internalShardOf(bound, a.id);
    expect(resident.tokenTypeIds).not.toBe(weapon);
    const before = Array.from(resident.tokenTypeIds);
    weapon.fill(0xffffffff);
    expect(Array.from(resident.tokenTypeIds)).toEqual(before);
    // Cache-hit rebind still serves the detached clone.
    const again = await bindShardsIncremental(session, snap, shardsOf([a]));
    expect(Array.from(internalShardOf(again, a.id).tokenTypeIds)).toEqual(before);
  });

  it('an own lying `length` on a source array cannot shape the owned copy', async () => {
    const a = await docOf('a', 'alpha beta gamma');
    const src = a.shard.startsUtf16;
    Object.defineProperty(src, 'length', { value: 1, configurable: true });
    const session = createBindingSession();
    const snap = await snapshotOf([a]);
    const bound = await bindShardsIncremental(session, snap, shardsOf([a]));
    // The reflective internal-slot length wins: all three tokens survive.
    expect(internalShardOf(bound, a.id).startsUtf16.length).toBe(3);
  });

  it('an object-valued segmenter field is rejected at shard validation, never cached', async () => {
    const a = await docOf('a', 'alpha beta');
    const mole = { toString: () => a.shard.segmenter.adapter };
    const cast = {
      ...a.shard,
      segmenter: { ...a.shard.segmenter, adapter: mole },
    } as unknown as DocumentIndexV1;
    expect(() => validateShardStructure(cast)).toThrow(/segmenter\.adapter/);
    const session = createBindingSession();
    const snap = await snapshotOf([a]);
    await expect(
      bindShardsIncremental(session, snap, new Map([[a.id as string, cast]])),
    ).rejects.toThrow(/segmenter\.adapter/);
    // The failed object installed nothing: the genuine shard is a fresh miss
    // that validates and binds cleanly.
    const ok = await bindShardsIncremental(session, snap, shardsOf([a]));
    expect(Array.from(internalShardOf(ok, a.id).tokenTypeIds).length).toBe(2);
  });

  it('a subclassed typed array (foreign @@species surface) is rejected outright', async () => {
    const a = await docOf('a', 'alpha beta');
    class Sneaky extends Uint32Array {}
    const sub = new Sneaky(a.shard.tokenTypeIds.length);
    sub.set(a.shard.tokenTypeIds);
    const cast = { ...a.shard, tokenTypeIds: sub } as unknown as DocumentIndexV1;
    const session = createBindingSession();
    const snap = await snapshotOf([a]);
    await expect(
      bindShardsIncremental(session, snap, new Map([[a.id as string, cast]])),
    ).rejects.toThrow(/plain Uint32Array/);
  });

  it('a post-install validateSnapshot failure rolls back the newly installed entry', async () => {
    const a = await docOf('a', 'alpha beta');
    const b = await docOf('b', 'gamma delta');
    const session = createBindingSession();
    // Publication 1: doc a alone — populates a's entry.
    await bindShardsIncremental(session, await snapshotOf([a]), shardsOf([a]));
    // Publication 2: a is a HIT, b is a fresh MISS that validates and
    // installs — then the snapshot-level relation fails afterward.
    const snap2 = await snapshotOf([a, b]);
    const tampered = {
      ...snap2,
      docs: snap2.docs.map((d) =>
        d.doc === b.id ? { ...d, sequenceTokenBase: d.sequenceTokenBase + 5 } : d,
      ),
    } as CorpusSnapshotV1;
    await expect(
      bindShardsIncremental(session, tampered, shardsOf([a, b])),
    ).rejects.toThrow();
    // Retry with the honest snapshot: b must be cloned+validated AGAIN (its
    // rolled-back entry is gone), proven by a fresh validation count.
    const counts = validations();
    const ok = await bindShardsIncremental(session, snap2, shardsOf([a, b]));
    expect(validations() - counts).toBe(1); // only b — a stays a hit
    expect(Array.from(internalShardOf(ok, b.id).tokenTypeIds).length).toBe(2);
  });
});
