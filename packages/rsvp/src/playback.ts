import {
  RSVP_MAX_CATCHUP_MS,
  RSVP_MIN_EXPOSURE_MS,
  rsvpSpanPlan,
  type RsvpPacing,
  type RsvpPlaybackSource,
} from './rsvp.ts';

/** Preserve a planned frame deadline while absorbing only bounded callback
 * lateness and never cutting below the frame's per-word exposure floor. */
export function rsvpBoundedFrameStart(
  plannedStart: number,
  now: number,
  plannedWordMs: number,
  frameWordCount: number,
): number {
  if (
    !Number.isFinite(plannedStart)
    || !Number.isFinite(now)
    || !Number.isFinite(plannedWordMs)
    || !Number.isSafeInteger(frameWordCount)
    || frameWordCount < 1
    || plannedWordMs < frameWordCount * RSVP_MIN_EXPOSURE_MS
  ) throw new RangeError('RSVP frame timing is invalid');
  const available = plannedWordMs - frameWordCount * RSVP_MIN_EXPOSURE_MS;
  const catchup = Math.min(RSVP_MAX_CATCHUP_MS, available);
  return Math.max(plannedStart, now - catchup);
}

export type RsvpCursorStep =
  | { readonly kind: 'next'; readonly token: number }
  | { readonly kind: 'source-end' }
  | { readonly kind: 'document-end' };

export function rsvpCursorStep(
  page: Pick<RsvpPlaybackSource, 'tokens' | 'docTokenCount'>,
  token: number,
  wordCount = 1,
): RsvpCursorStep {
  if (
    !Number.isSafeInteger(token)
    || token < page.tokens.start
    || token >= page.tokens.end
  ) throw new RangeError('RSVP cursor is outside its resident source');
  if (!Number.isSafeInteger(wordCount) || wordCount < 1) {
    throw new RangeError('RSVP frame word count must be a positive integer');
  }
  const next = token + wordCount;
  if (next < page.tokens.end) return { kind: 'next', token: next };
  return next >= page.docTokenCount
    ? { kind: 'document-end' }
    : { kind: 'source-end' };
}

/** True once all remaining authenticated frames fit within the requested
 * look-ahead duration. The loop stops as soon as the threshold is exceeded,
 * so a 4,096-token source does bounded work at ordinary paces. */
export function rsvpNeedsContinuation(
  page: RsvpPlaybackSource,
  token: number,
  pacing: RsvpPacing,
  leadMs = 3_000,
): boolean {
  if (!Number.isFinite(leadMs) || leadMs < 0) {
    throw new RangeError('RSVP continuation lead must be finite and non-negative');
  }
  if (page.tokens.end >= page.docTokenCount) return false;
  const start = token - page.tokens.start;
  if (!Number.isSafeInteger(start) || start < 0 || start >= page.tokens.end - page.tokens.start) {
    throw new RangeError('RSVP cursor is outside its resident source');
  }
  let runway = 0;
  for (let relative = start; relative < page.tokens.end - page.tokens.start;) {
    const plan = rsvpSpanPlan(page, relative, pacing);
    const offset = page.tokens.start + relative - plan.startToken;
    runway += plan.wordMs
      .slice(offset)
      .reduce((total, wordMs) => total + wordMs, 0) + plan.restMs;
    if (runway > leadMs) return false;
    relative = plan.endToken - page.tokens.start;
  }
  return true;
}
