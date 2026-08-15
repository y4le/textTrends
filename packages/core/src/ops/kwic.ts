/**
 * Shared bounded match-row vocabulary and text materialization.
 *
 * Ordering and window planning belong to `matches.ts`. This module keeps
 * only the transfer-safe numeric row shape and the authenticated source-text
 * slicing used by a resident window.
 */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import {
  assertBoundTexts,
  internalTextOf,
  type BoundTexts,
} from './binding.ts';

/** One authority for the maximum number of enabled Matches tracks. */
export const MAX_KWIC_TRACKS = 5;
/** One bounded response can materialize at most this many occurrence rows. */
export const KWIC_MAX_PAGE = 500;
/** A wide viewport may request a larger token reservoir, but every request is
 * bounded independently of source shape and browser geometry. */
export const KWIC_CONTEXT_MAX_TOKENS = 256;
/** Hard string-allocation bound for each side of one materialized row. */
export const KWIC_CONTEXT_MAX_UTF16 = 2_048;

export interface NumericKwicRow {
  /** Which track (index into the request's ordered track table) produced this. */
  readonly trackOrdinal: number;
  readonly docOrdinal: number;
  readonly pos: number;
  readonly spanTokens: number;
  readonly members: readonly number[];
  readonly leftCharStart: number;
  readonly nodeCharStart: number;
  readonly nodeCharEnd: number;
  readonly rightCharEnd: number;
}

export interface NumericKwicPage {
  readonly snapshot: CorpusSnapshotV1['id'];
  readonly total: number;
  readonly rows: readonly NumericKwicRow[];
}

export interface KwicTrackIdentity {
  readonly seriesId: string;
  readonly groupId: string;
}

export interface KwicRow {
  readonly seriesId: string;
  readonly groupId: string;
  readonly doc: string;
  readonly pos: number;
  readonly members: readonly number[];
  readonly node: { readonly start: number; readonly end: number };
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

function safeContextStart(text: string, requested: number): number {
  let start = Math.max(0, requested);
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return start;
}

function safeContextEnd(text: string, requested: number): number {
  let end = Math.min(text.length, requested);
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    end -= 1;
  }
  return end;
}

/** Materialize bounded row strings from authenticated source texts. */
export function materializeKwicPage(
  snapshot: CorpusSnapshotV1,
  page: NumericKwicPage,
  texts: BoundTexts,
  tracks: readonly KwicTrackIdentity[],
): readonly KwicRow[] {
  assertBoundTexts(texts);
  if (page.snapshot !== snapshot.id) {
    throw new RangeError('page was planned against a different snapshot');
  }
  if (texts.snapshot !== snapshot.id) {
    throw new RangeError('texts are bound to a different snapshot');
  }
  return page.rows.map((row) => {
    const track = tracks[row.trackOrdinal];
    if (track === undefined) {
      throw new RangeError(`row references unknown track ordinal ${row.trackOrdinal}`);
    }
    const doc = snapshot.docs[row.docOrdinal]?.doc;
    if (doc === undefined) throw new RangeError(`unknown doc ordinal ${row.docOrdinal}`);
    const text = internalTextOf(texts, doc);
    const leftStart = safeContextStart(
      text,
      Math.max(row.leftCharStart, row.nodeCharStart - KWIC_CONTEXT_MAX_UTF16),
    );
    const rightEnd = safeContextEnd(
      text,
      Math.min(row.rightCharEnd, row.nodeCharEnd + KWIC_CONTEXT_MAX_UTF16),
    );
    return {
      seriesId: track.seriesId,
      groupId: track.groupId,
      doc,
      pos: row.pos,
      members: row.members,
      node: { start: row.nodeCharStart, end: row.nodeCharEnd },
      left: text.slice(leftStart, row.nodeCharStart),
      nodeText: text.slice(row.nodeCharStart, row.nodeCharEnd),
      right: text.slice(row.nodeCharEnd, rightEnd),
    };
  });
}
