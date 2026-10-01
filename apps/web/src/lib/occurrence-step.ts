/** Shared cursor and geometry policy for Find and saved-term stepping. */
import type { AppState } from './app-state.ts';
import type { OccurrenceStepHitV1 } from '../shared/analysis-contract.ts';
import type { FindAnchor } from './interaction.ts';
import { sameReaderPlace } from './reader-intent.ts';

type StepState = Pick<AppState, 'readerPlace' | 'readerPage' | 'readerVisibleRange' | 'readerCursorToken' | 'scrub' | 'corpusTokenCounts'>;
export function occurrenceStepAnchor(
  state: StepState, readyDocs: readonly string[], direction: 1 | -1, preferred?: FindAnchor | null,
): { readonly anchor: FindAnchor; readonly synthetic: boolean } | null {
  const place = state.readerPlace;
  const page = place && state.readerPage && sameReaderPlace(state.readerPage.place, place)
    && state.readerPage.state.status === 'ready' ? state.readerPage.state.page : null;
  const candidate = state.readerVisibleRange;
  const visible = page && candidate !== null && candidate.snapshot === state.readerPage?.snapshot
    && candidate.doc === page.doc ? candidate : null;
  const reader = page ? { doc: page.doc, token: state.readerCursorToken ?? page.anchor?.token ?? visible?.tokens.start ?? page.tokens.start } : null;
  const anchor = reader ?? preferred ?? state.scrub;
  if (anchor !== null) return readyDocs.includes(anchor.doc) ? { anchor, synthetic: false } : null;
  // Unknown extents cannot prove which corpus edge wraps to the first hit.
  if (readyDocs.some((doc) => state.corpusTokenCounts.get(doc) === undefined)) return null;
  const candidates = direction === 1 ? [...readyDocs].reverse() : readyDocs;
  const doc = candidates.find((id) => (state.corpusTokenCounts.get(id) ?? 0) > 0);
  return doc === undefined ? null : { anchor: { doc, token: direction === 1 ? state.corpusTokenCounts.get(doc)! - 1 : 0 }, synthetic: true };
}
export function validOccurrenceHit(
  hit: OccurrenceStepHitV1, readyDocs: readonly string[], tokenCount: number | undefined, memberCount: number,
): boolean {
  return readyDocs.includes(hit.doc) && Number.isSafeInteger(hit.token) && hit.token >= 0
    && Number.isSafeInteger(hit.spanTokens) && hit.spanTokens >= 1
    && Number.isSafeInteger(hit.token + hit.spanTokens)
    && (tokenCount === undefined || hit.token + hit.spanTokens <= tokenCount)
    && hit.members.length > 0 && hit.members.every((member) => Number.isSafeInteger(member) && member >= 0 && member < memberCount);
}
