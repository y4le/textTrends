import type { Place } from '../places.ts';
import type { ReaderOpenIntent } from '../reader-intent.ts';
import { GUIDE_CARD_HEADING_ID } from './anchors.ts';

export const GUIDE_STAGE_KINDS = Object.freeze([
  'place',
  'reader-open',
  'reader-close',
] as const);

export type GuideStageIntent =
  | { readonly kind: 'place'; readonly place: Place }
  | { readonly kind: 'reader-open'; readonly intent: ReaderOpenIntent }
  | { readonly kind: 'reader-close' };

/** The complete mutation authority available to guided learning. */
export interface GuideStageActions {
  readonly replacePlace: (place: Place) => void;
  readonly openReader: (intent: ReaderOpenIntent, returnFocusTo?: string) => void;
  readonly closeReader: () => void;
}

export function applyGuideStage(
  stage: GuideStageIntent,
  actions: GuideStageActions,
): void {
  switch (stage.kind) {
    case 'place':
      actions.replacePlace(stage.place);
      return;
    case 'reader-open':
      actions.openReader(stage.intent, GUIDE_CARD_HEADING_ID);
      return;
    case 'reader-close':
      actions.closeReader();
      return;
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
}
