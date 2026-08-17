import { useLayoutEffect } from 'react';
import { SERIES_COLOR_IDS } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { isLegacySeriesColor } from '../lib/series-style.ts';
import {
  DEFAULT_MAXIMIN_SERIES_PALETTE,
  maximinSeriesPaletteForSlots,
} from '../lib/series-palette.ts';

/** Keep the theme-owned automatic slots clear of active manual overrides.
 * Both theme palettes are written together; the CSS media query switches
 * between them synchronously when the OS color scheme changes. */
export function SeriesPaletteSync() {
  const notebook = useApp((state) => state.notebook);
  const activeGroupIds = useApp((state) => state.activeGroupIds);
  const manualColorKey = notebook.groups
    .filter((group) => activeGroupIds.has(group.id) && !isLegacySeriesColor(group.style.color))
    .map((group) => group.style.color)
    .join(',');
  const activeAutomaticSlotKey = manualColorKey === '' ? '' : [...new Set(notebook.groups
    .flatMap((group) => activeGroupIds.has(group.id) && isLegacySeriesColor(group.style.color)
      ? [SERIES_COLOR_IDS.indexOf(group.style.color)]
      : []))]
    .sort((left, right) => left - right)
    .join(',');

  useLayoutEffect(() => {
    const root = document.documentElement;
    const manualColors = manualColorKey === '' ? [] : manualColorKey.split(',');
    const activeAutomaticSlots = activeAutomaticSlotKey === ''
      ? []
      : activeAutomaticSlotKey.split(',').map(Number);
    const dark = manualColors.length === 0
      ? DEFAULT_MAXIMIN_SERIES_PALETTE.dark
      : maximinSeriesPaletteForSlots(
        'dark',
        manualColors,
        activeAutomaticSlots,
        SERIES_COLOR_IDS.length,
      );
    const light = manualColors.length === 0
      ? DEFAULT_MAXIMIN_SERIES_PALETTE.light
      : maximinSeriesPaletteForSlots(
        'light',
        manualColors,
        activeAutomaticSlots,
        SERIES_COLOR_IDS.length,
      );
    for (let index = 0; index < SERIES_COLOR_IDS.length; index++) {
      root.style.setProperty(`--series-dark-${index + 1}`, dark[index]!);
      root.style.setProperty(`--series-light-${index + 1}`, light[index]!);
    }
    return () => {
      for (let index = 0; index < SERIES_COLOR_IDS.length; index++) {
        root.style.removeProperty(`--series-dark-${index + 1}`);
        root.style.removeProperty(`--series-light-${index + 1}`);
      }
    };
  // The primitive key prevents unrelated notebook edits from rewriting the
  // same declarations; canonical hex colors cannot contain the delimiter.
  }, [activeAutomaticSlotKey, manualColorKey]);

  return null;
}
