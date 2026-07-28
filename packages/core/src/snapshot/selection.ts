/**
 * Selection canonicalization — Phase 1 plan, Milestone 1; contract §6.
 *
 * A SelectionSpec is user/project intent; a ResolvedSelection is the
 * snapshot-bound execution primitive carrying the CANONICALIZED spec (the
 * contract shape): documents follow the snapshot's declared order (never
 * spec order), must be composed (ready) in the snapshot, and appear once;
 * ranges are per-document token ranges — half-open, non-empty, in-bounds,
 * emitted in declared-document then start order, merged on overlap or
 * adjacency. The hash is COMPUTED here — never accepted from a caller.
 */

import type { DocTokenPos, HalfOpenRange, ProjectDocId, SelectionHash } from '../contract/brands.ts';
import { canonicalJson, sha256Hex } from '../contract/hash.ts';
import type { CorpusSnapshotV1 } from './compose.ts';

interface SelectionSpec {
  readonly docs: readonly ProjectDocId[];
  readonly ranges?: readonly { readonly doc: ProjectDocId; readonly tokens: HalfOpenRange<DocTokenPos> }[];
}

/** Half-open document-local token range. */
export interface TokenRangeSpan {
  readonly start: number;
  readonly end: number;
}

export interface ResolvedSelection {
  readonly snapshot: CorpusSnapshotV1['id'];
  /** Canonicalized spec — contract §6 shape, declared-doc/start order. */
  readonly spec: SelectionSpec;
  readonly hash: SelectionHash;
  /** EXECUTION INDEX (derived from `spec`, eager): selected-doc membership.
   *  Never serialized — the contract and the hash are fed by `spec` alone. */
  readonly docSet: ReadonlySet<ProjectDocId>;
  /** EXECUTION INDEX (derived from `spec`, eager): canonical merged token
   *  ranges per document; a doc absent here is selected in full. Never
   *  serialized — the contract and the hash are fed by `spec` alone. */
  readonly rangesByDoc: ReadonlyMap<ProjectDocId, readonly TokenRangeSpan[]>;
}

export async function resolveSelection(
  snapshot: CorpusSnapshotV1,
  spec: SelectionSpec,
): Promise<ResolvedSelection> {
  const requested = new Set(spec.docs);
  if (requested.size !== spec.docs.length) {
    throw new RangeError('selection docs must be unique');
  }
  const composed = new Map(snapshot.docs.map((r) => [r.doc, r]));
  for (const doc of spec.docs) {
    if (!composed.has(doc)) {
      throw new RangeError(`selection references document '${doc}' not composed in the snapshot`);
    }
  }
  // Snapshot-declared order, never spec order.
  const docs = snapshot.docs.map((r) => r.doc).filter((d) => requested.has(d));

  const byDoc = new Map<ProjectDocId, { start: number; end: number }[]>();
  if (spec.ranges) {
    for (const r of spec.ranges) {
      const ref = composed.get(r.doc);
      if (!ref || !requested.has(r.doc)) {
        throw new RangeError(`range references document '${r.doc}' outside the selection`);
      }
      const start = r.tokens.start as number;
      const end = r.tokens.end as number;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) {
        throw new RangeError(`invalid range [${start}, ${end}) for '${r.doc}'`);
      }
      if (end > ref.tokenCount) {
        throw new RangeError(
          `range [${start}, ${end}) exceeds '${r.doc}' token count ${ref.tokenCount}`,
        );
      }
      const list = byDoc.get(r.doc);
      if (list) list.push({ start, end });
      else byDoc.set(r.doc, [{ start, end }]);
    }
    for (const [doc, list] of byDoc) {
      list.sort((a, b) => a.start - b.start || a.end - b.end);
      const merged: { start: number; end: number }[] = [];
      for (const r of list) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
        else merged.push({ ...r });
      }
      byDoc.set(doc, merged);
    }
  }

  // Canonical ranges: declared-document order, then start order — independent
  // of caller input order (round-3 review finding).
  const ranges = docs.flatMap((doc) =>
    (byDoc.get(doc) ?? []).map((r) => ({
      doc,
      tokens: { start: r.start as DocTokenPos, end: r.end as DocTokenPos },
    })),
  );

  const canonicalSpec: SelectionSpec =
    ranges.length > 0 ? { docs, ranges } : { docs };

  // The hash is fed by the canonical spec ALONE — the execution indexes
  // below are derived views and must never widen this serialization.
  const hash = (await sha256Hex(
    canonicalJson({
      snapshot: snapshot.id,
      docs,
      ranges: ranges.map((r) => ({ doc: r.doc, start: r.tokens.start, end: r.tokens.end })),
    }),
  )) as SelectionHash;

  // Execution indexes (eager): membership set + canonical merged ranges per
  // doc, so kernels never rebuild them per call. Docs without ranges are
  // absent from the map — absent means "whole document".
  const docSet: ReadonlySet<ProjectDocId> = new Set(docs);
  const rangesByDoc = new Map<ProjectDocId, readonly TokenRangeSpan[]>();
  for (const doc of docs) {
    const merged = byDoc.get(doc);
    if (merged) rangesByDoc.set(doc, merged);
  }

  return { snapshot: snapshot.id, spec: canonicalSpec, hash, docSet, rangesByDoc };
}
