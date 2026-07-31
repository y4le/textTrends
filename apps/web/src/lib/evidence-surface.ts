import type { PassageResult } from '@texttrends/core';
import { displayPassageText } from './passage-marks.ts';
import type { PassageBlockState } from './pins.ts';
import type { ScrubTarget } from './store.ts';

export type EvidenceSurfaceVM =
  | {
      readonly kind: 'empty';
      readonly message: string;
    }
  | {
      readonly kind: 'loading';
      readonly doc: string;
      readonly title: string;
      readonly token: number;
      readonly tokenCount: number | null;
      readonly caption: string;
    }
  | {
      readonly kind: 'ready';
      readonly doc: string;
      readonly title: string;
      readonly token: number;
      readonly tokenCount: number | null;
      readonly caption: string;
      readonly text: string;
      readonly anchorCharsUtf16: {
        readonly start: number;
        readonly end: number;
      };
      readonly truncated: boolean;
    };

function caption(
  title: string,
  token: number,
  tokenCount: number | null,
): string {
  const position = `token ${(token + 1).toLocaleString()}`;
  return tokenCount === null
    ? `${title} · ${position}`
    : `${title} · ${position} of ${tokenCount.toLocaleString()}`;
}

function serves(
  passage: PassageBlockState | null,
  snapshot: string | null,
  target: ScrubTarget,
): passage is PassageBlockState {
  return passage !== null
    && snapshot !== null
    && passage.snapshot === snapshot
    && passage.result.doc === target.doc
    && target.token >= passage.result.tokens.start
    && target.token < passage.result.tokens.end;
}

function anchorChars(
  passage: PassageResult,
  token: number,
): { readonly start: number; readonly end: number } | null {
  const relative = token - passage.tokens.start;
  const start = passage.tokenStartsUtf16[relative];
  const end = passage.tokenEndsUtf16[relative];
  if (
    start === undefined
    || end === undefined
    || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || end > passage.text.length
  ) return null;
  return { start, end };
}

/**
 * One pure current-evidence authority. A retained passage is rendered only
 * when it serves the live snapshot and cursor; stale blocks remain warm store
 * caches but never become visible evidence for a different target.
 */
export function evidenceSurfaceView(input: {
  readonly scrub: ScrubTarget | null;
  readonly passage: PassageBlockState | null;
  readonly snapshot: string | null;
  readonly titleByDoc: ReadonlyMap<string, string>;
  readonly tokenCount: number | null;
}): EvidenceSurfaceVM {
  if (input.scrub === null) {
    return {
      kind: 'empty',
      message: 'Move the reading cursor or choose an occurrence to inspect passage evidence.',
    };
  }
  const { scrub } = input;
  const title = input.titleByDoc.get(scrub.doc) ?? scrub.doc;
  const base = {
    doc: scrub.doc,
    title,
    token: scrub.token,
    tokenCount: input.tokenCount,
    caption: caption(title, scrub.token, input.tokenCount),
  } as const;
  if (!serves(input.passage, input.snapshot, scrub)) {
    return { kind: 'loading', ...base };
  }
  const anchor = anchorChars(input.passage.result, scrub.token);
  if (anchor === null) {
    return { kind: 'loading', ...base };
  }
  return {
    kind: 'ready',
    ...base,
    text: displayPassageText(input.passage.result.text),
    anchorCharsUtf16: anchor,
    truncated: input.passage.result.truncatedByCharCap,
  };
}
