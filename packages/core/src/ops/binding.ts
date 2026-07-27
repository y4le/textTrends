/**
 * Bound execution contexts — Milestone 3 review rounds 1-4.
 *
 * Kernels must not accept structural objects that merely CLAIM to be verified
 * contexts. The factories here return frozen, minimal capability objects
 * whose stores live in MODULE-PRIVATE WeakMaps:
 * - authentication: kernels resolve residency through internal accessors that
 *   look the capability up in the private WeakMap — a structurally identical
 *   imposter object is rejected, not consulted;
 * - ownership: every shard typed array and the vocabulary are deep-copied at
 *   bind time, the OWNED COPY is structurally validated against the full
 *   document-index ABI, and no public API returns the resident shard — there
 *   is no supported path to its arrays outside this package's kernels.
 *
 * The internal accessors are exported from this module for sibling kernels
 * but are deliberately NOT re-exported from the package root; deep-path
 * imports are outside the supported API surface.
 */

import type { IndexArtifactHash, ProjectDocId } from '../contract/brands.ts';
import { verifiedHashOf, verifiedTextOf, verifyText, type VerifiedText } from '../contract/verified-text.ts';
import { indexArtifactHash } from '../contract/identity.ts';
import { tokenEndChar, validateShardStructure, type DocumentIndexV1 } from '../index/build.ts';
import { validateSnapshot, type CorpusSnapshotV1 } from '../snapshot/compose.ts';

/** A typed, code-bearing dependency failure (contract WorkerErrorCode family). */
export class DependencyError extends Error {
  // Plain fields + body assignment: parameter properties are not erasable
  // syntax and would break Node's type-stripping loader (review round 2).
  readonly code = 'DEPENDENCY_MISSING';
  readonly dependency: 'shard' | 'text';
  readonly doc: string;
  constructor(dependency: 'shard' | 'text', doc: string) {
    super(`missing ${dependency} dependency for '${doc}'`);
    this.name = 'DependencyError';
    this.dependency = dependency;
    this.doc = doc;
  }
}

/**
 * Deep copy — residency owns EVERYTHING reachable from the shard; the caller
 * keeps only its own object (D1 precondition: owned clones may now outlive a
 * single publication, so a retained caller reference must alias nothing).
 * Field-by-field ownership treatment:
 * - `schema` / `text` / `recipe` / `tokenClassVersion`: immutable primitives.
 * - `segmenter`: the ONE previously by-reference mutable object — REBUILT from
 *   its known fields (all string primitives; a foreign extra property must not
 *   ride into the owned artifact's canonical descriptor hash) and frozen.
 * - typed arrays (`tokenTypeIds` … `paragraphBounds`, `postings.*`): copied
 *   with `.slice()` — a fresh backing buffer per array. (Non-empty typed
 *   arrays cannot be frozen; ownership-by-copy plus the kernel-purity
 *   contract covers them.)
 * - `vocabulary`: fresh array (strings are immutable), frozen.
 * - `postings`: fresh container object, frozen.
 * - the clone itself is frozen so no resident field can be reassigned.
 */
/** Reflective built-in length getter for typed arrays. An instance can shadow
 *  `length` with an own data property and can carry an own `slice` returning
 *  the source itself (review-d1-binding finding) — so copying must consult
 *  NOTHING the caller can define. */
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint32Array.prototype) as object,
  'length',
)!.get! as (this: ArrayBufferView) => number;

/** Non-dispatching typed-array copy: the prototype pin rejects fakes AND
 *  subclasses (whose @@species could substitute a foreign result), the length
 *  comes from the built-in internal-slot getter, and `out.set(src)` is the
 *  spec's internal buffer copy — no caller-defined method or accessor runs. */
function ownU32(src: Uint32Array, what: string): Uint32Array {
  if (Object.getPrototypeOf(src) !== Uint32Array.prototype) {
    throw new RangeError(`${what} must be a plain Uint32Array`);
  }
  const out = new Uint32Array(TYPED_ARRAY_LENGTH.call(src));
  out.set(src);
  return out;
}
function ownU8(src: Uint8Array, what: string): Uint8Array {
  if (Object.getPrototypeOf(src) !== Uint8Array.prototype) {
    throw new RangeError(`${what} must be a plain Uint8Array`);
  }
  const out = new Uint8Array(TYPED_ARRAY_LENGTH.call(src));
  out.set(src);
  return out;
}

function cloneShard(s: DocumentIndexV1): DocumentIndexV1 {
  const seg = s.segmenter;
  return Object.freeze({
    schema: s.schema,
    text: s.text,
    recipe: s.recipe,
    segmenter: Object.freeze({
      adapter: seg.adapter,
      adapterVersion: seg.adapterVersion,
      locale: seg.locale,
      wordPolicy: seg.wordPolicy,
      sentencePolicy: seg.sentencePolicy,
      classifierVersion: seg.classifierVersion,
      probeHash: seg.probeHash,
    }),
    tokenTypeIds: ownU32(s.tokenTypeIds, 'tokenTypeIds'),
    startsUtf16: ownU32(s.startsUtf16, 'startsUtf16'),
    lengths8: ownU8(s.lengths8, 'lengths8'),
    longTokenPositions: ownU32(s.longTokenPositions, 'longTokenPositions'),
    longTokenLengths: ownU32(s.longTokenLengths, 'longTokenLengths'),
    tokenClassVersion: s.tokenClassVersion,
    tokenClasses: ownU8(s.tokenClasses, 'tokenClasses'),
    vocabulary: Object.freeze([...s.vocabulary]),
    postings: Object.freeze({
      offsets: ownU32(s.postings.offsets, 'postings.offsets'),
      positions: ownU32(s.postings.positions, 'postings.positions'),
    }),
    sentenceBounds: ownU32(s.sentenceBounds, 'sentenceBounds'),
    paragraphBounds: ownU32(s.paragraphBounds, 'paragraphBounds'),
  });
}

/**
 * Copy-first per-document ownership: clone the caller's shard, validate the
 * COPY against the full ABI, then prove the owned descriptor identity is the
 * artifact the snapshot ref names. The shared per-doc step of both bind paths
 * — descriptor identity alone is never integrity (review round 4).
 */
async function ownShard(
  shard: DocumentIndexV1,
  ref: CorpusSnapshotV1['docs'][number],
): Promise<DocumentIndexV1> {
  const owned = cloneShard(shard);
  validateShardStructure(owned);
  if ((await indexArtifactHash(owned)) !== ref.index) {
    throw new RangeError(`shard for '${ref.doc}' is not the artifact named by the snapshot`);
  }
  return owned;
}

/** Minimal public capability — residency is reachable only via kernels. */
export interface BoundShards {
  readonly snapshot: CorpusSnapshotV1['id'];
  docs(): readonly string[];
}

export interface BoundTexts {
  readonly snapshot: CorpusSnapshotV1['id'];
  docs(): readonly string[];
}

const SHARD_STORES = new WeakMap<BoundShards, Map<string, DocumentIndexV1>>();
const TEXT_STORES = new WeakMap<BoundTexts, Map<string, string>>();

/** INTERNAL: eager context authentication — kernels call these at ENTRY so a
 *  forged capability is rejected even on zero-row paths (review round 5). */
export function assertBoundShards(bound: BoundShards): void {
  if (!SHARD_STORES.has(bound)) throw new RangeError('unauthenticated shard context');
}
export function assertBoundTexts(texts: BoundTexts): void {
  if (!TEXT_STORES.has(texts)) throw new RangeError('unauthenticated text context');
}

/** INTERNAL (not in the package root): authenticated residency lookup. */
export function internalShardOf(bound: BoundShards, doc: string): DocumentIndexV1 {
  const store = SHARD_STORES.get(bound);
  if (!store) throw new RangeError('unauthenticated shard context');
  const shard = store.get(doc);
  if (!shard) throw new DependencyError('shard', doc);
  return shard;
}

/** INTERNAL (not in the package root): authenticated text lookup. */
export function internalTextOf(texts: BoundTexts, doc: string): string {
  const store = TEXT_STORES.get(texts);
  if (!store) throw new RangeError('unauthenticated text context');
  const text = store.get(doc);
  if (text === undefined) throw new DependencyError('text', doc);
  return text;
}

/**
 * Verify that every supplied shard IS the artifact its snapshot ref names.
 * Every composed document must be present — a partial bind is a declared
 * dependency failure, not a silent gap. The owned copy is structurally
 * validated (full ABI: array constructors, parallel lengths, monotone
 * starts, overflow-table agreement, postings permutation, bounds sentinels)
 * BEFORE the descriptor identity is compared — descriptor identity alone is
 * not integrity (review round 4).
 */
export async function bindShards(
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<string, DocumentIndexV1>,
): Promise<BoundShards> {
  const verified = new Map<string, DocumentIndexV1>();
  for (const ref of snapshot.docs) {
    const shard = shards.get(ref.doc);
    if (!shard) throw new DependencyError('shard', ref.doc);
    // Copy first (caller-side TOCTOU), then validate the copy's structure,
    // then compare the descriptor identity.
    verified.set(ref.doc, await ownShard(shard, ref));
  }
  // Cross-artifact binding (review round 6): an internally valid shard can
  // still contradict the snapshot's coordinates (token count, translation
  // lengths, canonical vocabulary merge) because the descriptor identity
  // excludes arrays. Validate the COMPLETE snapshot against the owned map.
  await validateSnapshot(snapshot, verified as unknown as ReadonlyMap<ProjectDocId, DocumentIndexV1>);
  const docList = Object.freeze([...verified.keys()]);
  const capability: BoundShards = Object.freeze({
    snapshot: snapshot.id,
    docs: () => docList,
  });
  SHARD_STORES.set(capability, verified);
  return capability;
}

// ---------------------------------------------------------------------------
// Generation-scoped incremental binding (Phase D workstream D1)
// ---------------------------------------------------------------------------

declare const bindingSession: unique symbol;
/**
 * Opaque, generation-owned binding session. Carries NO runtime data — the
 * module-private WeakMap below does (mirroring the VerifiedText pattern): a
 * cast, spread copy, structuredClone, or Object.create imposter is rejected
 * by `bindShardsIncremental` at entry, even on zero-document input. Realm-
 * local; never structured-clone or postMessage it.
 */
export interface BindingSession {
  readonly [bindingSession]: 'BindingSession';
}

/** One owned, already-validated clone per document. A hit requires ALL THREE
 *  key components — a descriptor hash alone is NOT proof (`indexArtifactHash`
 *  authenticates the descriptor, not every typed-array byte):
 *  the document id (the map key), the snapshot ref's expected identity, and
 *  the EXACT OBJECT IDENTITY of the source shard that was cloned+validated. */
interface OwnedShardEntry {
  readonly source: DocumentIndexV1;
  readonly expectedIndex: IndexArtifactHash;
  readonly owned: DocumentIndexV1;
}

/** Module-private session authentication + per-generation ownership cache.
 *  WeakMap-keyed by the session object: no module-global unbounded state —
 *  entries live exactly as long as the generation holds its session. */
const SESSION_CACHES = new WeakMap<BindingSession, Map<string, OwnedShardEntry>>();

/** The ONE sanctioned session factory. The caller (a generation) owns the
 *  session for its lifetime; dropping it drops every owned clone. */
export function createBindingSession(): BindingSession {
  const session = Object.freeze({}) as object as BindingSession;
  SESSION_CACHES.set(session, new Map());
  return session;
}

/**
 * Incremental sibling of `bindShards` — same result contract (a fresh
 * BoundShards capability whose private store holds only owned, validated
 * shards), but per-document clone+ABI-validation work is memoized on the
 * generation-owned session so publication K+1 with one new document pays for
 * ONE document, not K+1.
 *
 * Cache discipline:
 * - HIT: entry.source === the supplied shard object AND entry.expectedIndex
 *   === ref.index. A DIFFERENT object with the same claimed hash is a MISS
 *   (clone + validate again, replacing the entry).
 * - An entry is populated only AFTER copy-first structural validation and the
 *   descriptor-identity comparison both succeed.
 * - A failed bind leaves NO reusable entry: the doc's stale entry is removed
 *   before the fallible work (conservative reading — on failure for a doc,
 *   that doc has no entry at all), and every entry this call installed is
 *   rolled back if the bind fails later (including at snapshot validation).
 *   Prior good entries for HIT documents are never touched by a failure.
 * - Eviction: generation lifetime only; an entry is replaced when the source
 *   object or expected hash changes. No LRU (bounded by the doc cap).
 *
 * Validation retained: the full cross-artifact `validateSnapshot` pass runs
 * for EVERY newly composed snapshot — cached per-doc ownership never skips
 * snapshot-level checks (canonical vocabulary translation, token bases and
 * counts, snapshot id). Each publication returns a FRESH capability and a
 * fresh private map; only the owned clones (and their immutable strings) are
 * shared across successive snapshots, so an older BoundShards stays fully
 * usable next to a newer one. Publications on one session are expected to be
 * serialized by the owner (the engine's composition mutex does).
 */
export async function bindShardsIncremental(
  session: BindingSession,
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<string, DocumentIndexV1>,
): Promise<BoundShards> {
  // Eager authentication — a forged session fails even on zero-document input.
  const cache = SESSION_CACHES.get(session);
  if (!cache) throw new RangeError('unauthenticated binding session');
  const verified = new Map<string, DocumentIndexV1>();
  const installed: string[] = [];
  try {
    for (const ref of snapshot.docs) {
      const shard = shards.get(ref.doc);
      if (!shard) throw new DependencyError('shard', ref.doc);
      const entry = cache.get(ref.doc);
      if (entry !== undefined && entry.source === shard && entry.expectedIndex === ref.index) {
        verified.set(ref.doc, entry.owned);
        continue;
      }
      // MISS (new doc, replaced source object, or changed expected identity):
      // drop the doc's entry FIRST so a throw below leaves nothing reusable.
      cache.delete(ref.doc);
      const owned = await ownShard(shard, ref);
      cache.set(ref.doc, { source: shard, expectedIndex: ref.index, owned });
      installed.push(ref.doc);
      verified.set(ref.doc, owned);
    }
    await validateSnapshot(snapshot, verified as unknown as ReadonlyMap<ProjectDocId, DocumentIndexV1>);
  } catch (e) {
    for (const doc of installed) cache.delete(doc);
    throw e;
  }
  const docList = Object.freeze([...verified.keys()]);
  const capability: BoundShards = Object.freeze({
    snapshot: snapshot.id,
    docs: () => docList,
  });
  SHARD_STORES.set(capability, verified);
  return capability;
}

/**
 * Verify each supplied text's identity against its bound shard (hash check
 * happens ONCE at residency time, not per page). Partial maps are fine —
 * materialization later demands only the docs actually on a page. The safe
 * self-verifying entry: each text is hashed once (`verifyText`) and delegated
 * to the verified binding path.
 */
export async function bindTexts(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  texts: ReadonlyMap<string, string>,
): Promise<BoundTexts> {
  const verified = new Map<string, VerifiedText>();
  for (const [doc, text] of texts) verified.set(doc, await verifyText(text));
  return bindTextsVerified(snapshot, bound, verified);
}

/**
 * The verified binding path (a DISTINCT named API, never a permissive
 * string-union overload): each entry's identity comes from its capability's
 * proof instead of a re-digest, but it must still EQUAL the owned shard's text
 * hash, and the resident token geometry is still bound to the actual text
 * extent — only the redundant digest is gone.
 */
export async function bindTextsVerified(
  snapshot: CorpusSnapshotV1,
  bound: BoundShards,
  texts: ReadonlyMap<string, VerifiedText>,
): Promise<BoundTexts> {
  if (bound.snapshot !== snapshot.id) {
    throw new RangeError('bound shards belong to a different snapshot');
  }
  assertBoundShards(bound);
  const verified = new Map<string, string>();
  for (const [doc, proof] of texts) {
    const text = verifiedTextOf(proof); // authenticates; throws on forgeries
    const shard = internalShardOf(bound, doc);
    if (verifiedHashOf(proof) !== shard.text) {
      throw new RangeError(`text for '${doc}' does not match the bound shard's text identity`);
    }
    // Bind resident char spans to the ACTUAL verified text extent (round 6):
    // in-domain geometry can still point past this text's end.
    const n = shard.tokenTypeIds.length;
    if (n > 0 && tokenEndChar(shard, n - 1) > text.length) {
      throw new RangeError(`resident token spans for '${doc}' exceed the verified text length`);
    }
    verified.set(doc, text);
  }
  const docList = Object.freeze([...verified.keys()]);
  const capability: BoundTexts = Object.freeze({
    snapshot: snapshot.id,
    docs: () => docList,
  });
  TEXT_STORES.set(capability, verified);
  return capability;
}
