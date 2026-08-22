import type { ReaderPageResultV1 } from '../shared/analysis-contract.ts';
import { rsvpHoldMs, rsvpWordFrame } from './rsvp.ts';

export type RsvpCursorStep =
  | { readonly kind: 'next'; readonly token: number }
  | { readonly kind: 'source-end' }
  | { readonly kind: 'document-end' };

export function rsvpCursorStep(
  page: Pick<ReaderPageResultV1, 'tokens' | 'docTokenCount'>,
  token: number,
): RsvpCursorStep {
  if (
    !Number.isSafeInteger(token)
    || token < page.tokens.start
    || token >= page.tokens.end
  ) throw new RangeError('RSVP cursor is outside its resident source');
  const next = token + 1;
  if (next < page.tokens.end) return { kind: 'next', token: next };
  return next >= page.docTokenCount
    ? { kind: 'document-end' }
    : { kind: 'source-end' };
}

/** True once all remaining authenticated frames fit within the requested
 * look-ahead duration. The loop stops as soon as the threshold is exceeded,
 * so a 4,096-token source does bounded work at ordinary paces. */
export function rsvpNeedsContinuation(
  page: ReaderPageResultV1,
  token: number,
  wpm: number,
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
  for (let relative = start; relative < page.tokens.end - page.tokens.start; relative++) {
    runway += rsvpHoldMs(wpm, rsvpWordFrame(page, relative));
    if (runway > leadMs) return false;
  }
  return true;
}
