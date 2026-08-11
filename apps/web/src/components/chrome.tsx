/**
 * Shared component chrome (Phase B ruling W4): presentation-only primitives
 * with no semantic content. Semantic controls (the chart-focus chip, the
 * concordance toggle chip) stay with their owners — only the truly common
 * visuals live here. Deliberately NOT in style/tokens.css, which is the
 * design-token/global-primitive boundary, not a component-style home.
 */

import type { SeriesStyleV1 } from '@texttrends/core';
import { seriesColor, seriesDash, seriesLinecap } from '../lib/series-style.ts';

/** The one small mono action button used across the panels. Consumers spread
 *  it and override fields for variants (disabled, padding). */
export const SMALL_BUTTON_STYLE: React.CSSProperties = {
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule-strong)',
  cursor: 'pointer',
  padding: '1px 0.75ch',
};

/** The 22×8 series line sample (color + dash + emphasis weight) shared by the
 *  chart-focus and concordance chips. Identity styling only — never the sole
 *  carrier of state (both chips pair it with aria-pressed + text). */
export function SeriesLineSample({ style, emphasized }: { style: SeriesStyleV1; emphasized: boolean }) {
  return (
    <svg width={22} height={8} aria-hidden="true">
      <line
        x1={1}
        y1={4}
        x2={21}
        y2={4}
        stroke={seriesColor(style)}
        strokeWidth={emphasized ? 2.5 : 1.5}
        strokeDasharray={seriesDash(style)}
        strokeLinecap={seriesLinecap(style)}
      />
    </svg>
  );
}
