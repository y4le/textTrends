import type { Place } from '../places.ts';
import type { GuideAnchorId } from './anchors.ts';
import type { GuideContext } from './context.ts';
import type { GuideStageIntent } from './stage.ts';

export const GUIDE_IDS = Object.freeze([
  'guided-tour',
  'terms-and-notebook',
  'reading-a-trend',
  'reading-the-strip',
  'compare-a-passage',
] as const);

export type GuideId = (typeof GUIDE_IDS)[number];
export type GuideEvent = 'reader-opened' | 'reader-closed';
export type GuideStepPhase =
  | 'presenting'
  | 'awaiting-action'
  | 'revealed'
  | 'abridged';

export interface GuideReadinessRemedy {
  readonly id: 'add-text' | 'track-term';
  readonly label: string;
}

export type GuideReadiness =
  | { readonly status: 'ready' }
  | {
      readonly status: 'disabled';
      readonly reason: string;
      readonly remedy?: GuideReadinessRemedy;
    };

export type GuideActionId =
  | 'primary'
  | 'abridge'
  | 'exit'
  | 'restore-origin'
  | 'replay';

export interface GuideCopyAction {
  readonly id: GuideActionId;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface GuideCopy {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly hints?: readonly string[];
  readonly status?: {
    readonly tone: 'neutral' | 'pending' | 'unavailable';
    readonly text: string;
  };
  readonly actions: readonly GuideCopyAction[];
  readonly noteIds?: readonly GuideId[];
}

export interface GuideStep {
  readonly id: string;
  readonly kind: 'welcome' | 'scene' | 'finish';
  readonly anchor?: GuideAnchorId;
  readonly cardSide: 'block-start' | 'block-end';
  readonly copy: (context: GuideContext, phase: GuideStepPhase) => GuideCopy;
  readonly stage?: (context: GuideContext) => GuideStageIntent | null;
  readonly advance:
    | { readonly kind: 'manual' }
    | { readonly kind: 'action'; readonly event: GuideEvent };
}

export interface GuideDefinition {
  readonly id: GuideId;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly places: readonly Place[];
  readonly requires: (context: GuideContext) => GuideReadiness;
  readonly steps: readonly GuideStep[];
}
