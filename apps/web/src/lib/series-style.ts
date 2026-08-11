/**
 * Series visual identity. Legacy palette ids remain theme-aware CSS tokens;
 * an authored custom hex is intentionally fixed across themes. Color is
 * always paired with line pattern and text identity elsewhere in the UI.
 */

import {
  SERIES_COLOR_IDS,
  isSeriesColor,
  type SeriesColor,
  type SeriesColorId,
  type SeriesLineId,
  type SeriesStyleV1,
} from '@texttrends/core';

export const DEFAULT_SERIES_STYLE: SeriesStyleV1 = {
  color: 'blue',
  line: 'solid',
};

const COLOR_TOKEN: Record<SeriesColorId, string> = {
  blue: 'var(--series-1)',
  orange: 'var(--series-2)',
  green: 'var(--series-3)',
  violet: 'var(--series-4)',
  gold: 'var(--series-5)',
};

const COLOR_LABEL: Record<SeriesColorId, string> = {
  blue: 'Blue',
  orange: 'Amber',
  green: 'Teal',
  violet: 'Vermillion',
  gold: 'Magenta',
};

const LINE_DASH: Record<SeriesLineId, string> = {
  solid: '',
  dash: '6 2',
  dot: '2 2',
  'dash-dot': '8 2 2 2',
  'fine-dot': '1 3',
};

const DARK_GROUND = '#16140f';
const LIGHT_GROUND = '#f7f3e9';

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

export function isLegacySeriesColor(color: SeriesColor): color is SeriesColorId {
  return SERIES_COLOR_IDS.includes(color as SeriesColorId);
}

export function seriesColor(style: SeriesStyleV1): string {
  return isLegacySeriesColor(style.color) ? COLOR_TOKEN[style.color] : style.color;
}

export function seriesColorLabel(color: SeriesColor): string {
  return isLegacySeriesColor(color) ? COLOR_LABEL[color] : color;
}

/** Translate a native color-input event without converting an untouched
 * theme-aware palette id into the resolved hex value displayed by the input. */
export function seriesColorFromNativeInput(
  current: SeriesColor,
  rawValue: string,
  resolvedCurrent: string,
): SeriesColor {
  const color = rawValue.toLowerCase();
  // Native color inputs emit hex; the second guard narrows an admitted value
  // to SeriesCustomColor and conservatively ignores synthetic legacy ids.
  if (!isSeriesColor(color) || isLegacySeriesColor(color)) return current;
  if (isLegacySeriesColor(current) && color === resolvedCurrent.toLowerCase()) return current;
  return color;
}

export function seriesDash(style: SeriesStyleV1): string {
  return LINE_DASH[style.line];
}

export function seriesLinecap(style: SeriesStyleV1): 'round' | 'butt' {
  return style.line === 'fine-dot' ? 'round' : 'butt';
}

export function seriesColorContrastWarning(
  color: SeriesColor,
): 'dark' | 'light' | 'both' | null {
  if (isLegacySeriesColor(color)) return null;
  const dark = contrastRatio(color, DARK_GROUND) < 3;
  const light = contrastRatio(color, LIGHT_GROUND) < 3;
  if (dark && light) return 'both';
  if (dark) return 'dark';
  if (light) return 'light';
  return null;
}
