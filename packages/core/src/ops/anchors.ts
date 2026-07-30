/**
 * Durable character-anchor bridges. Token coordinates are transient; a
 * TextHash + UTF-16 character range can be recompiled after index-recipe
 * changes without guessing across source changes.
 */

import type { ProjectDocId } from '../contract/brands.ts';
import {
  tokenEndChar,
  type DocumentIndexV1,
} from '../index/build.ts';
import type {
  CorpusDocRef,
  CorpusSnapshotV1,
} from '../snapshot/compose.ts';
import type { TokenRangeSpan } from '../snapshot/selection.ts';
import { lowerBound } from '../structure/project.ts';
import type { CharAnchorV1 } from '../project/research-state.ts';

export const COMPILE_ANCHOR_MAX_ITEMS = 64;

export interface AnchorTokensResultV1 {
  readonly method: 'anchor-tokens/1';
  readonly anchor: CharAnchorV1;
}

export type CompileAnchorRowV1 =
  | {
      readonly status: 'ok';
      readonly anchor: CharAnchorV1;
      readonly tokens: TokenRangeSpan;
    }
  | {
      readonly status: 'empty';
      readonly anchor: CharAnchorV1;
    }
  | {
      readonly status: 'text-mismatch';
      readonly anchor: CharAnchorV1;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly status: 'missing-doc';
      readonly anchor: CharAnchorV1;
    };

export interface CompileAnchorsResultV1 {
  readonly method: 'compile-anchor/1';
  readonly rows: readonly CompileAnchorRowV1[];
}

function residentRef(
  snapshot: CorpusSnapshotV1,
  doc: string,
): CorpusDocRef | null {
  return snapshot.docs.find((candidate) => candidate.doc === doc) ?? null;
}

function validateBinding(
  snapshot: CorpusSnapshotV1,
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
): void {
  const resident = residentRef(snapshot, ref.doc);
  if (
    resident !== ref ||
    shard.tokenTypeIds.length !== ref.tokenCount ||
    shard.startsUtf16.length !== ref.tokenCount
  ) {
    throw new RangeError(`anchor shard for '${ref.doc}' is not snapshot-resident`);
  }
}

function validateTokenRange(
  range: TokenRangeSpan,
  tokenCount: number,
): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.start >= range.end ||
    range.end > tokenCount
  ) {
    throw new RangeError('anchor token range must be nonempty and in bounds');
  }
}

export function anchorTokens(
  snapshot: CorpusSnapshotV1,
  ref: CorpusDocRef,
  shard: DocumentIndexV1,
  range: TokenRangeSpan,
): AnchorTokensResultV1 {
  validateBinding(snapshot, ref, shard);
  validateTokenRange(range, ref.tokenCount);
  return {
    method: 'anchor-tokens/1',
    anchor: {
      doc: ref.doc,
      text: shard.text,
      chars: {
        start: shard.startsUtf16[range.start] as number,
        end: tokenEndChar(shard, range.end - 1),
      },
    },
  };
}

export function compileAnchors(
  snapshot: CorpusSnapshotV1,
  shards: ReadonlyMap<ProjectDocId, DocumentIndexV1>,
  anchors: readonly CharAnchorV1[],
): CompileAnchorsResultV1 {
  if (anchors.length > COMPILE_ANCHOR_MAX_ITEMS) {
    throw new RangeError(
      `compile-anchor accepts at most ${COMPILE_ANCHOR_MAX_ITEMS} anchors`,
    );
  }
  const rows: CompileAnchorRowV1[] = [];
  for (const anchor of anchors) {
    const ref = residentRef(snapshot, anchor.doc);
    const shard = shards.get(anchor.doc as ProjectDocId);
    if (!ref || !shard) {
      rows.push({ status: 'missing-doc', anchor });
      continue;
    }
    if (shard.text !== anchor.text) {
      rows.push({
        status: 'text-mismatch',
        anchor,
        expected: anchor.text,
        actual: shard.text,
      });
      continue;
    }
    validateBinding(snapshot, ref, shard);
    // Character coordinates are source-text authority, while a shard contains
    // only tokens emitted by the CURRENT recipe. A recipe may legitimately
    // drop the token that owned an old anchor boundary (for example a numeral),
    // so coordinates beyond the current final token are compiled via
    // lowerBound rather than aborting the whole batch. That yields the
    // surviving intersecting range, or `empty` when no emitted token remains.
    const start = lowerBound(shard.startsUtf16, anchor.chars.start);
    const end = lowerBound(shard.startsUtf16, anchor.chars.end);
    if (anchor.chars.start === anchor.chars.end || start === end) {
      rows.push({ status: 'empty', anchor });
    } else {
      rows.push({ status: 'ok', anchor, tokens: { start, end } });
    }
  }
  return { method: 'compile-anchor/1', rows };
}
