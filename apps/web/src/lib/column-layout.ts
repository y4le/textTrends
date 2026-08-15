export type PartitionTrack =
  | { readonly kind: 'elastic'; readonly weight: number }
  | { readonly kind: 'fixed'; readonly preferred: string };

/**
 * Build one overflow-proof CSS Grid partition. Elastic tracks deliberately use
 * a zero intrinsic minimum so unbroken table text cannot make the grid wider
 * than its port. Fixed tracks keep their preferred width while room exists and
 * may shrink only when the complete preferred partition is impossible.
 */
export function partitionedGridTemplate(tracks: readonly PartitionTrack[]): string {
  if (tracks.length === 0) throw new RangeError('a column partition needs at least one track');
  return tracks.map((track) => {
    if (track.kind === 'fixed') {
      if (track.preferred.trim() === '') throw new RangeError('fixed width must not be empty');
      return `minmax(0, ${track.preferred})`;
    }
    if (!Number.isFinite(track.weight) || track.weight <= 0) {
      throw new RangeError('elastic weight must be finite and positive');
    }
    return `minmax(0, ${track.weight}fr)`;
  }).join(' ');
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const markOrFormat = /^[\p{Mark}\p{Format}]+$/u;
const pictograph = /\p{Extended_Pictographic}/u;

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Approximate the number of monospace character cells occupied by text.
 * Grapheme segmentation keeps combining sequences and emoji ZWJ clusters from
 * being counted once per code point; East Asian wide graphemes take two cells. */
export function displayCells(text: string): number {
  let cells = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (markOrFormat.test(segment)) continue;
    if (pictograph.test(segment)) {
      cells += 2;
      continue;
    }
    const wide = [...segment].some((character) =>
      isWideCodePoint(character.codePointAt(0) ?? 0));
    cells += wide ? 2 : 1;
  }
  return cells;
}

export function fitTextColumn(
  values: readonly string[],
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
    throw new RangeError('invalid text-column bounds');
  }
  const widest = values.reduce((width, value) => Math.max(width, displayCells(value)), 0);
  return Math.max(minimum, Math.min(maximum, widest));
}

export interface ProportionalPair {
  readonly first: number;
  readonly second: number;
}

/** Convert a live two-track pixel split into bounded, scale-independent
 * integer weights. The returned pair always sums to `units`. */
export function proportionalPairFromPixels(
  firstPx: number,
  secondPx: number,
  units = 100,
): ProportionalPair {
  if (![firstPx, secondPx, units].every(Number.isFinite) || units < 2) {
    throw new RangeError('invalid proportional split');
  }
  const total = Math.max(0, firstPx) + Math.max(0, secondPx);
  if (!(total > 0)) {
    const first = Math.floor(units / 2);
    return { first, second: units - first };
  }
  const first = Math.max(1, Math.min(units - 1, Math.round(
    units * Math.max(0, firstPx) / total,
  )));
  return { first, second: units - first };
}
