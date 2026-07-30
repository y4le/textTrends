/**
 * Pure pinned-evidence contracts. Pins are bounded, transient, and
 * snapshot-bound; their query semantics are captured so later notebook edits
 * cannot silently reinterpret old marks.
 */

import type { PassageResult } from '@texttrends/core';

type PassageMark = PassageResult['marks'][number];

export const MAX_PINNED_SNIPPETS = 8;

export interface PinAnchor {
  readonly snapshot: string;
  readonly doc: string;
  readonly token: number;
}

export interface CapturedTrack {
  readonly seriesId: string;
  readonly groupId: string;
  readonly identity: string;
  readonly label: string;
  readonly styleSlot: number;
}

export interface CapturedEvidence {
  readonly tokens: { readonly start: number; readonly end: number };
  readonly docCharsUtf16: { readonly start: number; readonly end: number };
  readonly text: string;
  readonly tokenStartsUtf16: readonly number[];
  readonly tokenEndsUtf16: readonly number[];
  readonly anchorCharsUtf16: { readonly start: number; readonly end: number };
  readonly marks: readonly PassageMark[];
  readonly truncatedByCharCap: boolean;
}

export interface PassageBlockState {
  readonly snapshot: string;
  readonly tracks: readonly CapturedTrack[];
  readonly result: PassageResult;
}

export type PinnedSnippet =
  | {
      readonly kind: 'pending';
      readonly id: string;
      readonly anchor: PinAnchor;
      readonly tracks: readonly CapturedTrack[];
    }
  | {
      readonly kind: 'ready';
      readonly id: string;
      readonly anchor: PinAnchor;
      readonly tracks: readonly CapturedTrack[];
      readonly evidence: CapturedEvidence;
    }
  | {
      readonly kind: 'error';
      readonly id: string;
      readonly anchor: PinAnchor;
      readonly tracks: readonly CapturedTrack[];
      readonly message: string;
    };

export interface PinLegendEntry {
  readonly seriesId: string;
  readonly label: string;
  readonly styleSlot: number;
  readonly stale: boolean;
}

export function samePinAnchor(a: PinAnchor, b: PinAnchor): boolean {
  return a.snapshot === b.snapshot && a.doc === b.doc && a.token === b.token;
}

export function passageContains(
  passage: PassageResult,
  doc: string,
  token: number,
): boolean {
  return passage.doc === doc
    && token >= passage.tokens.start
    && token < passage.tokens.end;
}

export function sameTrackIdentities(
  left: readonly CapturedTrack[],
  right: readonly CapturedTrack[],
): boolean {
  return left.length === right.length
    && left.every(
      (track, i) =>
        track.seriesId === right[i]?.seriesId
        && track.identity === right[i]?.identity,
    );
}

export function canReusePassage(
  held: PassageBlockState | null,
  anchor: PinAnchor,
  liveSnapshot: string | null,
  liveTracks: readonly CapturedTrack[],
): held is PassageBlockState {
  return held !== null
    && anchor.snapshot === liveSnapshot
    && held.snapshot === liveSnapshot
    && sameTrackIdentities(held.tracks, liveTracks)
    && passageContains(held.result, anchor.doc, anchor.token);
}

/** Copy a bounded passage into immutable pin evidence. The requested pin
 * anchor may be anywhere inside a reused block, so derive its char span from
 * the per-token arrays rather than the block's original center. */
export function evidenceFrom(
  passage: PassageResult,
  anchorToken: number,
): CapturedEvidence | null {
  if (!passageContains(passage, passage.doc, anchorToken)) return null;
  const rel = anchorToken - passage.tokens.start;
  const anchorStart = passage.tokenStartsUtf16[rel];
  const anchorEnd = passage.tokenEndsUtf16[rel];
  if (anchorStart === undefined || anchorEnd === undefined) return null;
  const marks = Object.freeze(
    passage.marks.map((mark) =>
      Object.freeze({
        ...mark,
        tokens: Object.freeze({ ...mark.tokens }),
        charsUtf16: Object.freeze({ ...mark.charsUtf16 }),
      }),
    ),
  );
  return Object.freeze({
    tokens: Object.freeze({ ...passage.tokens }),
    docCharsUtf16: Object.freeze({ ...passage.docCharsUtf16 }),
    text: passage.text,
    tokenStartsUtf16: Object.freeze([...passage.tokenStartsUtf16]),
    tokenEndsUtf16: Object.freeze([...passage.tokenEndsUtf16]),
    anchorCharsUtf16: Object.freeze({ start: anchorStart, end: anchorEnd }),
    marks,
    truncatedByCharCap: passage.truncatedByCharCap,
  });
}

/** Use live presentation only while the captured matching identity remains
 * current. After a semantic edit/removal, preserve the captured label/slot so
 * recycled colours cannot silently relabel the old marks. */
export function pinTrackLegend(
  captured: readonly CapturedTrack[],
  liveIdentityOf: (seriesId: string) => string | null,
  liveSeries: readonly { readonly id: string; readonly label: string; readonly styleSlot: number }[],
): readonly PinLegendEntry[] {
  const live = new Map(liveSeries.map((series) => [series.id, series]));
  return captured.map((track) => {
    const current = live.get(track.seriesId);
    const stale = liveIdentityOf(track.seriesId) !== track.identity || current === undefined;
    return {
      seriesId: track.seriesId,
      label: stale ? track.label : current.label,
      styleSlot: stale ? track.styleSlot : current.styleSlot,
      stale,
    };
  });
}
