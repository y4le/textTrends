/**
 * Shared bounded-Concordance row vocabulary and text materialization.
 *
 * Ordering and window planning belong to `concordance.ts`. This module keeps
 * only the transfer-safe numeric row shape and the authenticated source-text
 * slicing used by a resident window.
 */

import type { CorpusSnapshotV1 } from '../snapshot/compose.ts';
import {
  assertBoundTexts,
  internalTextOf,
  type BoundTexts,
} from './binding.ts';

/** One authority for the maximum number of enabled Concordance tracks. */
export const MAX_KWIC_TRACKS = 5;
/** One bounded response can materialize at most this many occurrence rows. */
export const KWIC_MAX_PAGE = 500;

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
    return {
      seriesId: track.seriesId,
      groupId: track.groupId,
      doc,
      pos: row.pos,
      members: row.members,
      node: { start: row.nodeCharStart, end: row.nodeCharEnd },
      left: text.slice(row.leftCharStart, row.nodeCharStart),
      nodeText: text.slice(row.nodeCharStart, row.nodeCharEnd),
      right: text.slice(row.nodeCharEnd, row.rightCharEnd),
    };
  });
}
