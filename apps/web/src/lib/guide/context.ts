import type { Place } from '../places.ts';
import type { ObservedOccurrenceActivation } from './activation.ts';
import type {
  GuideTargetResolution,
  GuideTermFacts,
} from './target.ts';

/** Store-free facts consumed by guide definitions and the session controller. */
export interface GuideContext {
  readonly place: Place;
  readonly readerOpen: boolean;
  readonly rsvpActive: boolean;
  readonly snapshotId: string | null;
  readonly readyDocs: readonly string[];
  readonly readyTexts: number;
  readonly shownTerms: readonly GuideTermFacts[];
  readonly measure: 'rate' | 'count';
  readonly rateDenominator: number;
  readonly occurrenceActivation: ObservedOccurrenceActivation;
  readonly target: GuideTargetResolution;
}
