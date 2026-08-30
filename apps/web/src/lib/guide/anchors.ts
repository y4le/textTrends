/** Stable semantic hooks shared by product surfaces and the guide shell. */

export const GUIDE_ANCHOR_ATTRIBUTE = 'data-guide-anchor' as const;
export const GUIDE_ACTIVE_ANCHOR_ATTRIBUTE = 'data-guide-anchor-active' as const;

export const GUIDE_ANCHOR_IDS = Object.freeze([
  'terms-rail',
  'trend-plate',
  'dispersion-strip',
  'chart-cursor',
  'reader-prose',
] as const);

export type GuideAnchorId = (typeof GUIDE_ANCHOR_IDS)[number];

export const GUIDE_CARD_HEADING_ID = 'guide-card-heading';
export const GUIDE_LIVE_REGION_ID = 'guide-live-region';

export interface GuideAnchorProps {
  readonly 'data-guide-anchor': GuideAnchorId;
}

export function guideAnchorProps(anchor: GuideAnchorId): GuideAnchorProps {
  return { [GUIDE_ANCHOR_ATTRIBUTE]: anchor };
}

export function guideAnchorSelector(anchor: GuideAnchorId): string {
  return `[${GUIDE_ANCHOR_ATTRIBUTE}="${anchor}"]`;
}

/** One semantic lookup per scene. Duplicate publishers degrade like a miss. */
export function queryGuideAnchor(
  root: Pick<ParentNode, 'querySelectorAll'>,
  anchor: GuideAnchorId,
): HTMLElement | null {
  const matches = root.querySelectorAll<HTMLElement>(guideAnchorSelector(anchor));
  return matches.length === 1 ? matches.item(0) : null;
}
