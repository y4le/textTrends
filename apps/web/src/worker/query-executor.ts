/**
 * The generation-bound query executor (slice-2 ruling §B — the F1 just-in-time
 * extraction, landed BEFORE the first new QueryOp).
 *
 * OWNS: analysis-query execution, resolver REUSE (per-doc, per-match-mode,
 * rebuilt when a commit replaces a shard), and the shared query-derived
 * occurrence cache (the Phase-E discipline, verbatim).
 *
 * RECEIVES: a read-only published snapshot view (snapshot, ready documents,
 * bound shards/texts) via `publish`, a narrow resolver loader, and — per
 * call — an injected async checkpoint that yields and gates. It never sees
 * job ids, cancellation state, emission, or generation lifecycle.
 *
 * The ENGINE retains job ownership, active/cancelled bookkeeping, generation/
 * snapshot validation, error mapping, transfer-list emission, and a final
 * gate immediately before every emit. Ingest stays
 * engine/handler concerns — this is deliberately
 * not a generic worker framework.
 */

import {
  buildMatchesAxis,
  buildResolver,
  matchesAxisPayloadBytes,
  copyMatchesAxis,
  documentTermCounts,
  DISPERSION_EXACT_MAX,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  planReaderPage,
  materializeReaderPage,
  materializeMatchesWindow,
  selectionSlotMap,
  type DispersionResultV1,
  type DispersionTrackV1,
  MAX_KWIC_TRACKS,
  modeKey,
  occurrences,
  occurrenceStep,
  planMatchesWindow,
  validateOccurrenceOrder,
  occurrencePayloadBytes,
  trend,
  type CorpusSnapshotV1,
  type MatchesAxisArraysV1,
  type MatchesAxisV1,
  type MatchesWindowRequestV1,
  type MatchesWindowV1,
  type DocumentIndexV1,
  type MatchMode,
  type NumericOccurrences,
  type OccurrenceStepRequestV1,
  type OccurrenceStepResultV1,
  type NumericTrend,
  type ReadyDocument,
  type Resolver,
  type ResolvedSelection,
  type TermGroupSpec,
  type TrendRequest,
  type BoundShards,
  type BoundTexts,
  type IndexRecipeProvisional,
  type DocTermCountsV1,
  inventory as computeInventory,
  type InventoryRequestV1,
  type InventoryResultV1,
  type InventoryDocumentInputV1,
  frequencyList as computeFrequencyList,
  type FrequencyListRequestV1,
  type FrequencyListResultV1,
  keyness as computeKeyness,
  type KeynessResultV1,
  type KeynessTableRequestV1,
  termCountPayloadBytes,
  termCountRangeKey,
  TERM_COUNT_CACHE_MAX_BYTES,
  TERM_COUNT_CACHE_MAX_ENTRIES,
} from '@texttrends/core';
import { DependencyError, termGroupIdentity } from '@texttrends/core';

/** The occurrence-cache hard cap — one entry per possible concurrent track. */
export const MAX_OCCURRENCE_CACHE_ENTRIES = MAX_KWIC_TRACKS;
/** Five worst-case kernel payloads are just under 48 MiB under
 * OCCURRENCE_LIMITS_V1; the byte ceiling keeps cache retention below that
 * explicit worker budget even when CSR provenance is unusually wide. */
export const MAX_OCCURRENCE_CACHE_BYTES = 48 * 1024 * 1024;
/** Sparse axes are at most about 61 KiB each at the one-million-row cap. */
export const MAX_MATCHES_AXIS_CACHE_ENTRIES = MAX_KWIC_TRACKS;
export const MAX_MATCHES_AXIS_CACHE_BYTES = 512 * 1024;

/** [SnapshotId, SelectionHash, termGroupIdentity] — the tuple that fully
 *  determines one raw `NumericOccurrences` (see the cache contract below). */
const occurrenceCacheKey = (snapshot: CorpusSnapshotV1, selection: ResolvedSelection, group: TermGroupSpec): string =>
  JSON.stringify([snapshot.id, selection.hash, termGroupIdentity(group)]);

/** Ordered matching identities determine the numeric rank axis; presentation
 * ids are deliberately excluded. */
const matchesAxisCacheKey = (
  snapshot: CorpusSnapshotV1,
  selection: ResolvedSelection,
  tracks: readonly { readonly group: TermGroupSpec }[],
): string => JSON.stringify([
  snapshot.id,
  selection.hash,
  tracks.map((track) => termGroupIdentity(track.group)),
]);

/** [SnapshotId, DocId, canonical per-doc range key]. `snapshot.id`
 * transitively pins the document's IndexArtifactHash; `rangeKey` comes only
 * from an already-canonicalized ResolvedSelection. */
const termCountsCacheKey = (
  snapshot: CorpusSnapshotV1,
  doc: string,
  rangeKey: string,
): string => JSON.stringify([snapshot.id, doc, rangeKey]);

/** An async checkpoint injected per call: yields control, then gates on the
 *  caller's cancellation/supersession state (throwing to unwind). */
export type QueryCheckpoint = () => Promise<void>;

/** The read-only published state a query executes against. */
export interface PublishedView {
  readonly snapshot: CorpusSnapshotV1;
  readonly ready: ReadonlyMap<string, ReadyDocument>;
  readonly bound: BoundShards;
  readonly boundTexts: BoundTexts;
}

/** Test seam may only REDUCE the production hard bounds. */
export interface TermCountCachePolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface OccurrenceCachePolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
}
export interface MatchesAxisCachePolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
}
const DEFAULT_OCCURRENCE_CACHE_POLICY: OccurrenceCachePolicy = {
  maxEntries: MAX_OCCURRENCE_CACHE_ENTRIES,
  maxBytes: MAX_OCCURRENCE_CACHE_BYTES,
};
const DEFAULT_TERM_COUNT_CACHE_POLICY: TermCountCachePolicy = {
  maxEntries: TERM_COUNT_CACHE_MAX_ENTRIES,
  maxBytes: TERM_COUNT_CACHE_MAX_BYTES,
};
const DEFAULT_MATCHES_AXIS_CACHE_POLICY: MatchesAxisCachePolicy = {
  maxEntries: MAX_MATCHES_AXIS_CACHE_ENTRIES,
  maxBytes: MAX_MATCHES_AXIS_CACHE_BYTES,
};

interface TermCountCacheEntry {
  readonly doc: string;
  readonly bytes: number;
  readonly value: DocTermCountsV1;
}

interface OccurrenceCacheEntry {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly bytes: number;
  readonly value: NumericOccurrences;
}

interface MatchesAxisCacheEntry {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly bytes: number;
  readonly value: MatchesAxisV1;
}

export class QueryExecutor {
  /** Per-doc, per-mode resolver reuse. A commit that replaces a document's
   *  shard resets that document's map (`publish`); `resolverFor` additionally
   *  verifies the cached resolver still points at the resident shard. */
  private readonly resolvers = new Map<string, Map<string, Resolver>>();
  /** Ephemeral occurrence cache SHARED by trend and Matches
   *  (Phase E, moved verbatim): keyed by [SnapshotId, SelectionHash,
   *  termGroupIdentity] — the canonical MATCHING identity, never the
   *  caller-owned group.id. Insertion order is LRU recency; every miss
   *  prunes synchronously to simultaneous entry and byte ceilings. An evicted
   *  entry is recomputed on its next query; an in-flight request already owns
   *  its reference. Publishing a new snapshot drops every old-snapshot entry;
   *  superseded selections within the current snapshot age out by LRU.
   *
   *  The kernel bounds construction memory, but occurrences() remains
   *  synchronous: cancellation can still wait for one capped computation. */
  private readonly occurrenceCache = new Map<string, OccurrenceCacheEntry>();
  private occurrenceCacheBytes = 0;
  /** Small sparse rank axes. Entries contain no occurrence-vector references;
   * the shared occurrence LRU remains the only owner of those large buffers. */
  private readonly matchesAxisCache = new Map<string, MatchesAxisCacheEntry>();
  private matchesAxisCacheBytes = 0;
  /** Sparse per-document selection counts shared by inventory, frequency, and
   * keyness. Insertion order is LRU recency. The entry and byte bounds are
   * simultaneous hard ceilings; output materializers must never transfer or
   * mutate these cached buffers. */
  private readonly termCountCache = new Map<string, TermCountCacheEntry>();
  private termCountCacheBytes = 0;
  private view: PublishedView | null = null;

  constructor(
    private readonly indexRecipe: IndexRecipeProvisional,
    private readonly loadResolver: typeof buildResolver = buildResolver,
    private readonly termCountCachePolicy: TermCountCachePolicy = DEFAULT_TERM_COUNT_CACHE_POLICY,
    private readonly occurrenceCachePolicy: OccurrenceCachePolicy = DEFAULT_OCCURRENCE_CACHE_POLICY,
    private readonly matchesAxisCachePolicy: MatchesAxisCachePolicy = DEFAULT_MATCHES_AXIS_CACHE_POLICY,
  ) {
    if (
      !Number.isSafeInteger(termCountCachePolicy.maxEntries) ||
      termCountCachePolicy.maxEntries <= 0 ||
      termCountCachePolicy.maxEntries > TERM_COUNT_CACHE_MAX_ENTRIES ||
      !Number.isSafeInteger(termCountCachePolicy.maxBytes) ||
      termCountCachePolicy.maxBytes <= 0 ||
      termCountCachePolicy.maxBytes > TERM_COUNT_CACHE_MAX_BYTES
    ) {
      throw new RangeError('term-count cache policy may only reduce the exported hard bounds');
    }
    if (
      !Number.isSafeInteger(occurrenceCachePolicy.maxEntries) ||
      occurrenceCachePolicy.maxEntries <= 0 ||
      occurrenceCachePolicy.maxEntries > MAX_OCCURRENCE_CACHE_ENTRIES ||
      !Number.isSafeInteger(occurrenceCachePolicy.maxBytes) ||
      occurrenceCachePolicy.maxBytes <= 0 ||
      occurrenceCachePolicy.maxBytes > MAX_OCCURRENCE_CACHE_BYTES
    ) {
      throw new RangeError('occurrence cache policy may only reduce the exported hard bounds');
    }
    if (
      !Number.isSafeInteger(matchesAxisCachePolicy.maxEntries)
      || matchesAxisCachePolicy.maxEntries <= 0
      || matchesAxisCachePolicy.maxEntries > MAX_MATCHES_AXIS_CACHE_ENTRIES
      || !Number.isSafeInteger(matchesAxisCachePolicy.maxBytes)
      || matchesAxisCachePolicy.maxBytes <= 0
      || matchesAxisCachePolicy.maxBytes > MAX_MATCHES_AXIS_CACHE_BYTES
    ) {
      throw new RangeError('matches-axis cache policy may only reduce the exported hard bounds');
    }
  }

  /** Adopt a newly published snapshot view. Replaced documents drop their
   *  resolver maps — a retained map would hold resolvers bound to a replaced
   *  shard. The occurrence cache needs no reset: superseded snapshots key
   *  distinctly and age out of the bounded LRU. */
  publish(view: PublishedView, replacedDocs: Iterable<string>): void {
    this.view = view;
    for (const [key, entry] of this.occurrenceCache) {
      if (entry.snapshot === view.snapshot.id) continue;
      this.occurrenceCache.delete(key);
      this.occurrenceCacheBytes -= entry.bytes;
    }
    for (const [key, entry] of this.matchesAxisCache) {
      if (entry.snapshot === view.snapshot.id) continue;
      this.matchesAxisCache.delete(key);
      this.matchesAxisCacheBytes -= entry.bytes;
    }
    const replaced = new Set(replacedDocs);
    for (const doc of replaced) this.resolvers.set(doc, new Map());
    if (replaced.size > 0) {
      for (const [key, entry] of this.termCountCache) {
        if (!replaced.has(entry.doc)) continue;
        this.termCountCache.delete(key);
        this.termCountCacheBytes -= entry.bytes;
      }
    }
  }

  /** The published view, asserted — the engine validates snapshot identity
   *  BEFORE dispatching, so a missing view here is an invariant fault. */
  private published(): PublishedView {
    if (!this.view) throw new Error('query executed before any publication');
    return this.view;
  }

  private async resolverFor(doc: string, mode: MatchMode): Promise<Resolver> {
    const ready = this.published().ready.get(doc);
    let byMode = this.resolvers.get(doc);
    if (!byMode) {
      byMode = new Map();
      this.resolvers.set(doc, byMode);
    }
    if (!ready) throw new DependencyError('shard', doc);
    const key = modeKey(mode);
    let resolver = byMode.get(key);
    if (!resolver || resolver.shard !== ready.shard) {
      resolver = await this.loadResolver(ready.shard, this.indexRecipe, mode);
      byMode.set(key, resolver);
    }
    return resolver;
  }

  /** Lookup/touch/compute/prune on the shared occurrence cache — the ONE
   *  cache discipline for both query branches (contract on the field). */
  private occurrencesFor(
    shards: ReadonlyMap<string, DocumentIndexV1>,
    resolvers: ReadonlyMap<string, ReadonlyMap<string, Resolver>>,
    selection: ResolvedSelection,
    group: TermGroupSpec,
  ): NumericOccurrences {
    const snapshot = this.published().snapshot;
    const key = occurrenceCacheKey(snapshot, selection, group);
    const hit = this.occurrenceCache.get(key);
    if (hit) {
      // Touch → most-recently-used (Map preserves insertion order as recency).
      this.occurrenceCache.delete(key);
      this.occurrenceCache.set(key, hit);
      return hit.value;
    }
    const occ = occurrences(snapshot, shards, resolvers, selection, group);
    validateOccurrenceOrder(snapshot, occ);
    const bytes = occurrencePayloadBytes(occ);
    this.occurrenceCache.set(key, { snapshot: snapshot.id, bytes, value: occ });
    this.occurrenceCacheBytes += bytes;
    while (
      this.occurrenceCache.size > this.occurrenceCachePolicy.maxEntries
      || this.occurrenceCacheBytes > this.occurrenceCachePolicy.maxBytes
    ) {
      const oldest = this.occurrenceCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.occurrenceCache.get(oldest);
      this.occurrenceCache.delete(oldest);
      if (evicted) this.occurrenceCacheBytes -= evicted.bytes;
    }
    return occ;
  }

  private matchesAxisFor(
    selection: ResolvedSelection,
    tracks: readonly { readonly group: TermGroupSpec }[],
    occurrences: readonly NumericOccurrences[],
  ): MatchesAxisV1 {
    const { snapshot } = this.published();
    const key = matchesAxisCacheKey(snapshot, selection, tracks);
    const hit = this.matchesAxisCache.get(key);
    if (hit) {
      this.matchesAxisCache.delete(key);
      this.matchesAxisCache.set(key, hit);
      return hit.value;
    }
    const value = buildMatchesAxis(snapshot, selection, occurrences);
    const bytes = matchesAxisPayloadBytes(value);
    this.matchesAxisCache.set(key, { snapshot: snapshot.id, bytes, value });
    this.matchesAxisCacheBytes += bytes;
    while (
      this.matchesAxisCache.size > this.matchesAxisCachePolicy.maxEntries
      || this.matchesAxisCacheBytes > this.matchesAxisCachePolicy.maxBytes
    ) {
      const oldest = this.matchesAxisCache.entries().next().value as
        | [string, MatchesAxisCacheEntry]
        | undefined;
      if (!oldest) break;
      this.matchesAxisCache.delete(oldest[0]);
      this.matchesAxisCacheBytes -= oldest[1].bytes;
    }
    return value;
  }

  /** The selected documents' resident shards (DependencyError on a gap). */
  private shardsFor(selection: ResolvedSelection): Map<string, DocumentIndexV1> {
    const ready = this.published().ready;
    const shards = new Map<string, DocumentIndexV1>();
    for (const id of selection.spec.docs) {
      const r = ready.get(id);
      if (!r) throw new DependencyError('shard', id);
      shards.set(id, r.shard);
    }
    return shards;
  }

  /** Lookup/touch/compute/prune for the ONE aggregation cache. The key is
   * immutable because snapshot.id hashes the ref's IndexArtifactHash and the
   * per-doc range key is derived from canonical ResolvedSelection ranges.
   * Replaced docs are also dropped eagerly by publish. */
  private termCountsFor(
    selection: ResolvedSelection,
    doc: string,
  ): DocTermCountsV1 {
    const { snapshot, ready } = this.published();
    if (selection.snapshot !== snapshot.id) {
      throw new RangeError('selection is bound to a different snapshot');
    }
    const ref = snapshot.docs.find((candidate) => candidate.doc === doc);
    const resident = ready.get(doc);
    if (!ref || !selection.docSet.has(ref.doc)) {
      throw new RangeError(`document '${doc}' is outside the selection`);
    }
    if (!resident) throw new DependencyError('shard', doc);
    const ranges = selection.rangesByDoc.get(ref.doc) ?? null;
    const rangeKey = termCountRangeKey(ranges, ref.tokenCount);
    const key = termCountsCacheKey(snapshot, doc, rangeKey);
    const hit = this.termCountCache.get(key);
    if (hit) {
      this.termCountCache.delete(key);
      this.termCountCache.set(key, hit);
      return hit.value;
    }

    const value = documentTermCounts(snapshot, ref, resident.shard, ranges);
    const entry: TermCountCacheEntry = {
      doc,
      bytes: termCountPayloadBytes(value),
      value,
    };
    this.termCountCache.set(key, entry);
    this.termCountCacheBytes += entry.bytes;
    while (
      this.termCountCache.size > this.termCountCachePolicy.maxEntries ||
      this.termCountCacheBytes > this.termCountCachePolicy.maxBytes
    ) {
      const oldest = this.termCountCache.entries().next().value as
        | [string, TermCountCacheEntry]
        | undefined;
      if (!oldest) break;
      this.termCountCache.delete(oldest[0]);
      this.termCountCacheBytes -= oldest[1].bytes;
    }
    return value;
  }

  /** Materialize the selected documents' cached vectors in canonical
   * selection order. This is an executor-internal operation seam, not a wire
   * QueryOp; inventory/frequency/keyness fold it and copy anything they emit. */
  async termCounts(
    selection: ResolvedSelection,
    checkpoint: QueryCheckpoint,
  ): Promise<readonly DocTermCountsV1[]> {
    const values: DocTermCountsV1[] = [];
    for (const doc of selection.spec.docs) {
      values.push(this.termCountsFor(selection, doc));
      await checkpoint();
    }
    return values;
  }

  async inventory(
    selection: ResolvedSelection,
    request: InventoryRequestV1,
    checkpoint: QueryCheckpoint,
  ): Promise<InventoryResultV1> {
    const { snapshot } = this.published();
    const inputs = await this.aggregationInputs(selection, checkpoint);
    return computeInventory(
      snapshot,
      selection,
      inputs,
      request,
      checkpoint,
    );
  }

  private async aggregationInputs(
    selection: ResolvedSelection,
    checkpoint: QueryCheckpoint,
  ): Promise<readonly InventoryDocumentInputV1[]> {
    const { snapshot, ready } = this.published();
    const counts = await this.termCounts(selection, checkpoint);
    return counts.map((value, index) => {
      const doc = selection.spec.docs[index] as string;
      const ref = snapshot.docs.find((candidate) => candidate.doc === doc);
      const resident = ready.get(doc);
      if (!ref) throw new RangeError(`document '${doc}' is outside the snapshot`);
      if (!resident) throw new DependencyError('shard', doc);
      return { ref, shard: resident.shard, counts: value };
    });
  }

  async frequencyList(
    selection: ResolvedSelection,
    request: FrequencyListRequestV1,
    checkpoint: QueryCheckpoint,
  ): Promise<FrequencyListResultV1> {
    const { snapshot } = this.published();
    const inputs = await this.aggregationInputs(selection, checkpoint);
    return computeFrequencyList(snapshot, selection, inputs, request, checkpoint);
  }

  async keyness(
    selectionA: ResolvedSelection,
    selectionB: ResolvedSelection,
    request: KeynessTableRequestV1,
    checkpoint: QueryCheckpoint,
  ): Promise<KeynessResultV1> {
    const { snapshot } = this.published();
    const inputsA = await this.aggregationInputs(selectionA, checkpoint);
    const inputsB = await this.aggregationInputs(selectionB, checkpoint);
    return computeKeyness(
      snapshot,
      selectionA,
      selectionB,
      inputsA,
      inputsB,
      request,
      checkpoint,
    );
  }

  async trend(
    selection: ResolvedSelection,
    group: TermGroupSpec,
    request: TrendRequest,
    checkpoint: QueryCheckpoint,
  ): Promise<NumericTrend> {
    const snapshot = this.published().snapshot;
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const member of group.members) byMode.set(modeKey(member.match), await this.resolverFor(id, member.match));
      resolvers.set(id, byMode);
    }
    await checkpoint();
    const occ = this.occurrencesFor(shards, resolvers, selection, group);
    await checkpoint();
    const data = trend(snapshot, selection, occ, request);
    // Final kernel checkpoint: a cancel queued during the trend kernel is
    // observed HERE, before the caller's sync gate + emit (race parity with
    // the pre-extraction engine).
    await checkpoint();
    return data;
  }

  /** dispersion/1 (slice-2 ruling §C): adaptive exact/density per track over
   *  the SAME cached occurrence primitive as trend/Matches — this method never
   *  resolves members or interprets overlap semantics itself. Geometry is
   *  planned once, lazily, only when some track crosses the exact threshold.
   *  All output arrays are FRESH (packers copy) — transferring them can
   *  never detach the occurrence cache's buffers. */
  async dispersion(
    selection: ResolvedSelection,
    tracks: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    checkpoint: QueryCheckpoint,
  ): Promise<DispersionResultV1> {
    const snapshot = this.published().snapshot;
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) {
          const mk = modeKey(member.match);
          if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(id, member.match));
        }
      }
      resolvers.set(id, byMode);
    }
    await checkpoint();

    // Bridge SNAPSHOT ordinals (NumericOccurrences.docOrdinal) to SELECTED
    // slots — a subset selection must land in slot 0, never out of bounds.
    const slotMap = selectionSlotMap(snapshot, selection);
    let geometry: ReturnType<typeof planDispersionGeometry> | null = null;
    const out: DispersionTrackV1[] = [];
    for (const track of tracks) {
      const occ = this.occurrencesFor(shards, resolvers, selection, track.group);
      await checkpoint(); // per-track gate, as in Matches
      const total = occ.pos.length;
      if (total <= DISPERSION_EXACT_MAX) {
        out.push({ seriesId: track.seriesId, groupId: track.group.id, total, data: packExactTrack(occ, slotMap, selection.spec.docs.length) });
      } else {
        geometry ??= planDispersionGeometry(snapshot, selection);
        out.push({ seriesId: track.seriesId, groupId: track.group.id, total, data: await packDensityTrack(occ, geometry, slotMap, checkpoint) });
      }
      await checkpoint();
    }
    return { method: 'dispersion/1', geometry, tracks: out };
  }

  /** reader-page/1: a bounded directional source slice over ONE
   *  document, marks sliced from the SAME cached occurrences as every other
   *  lane (computed under the BASE selection the engine passes — never a
   *  slice-local matcher, so countOverlaps/merged-span/member semantics and
   *  cross-slice straddlers are preserved). Zero tracks reads plain text. */
  async readerPage(
    selection: ResolvedSelection,
    tracks: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    request: { readonly doc: string; readonly cursor: Parameters<typeof planReaderPage>[3]; readonly maxTokens: number },
    checkpoint: QueryCheckpoint,
  ): Promise<ReturnType<typeof materializeReaderPage>> {
    const { snapshot, boundTexts, ready: readyMap } = this.published();
    const ready = readyMap.get(request.doc);
    if (!ready) throw new DependencyError('shard', request.doc);
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) {
          const mk = modeKey(member.match);
          if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(id, member.match));
        }
      }
      resolvers.set(id, byMode);
    }
    await checkpoint();
    const trackOccs = [];
    for (const track of tracks) {
      trackOccs.push(this.occurrencesFor(shards, resolvers, selection, track.group));
      await checkpoint();
    }
    const plan = planReaderPage(snapshot, request.doc, ready.shard, request.cursor, request.maxTokens, trackOccs);
    await checkpoint();
    const page = materializeReaderPage(
      snapshot,
      plan,
      boundTexts,
      tracks.map((track) => ({ seriesId: track.seriesId, groupId: track.group.id })),
    );
    await checkpoint(); // final kernel checkpoint (race parity)
    return page;
  }

  /** occurrence-step/1: the nearest exact hit from ANY active track, using the
   * SAME full-corpus occurrence cache as trends, dispersion, KWIC, and Reader.
   * At the corpus edge it cycles once to the opposite edge. The output remains
   * bounded and contains no view into the cached typed arrays. */
  async occurrenceStep(
    selection: ResolvedSelection,
    tracks: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    request: OccurrenceStepRequestV1,
    checkpoint: QueryCheckpoint,
  ): Promise<{
    readonly seriesId: string;
    readonly groupId: string;
    readonly step: OccurrenceStepResultV1;
  }> {
    if (tracks.length === 0) throw new RangeError('occurrence stepping requires an active track');
    const { snapshot } = this.published();
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) {
          const mk = modeKey(member.match);
          if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(id, member.match));
        }
      }
      resolvers.set(id, byMode);
    }
    await checkpoint();
    const candidates: {
      readonly track: (typeof tracks)[number];
      readonly occurrences: NumericOccurrences;
      readonly step: OccurrenceStepResultV1;
    }[] = [];
    for (const track of tracks) {
      const occ = this.occurrencesFor(shards, resolvers, selection, track.group);
      candidates.push({
        track,
        occurrences: occ,
        step: occurrenceStep(snapshot, selection, occ, request),
      });
      await checkpoint();
    }
    const globalPosition = (candidate: (typeof candidates)[number]): number => {
      const hit = candidate.step.hit;
      if (hit === null) return request.direction === 1
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
      const ref = snapshot.docs.find((document) => document.doc === hit.doc);
      if (!ref) throw new RangeError(`occurrence step returned unknown document '${hit.doc}'`);
      return ref.sequenceTokenBase + hit.token;
    };
    const nearest = (values: readonly (typeof candidates)[number][]) => values.reduce<
      (typeof candidates)[number] | null
    >((best, candidate) => {
      if (candidate.step.hit === null) return best;
      if (best === null) return candidate;
      const position = globalPosition(candidate);
      const bestPosition = globalPosition(best);
      return request.direction === 1
        ? position < bestPosition ? candidate : best
        : position > bestPosition ? candidate : best;
    }, null);
    let chosen = nearest(candidates);
    if (chosen === null) {
      chosen = nearest(candidates.map((candidate) => ({
        ...candidate,
        step: occurrenceStep(
          snapshot,
          selection,
          candidate.occurrences,
          request,
          true,
        ),
      })));
    }
    await checkpoint();
    const result = chosen ?? candidates[0]!;
    return {
      seriesId: result.track.seriesId,
      groupId: result.track.group.id,
      step: result.step,
    };
  }

  /** Full-corpus continuous Matches over the shared occurrence cache. */
  async matchesWindow(
    selection: ResolvedSelection,
    tracks: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    request: MatchesWindowRequestV1,
    includeAxis: boolean,
    checkpoint: QueryCheckpoint,
  ): Promise<{
    readonly window: MatchesWindowV1;
    readonly axis?: MatchesAxisArraysV1;
  }> {
    const { snapshot, bound, boundTexts } = this.published();
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const track of tracks) {
        for (const member of track.group.members) {
          const mk = modeKey(member.match);
          if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(id, member.match));
        }
      }
      resolvers.set(id, byMode);
    }
    await checkpoint();

    const trackOccurrences: NumericOccurrences[] = [];
    for (const track of tracks) {
      trackOccurrences.push(this.occurrencesFor(shards, resolvers, selection, track.group));
      await checkpoint();
    }
    const axis = this.matchesAxisFor(selection, tracks, trackOccurrences);
    const numeric = planMatchesWindow(
      snapshot,
      bound,
      selection,
      axis,
      trackOccurrences,
      request,
    );
    await checkpoint();
    const window = materializeMatchesWindow(
      snapshot,
      numeric,
      boundTexts,
      tracks.map((track) => ({ seriesId: track.seriesId, groupId: track.group.id })),
    );
    await checkpoint();
    return includeAxis ? { window, axis: copyMatchesAxis(axis) } : { window };
  }

}
