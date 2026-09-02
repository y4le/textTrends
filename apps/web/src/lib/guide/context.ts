import type { Place } from '../places.ts';
import type { ObservedOccurrenceActivation } from './activation.ts';
import type { GuideReadiness } from './definition.ts';
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

/** Synchronous Help readiness; pending resident work may settle during early scenes. */
export function guidedTourReadiness(context: GuideContext): GuideReadiness {
  if (context.rsvpActive) {
    return { status: 'disabled', reason: 'Exit Speed reader to start.' };
  }
  if (context.readerOpen) {
    return { status: 'disabled', reason: 'Return to Trends to start the guided tour.' };
  }
  if (context.readyTexts === 0) {
    return {
      status: 'disabled',
      reason: 'Add a ready text before starting the guided tour.',
      remedy: { id: 'add-text', label: 'Add a text' },
    };
  }
  if (context.shownTerms.length === 0) {
    return {
      status: 'disabled',
      reason: 'Track at least one term before starting the guided tour.',
      remedy: { id: 'track-term', label: 'Track a term' },
    };
  }
  if (context.target.status === 'pending' || context.target.status === 'ready') {
    return { status: 'ready' };
  }
  switch (context.target.reason) {
    case 'no-occurrences':
      return {
        status: 'disabled',
        reason: 'Show a term that occurs in a ready text.',
      };
    case 'failed':
      return {
        status: 'disabled',
        reason: 'Retry the reading strip from the chart before starting.',
      };
    case 'no-corpus':
      return {
        status: 'disabled',
        reason: 'Add a ready text before starting the guided tour.',
        remedy: { id: 'add-text', label: 'Add a text' },
      };
    case 'no-shown-term':
      return {
        status: 'disabled',
        reason: 'Track at least one term before starting the guided tour.',
        remedy: { id: 'track-term', label: 'Track a term' },
      };
  }
}
