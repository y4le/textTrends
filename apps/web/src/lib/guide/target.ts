import type { DispersionResultV1, DispersionTrackV1 } from '@texttrends/core';
import type { ReaderOpenIntent } from '../reader-intent.ts';

export interface GuideTermFacts {
  readonly seriesId: string;
  readonly label: string;
}

export interface GuideDispersionFacts {
  readonly snapshotId: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly result: DispersionResultV1 }
    | { readonly status: 'error'; readonly message: string };
}

export interface GuideTargetInput {
  readonly snapshotId: string | null;
  /** The dispersion CSR axis and the declared text-order tie break. */
  readonly readyDocs: readonly string[];
  /** Shown terms in notebook order. */
  readonly shownTerms: readonly GuideTermFacts[];
  readonly dispersion: GuideDispersionFacts | null;
  readonly tokenCountOf: (doc: string) => number | undefined;
}

interface GuideTargetBase {
  readonly seriesId: string;
  readonly label: string;
  readonly doc: string;
  readonly token: number;
  readonly intent: ReaderOpenIntent;
}

export type GuideTarget =
  | (GuideTargetBase & { readonly kind: 'exact' })
  | (GuideTargetBase & {
      readonly kind: 'density';
      readonly bucketCount: number;
    });

export type GuideTargetUnavailable =
  | 'no-corpus'
  | 'no-shown-term'
  | 'no-occurrences'
  | 'failed';

export type GuideTargetResolution =
  | { readonly status: 'ready'; readonly target: GuideTarget }
  | {
      readonly status: 'pending';
      readonly reason: 'dispersion' | 'superseded' | 'extents';
    }
  | { readonly status: 'unavailable'; readonly reason: GuideTargetUnavailable };

const failed = (): GuideTargetResolution => ({
  status: 'unavailable',
  reason: 'failed',
});

function positiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function candidateTrack(
  tracks: readonly DispersionTrackV1[],
  kind: DispersionTrackV1['data']['kind'],
  shownOrder: ReadonlyMap<string, number>,
): DispersionTrackV1 | null {
  let chosen: DispersionTrackV1 | null = null;
  let chosenOrder = Number.POSITIVE_INFINITY;
  for (const track of tracks) {
    const order = shownOrder.get(track.seriesId);
    if (order === undefined || track.data.kind !== kind || track.total <= 0) continue;
    if (
      chosen === null
      || track.total > chosen.total
      || (track.total === chosen.total && order < chosenOrder)
    ) {
      chosen = track;
      chosenOrder = order;
    }
  }
  return chosen;
}

function readerIntent(
  snapshot: string,
  doc: string,
  token: number,
  anchor: ReaderOpenIntent['anchor'],
): ReaderOpenIntent {
  return { snapshot, doc, token, from: 'barcode', anchor };
}

function exactTarget(
  input: GuideTargetInput,
  track: DispersionTrackV1 & { readonly data: Extract<DispersionTrackV1['data'], { kind: 'exact' }> },
  label: string,
): GuideTargetResolution {
  const { docOffsets, starts, spanTokens } = track.data;
  if (
    docOffsets.length !== input.readyDocs.length + 1
    || docOffsets[0] !== 0
    || starts.length !== spanTokens.length
    || starts.length !== track.total
    || docOffsets[docOffsets.length - 1] !== starts.length
  ) return failed();

  let previous = 0;
  let occurrenceDocs = 0;
  const candidates: { readonly d: number; readonly extent: number }[] = [];
  for (let d = 0; d < input.readyDocs.length; d++) {
    const from = docOffsets[d];
    const to = docOffsets[d + 1];
    if (from === undefined || to === undefined || from < previous || to < from || to > starts.length) {
      return failed();
    }
    previous = to;
    if (to === from) continue;
    occurrenceDocs++;
    const doc = input.readyDocs[d]!;
    const extent = input.tokenCountOf(doc);
    if (extent === undefined) continue;
    if (!positiveSafeInteger(extent)) return failed();
    for (let i = from; i < to; i++) {
      const token = starts[i];
      const span = spanTokens[i];
      if (
        token === undefined
        || span === undefined
        || token >= extent
        || span < 1
        || token + span > extent
      ) return failed();
    }
    candidates.push({ d, extent });
  }
  if (occurrenceDocs === 0) return failed();
  if (candidates.length === 0) return { status: 'pending', reason: 'extents' };

  let chosenDoc = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.extent > chosenDoc.extent) chosenDoc = candidate;
  }
  const from = docOffsets[chosenDoc.d]!;
  const to = docOffsets[chosenDoc.d + 1]!;
  const midpoint = Math.floor(chosenDoc.extent / 2);
  let token = starts[from]!;
  let distance = Math.abs(token - midpoint);
  for (let i = from + 1; i < to; i++) {
    const candidate = starts[i]!;
    const candidateDistance = Math.abs(candidate - midpoint);
    if (candidateDistance < distance || (candidateDistance === distance && candidate < token)) {
      token = candidate;
      distance = candidateDistance;
    }
  }
  const doc = input.readyDocs[chosenDoc.d]!;
  return {
    status: 'ready',
    target: {
      kind: 'exact',
      seriesId: track.seriesId,
      label,
      doc,
      token,
      intent: readerIntent(input.snapshotId!, doc, token, 'occurrence'),
    },
  };
}

function densityTarget(
  input: GuideTargetInput,
  result: DispersionResultV1,
  track: DispersionTrackV1 & { readonly data: Extract<DispersionTrackV1['data'], { kind: 'density' }> },
  label: string,
): GuideTargetResolution {
  const geometry = result.geometry;
  if (geometry === null || geometry.order.length !== input.readyDocs.length) return failed();
  for (let d = 0; d < input.readyDocs.length; d++) {
    if (geometry.order[d] !== input.readyDocs[d]) return failed();
  }
  const { bucketOffsets, bucketStartToken, docTokenCount } = geometry;
  const { counts } = track.data;
  if (
    docTokenCount.length !== geometry.order.length
    || bucketOffsets.length !== geometry.order.length + 1
    || bucketOffsets[0] !== 0
    || bucketStartToken.length !== counts.length
    || bucketOffsets[bucketOffsets.length - 1] !== counts.length
  ) return failed();

  let previousOffset = 0;
  let countTotal = 0;
  const candidates: { readonly d: number; readonly extent: number }[] = [];
  for (let d = 0; d < geometry.order.length; d++) {
    const from = bucketOffsets[d];
    const to = bucketOffsets[d + 1];
    const extent = docTokenCount[d];
    if (
      from === undefined
      || to === undefined
      || extent === undefined
      || from < previousOffset
      || to < from
      || to > counts.length
      || (extent === 0 ? to !== from : to === from)
    ) return failed();
    previousOffset = to;
    let hasCount = false;
    let previousStart = -1;
    for (let b = from; b < to; b++) {
      const start = bucketStartToken[b];
      const count = counts[b];
      if (
        start === undefined
        || count === undefined
        || start <= previousStart
        || start >= extent
      ) return failed();
      previousStart = start;
      countTotal += count;
      if (count > 0) hasCount = true;
    }
    if (hasCount) candidates.push({ d, extent });
  }
  if (countTotal !== track.total) return failed();
  if (candidates.length === 0) return { status: 'unavailable', reason: 'no-occurrences' };

  let chosenDoc = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.extent > chosenDoc.extent) chosenDoc = candidate;
  }
  const from = bucketOffsets[chosenDoc.d]!;
  const to = bucketOffsets[chosenDoc.d + 1]!;
  const textMidpoint = Math.floor(chosenDoc.extent / 2);
  let chosenBucket = -1;
  let chosenToken = -1;
  let chosenDistance = Number.POSITIVE_INFINITY;
  for (let b = from; b < to; b++) {
    const count = counts[b]!;
    if (count === 0) continue;
    const t0 = bucketStartToken[b]!;
    const t1 = b + 1 < to ? bucketStartToken[b + 1]! : chosenDoc.extent;
    const token = t0 + ((t1 - t0) >> 1);
    const distance = Math.abs(token - textMidpoint);
    if (distance < chosenDistance) {
      chosenBucket = b;
      chosenToken = token;
      chosenDistance = distance;
    }
  }
  if (chosenBucket < 0) return failed();
  const doc = input.readyDocs[chosenDoc.d]!;
  return {
    status: 'ready',
    target: {
      kind: 'density',
      seriesId: track.seriesId,
      label,
      doc,
      token: chosenToken,
      bucketCount: counts[chosenBucket]!,
      intent: readerIntent(input.snapshotId!, doc, chosenToken, 'position'),
    },
  };
}

export function resolveGuideTarget(input: GuideTargetInput): GuideTargetResolution {
  if (input.snapshotId === null || input.readyDocs.length === 0) {
    return { status: 'unavailable', reason: 'no-corpus' };
  }
  if (input.shownTerms.length === 0) {
    return { status: 'unavailable', reason: 'no-shown-term' };
  }
  if (input.dispersion === null) return { status: 'pending', reason: 'dispersion' };
  if (input.dispersion.snapshotId !== input.snapshotId) {
    return { status: 'pending', reason: 'superseded' };
  }
  if (input.dispersion.state.status === 'pending') {
    return { status: 'pending', reason: 'dispersion' };
  }
  if (input.dispersion.state.status === 'error') return failed();

  const shownOrder = new Map<string, number>();
  const labelBySeries = new Map<string, string>();
  for (let i = 0; i < input.shownTerms.length; i++) {
    const term = input.shownTerms[i]!;
    if (!shownOrder.has(term.seriesId)) {
      shownOrder.set(term.seriesId, i);
      labelBySeries.set(term.seriesId, term.label);
    }
  }
  const shownTracks = input.dispersion.state.result.tracks.filter(
    (track) => shownOrder.has(track.seriesId),
  );
  if (shownTracks.some((track) => !Number.isSafeInteger(track.total) || track.total < 0)) {
    return failed();
  }
  if (!shownTracks.some((track) => track.total > 0)) {
    return { status: 'unavailable', reason: 'no-occurrences' };
  }

  const exact = candidateTrack(shownTracks, 'exact', shownOrder);
  if (exact !== null && exact.data.kind === 'exact') {
    return exactTarget(
      input,
      exact as DispersionTrackV1 & { readonly data: Extract<DispersionTrackV1['data'], { kind: 'exact' }> },
      labelBySeries.get(exact.seriesId)!,
    );
  }
  const density = candidateTrack(shownTracks, 'density', shownOrder);
  if (density !== null && density.data.kind === 'density') {
    return densityTarget(
      input,
      input.dispersion.state.result,
      density as DispersionTrackV1 & { readonly data: Extract<DispersionTrackV1['data'], { kind: 'density' }> },
      labelBySeries.get(density.seriesId)!,
    );
  }
  return { status: 'unavailable', reason: 'no-occurrences' };
}
