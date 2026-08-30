import type { GuideId } from './definition.ts';

export interface GuideSynopsis {
  readonly id: GuideId;
  readonly title: string;
  readonly summary: string;
  readonly duration: string;
}

export const GUIDED_TOUR_SYNOPSIS: GuideSynopsis = Object.freeze({
  id: 'guided-tour',
  title: 'A reading instrument',
  summary: 'Follow one shown term from the chart into its source and back.',
  duration: 'about a minute',
});
