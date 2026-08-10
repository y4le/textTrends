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
  buildResolver,
  documentTermCounts,
  DISPERSION_EXACT_MAX,
  packDensityTrack,
  packExactTrack,
  planDispersionGeometry,
  planReaderPage,
  materializeReaderPage,
  selectionSlotMap,
  type DispersionResultV1,
  type DispersionTrackV1,
  kwicPage,
  MAX_KWIC_TRACKS,
  materializeKwicPage,
  modeKey,
  occurrences,
  occurrenceStep,
  validateOccurrenceOrder,
  occurrencePayloadBytes,
  trend,
  type CorpusSnapshotV1,
  type DocumentIndexV1,
  type KwicRequest,
  type KwicRow,
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

/** [SnapshotId, SelectionHash, termGroupIdentity] — the tuple that fully
 *  determines one raw `NumericOccurrences` (see the cache contract below). */
const occurrenceCacheKey = (snapshot: CorpusSnapshotV1, selection: ResolvedSelection, group: TermGroupSpec): string =>
  JSON.stringify([snapshot.id, selection.hash, termGroupIdentity(group)]);

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
const DEFAULT_OCCURRENCE_CACHE_POLICY: OccurrenceCachePolicy = {
  maxEntries: MAX_OCCURRENCE_CACHE_ENTRIES,
  maxBytes: MAX_OCCURRENCE_CACHE_BYTES,
};
const DEFAULT_TERM_COUNT_CACHE_POLICY: TermCountCachePolicy = {
  maxEntries: TERM_COUNT_CACHE_MAX_ENTRIES,
  maxBytes: TERM_COUNT_CACHE_MAX_BYTES,
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

export class QueryExecutor {
  /** Per-doc, per-mode resolver reuse. A commit that replaces a document's
   *  shard resets that document's map (`publish`); `resolverFor` additionally
   *  verifies the cached resolver still points at the resident shard. */
  private readonly resolvers = new Map<string, Map<string, Resolver>>();
  /** Ephemeral occurrence cache SHARED by the trend and kwic branches
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
   *  the SAME cached occurrence primitive as trend/kwic — this method never
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
      await checkpoint(); // per-track gate, as in kwic
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

  /** reader-page/1 (slice-2 ruling §G): a bounded cursor page over ONE
   *  document, marks sliced from the SAME cached occurrences as every other
   *  lane (computed under the BASE selection the engine passes — never a
   *  page-local matcher, so countOverlaps/merged-span/member semantics and
   *  cross-page straddlers are preserved). Zero tracks reads plain text. */
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

  /** occurrence-step/1: one exact hit from the SAME full-corpus occurrence
   * cache as trends, dispersion, KWIC, and Reader. The output is bounded and
   * contains no transferable view into the cached typed arrays. */
  async occurrenceStep(
    selection: ResolvedSelection,
    track: { readonly seriesId: string; readonly group: TermGroupSpec },
    request: OccurrenceStepRequestV1,
    checkpoint: QueryCheckpoint,
  ): Promise<OccurrenceStepResultV1> {
    const { snapshot } = this.published();
    const shards = this.shardsFor(selection);
    const resolvers = new Map<string, Map<string, Resolver>>();
    for (const id of selection.spec.docs) {
      const byMode = new Map<string, Resolver>();
      for (const member of track.group.members) {
        const mk = modeKey(member.match);
        if (!byMode.has(mk)) byMode.set(mk, await this.resolverFor(id, member.match));
      }
      resolvers.set(id, byMode);
    }
    await checkpoint();
    const occ = this.occurrencesFor(shards, resolvers, selection, track.group);
    await checkpoint();
    const step = occurrenceStep(snapshot, selection, occ, request);
    await checkpoint();
    return step;
  }

  /** kwic/2: UNION every track's required match modes per doc (never rebuild
   *  a duplicate resolver), then compute occurrences PER track and merge in
   *  the numeric kernel. Checkpoint after resolver prep, after EACH track
   *  (a cancel raised while a track resolved must stop before the next track
   *  computes — see the phase-tied cancel tests), after numeric planning,
   *  and after materialization is the CALLER's final gate. */
  async kwic(
    selection: ResolvedSelection,
    tracks: readonly { readonly seriesId: string; readonly group: TermGroupSpec }[],
    request: KwicRequest,
    checkpoint: QueryCheckpoint,
  ): Promise<{ total: number; rows: readonly KwicRow[] }> {
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

    // Re-centering reissues with the same snapshot/selection/tracks and only
    // a new `center`; each track is served from the shared occurrence cache
    // (also warmed by trend queries over the same tuple), so a re-center pays
    // only for the top-K ordering + text slicing below.
    const trackOccs: NumericOccurrences[] = [];
    for (const track of tracks) {
      trackOccs.push(this.occurrencesFor(shards, resolvers, selection, track.group));
      await checkpoint();
    }
    const page = kwicPage(snapshot, bound, selection, trackOccs, request);
    await checkpoint();
    const trackTable = tracks.map((t) => ({ seriesId: t.seriesId, groupId: t.group.id }));
    const rows = materializeKwicPage(snapshot, page, boundTexts, trackTable);
    await checkpoint(); // final kernel checkpoint (race parity, as in trend)
    return { total: page.total, rows };
  }
}
