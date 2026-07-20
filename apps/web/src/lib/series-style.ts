/**
 * Series visual identity — fixed slot → (color token, dash pattern).
 * Color is never the only encoding (colorblind/print/forced-colors): every
 * slot pairs a validated categorical color with a stable dash pattern, and
 * identity is restated by chips and direct labels. Slots are assigned in
 * input order and never recycled mid-intent.
 */

export const SLOT_COLOR = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
] as const;

/** SVG stroke-dasharray per slot; '' = solid. Slot 4 pairs dots with round caps. */
export const SLOT_DASH = ['', '6 2', '2 2', '8 2 2 2', '1 3'] as const;

export function slotColor(slot: number): string {
  return SLOT_COLOR[slot % SLOT_COLOR.length] as string;
}

export function slotDash(slot: number): string {
  return SLOT_DASH[slot % SLOT_DASH.length] as string;
}
