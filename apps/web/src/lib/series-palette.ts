/**
 * Theme-aware categorical colors derived from GraphTV's maximin palette.
 *
 * Candidates come from a small, deterministic OKLCH grid. The first color is
 * seeded near blue, then every subsequent color maximizes its minimum OKLab
 * distance from the colors already selected. GraphTV's spot-color exclusion
 * and active, manually authored colors reserve space before selection.
 */

export type SeriesColorScheme = 'dark' | 'light';

interface OklabColor {
  readonly lightness: number;
  readonly a: number;
  readonly b: number;
}

interface OklchColor extends OklabColor {
  readonly chroma: number;
  readonly hue: number;
}

interface MaximinConfig {
  readonly lightnesses: readonly number[];
  readonly chromas: readonly number[];
  readonly seed: Pick<OklchColor, 'lightness' | 'chroma' | 'hue'>;
  readonly avoid: Pick<OklchColor, 'lightness' | 'chroma' | 'hue'>;
}

/** GraphTV's perceptual clearance around its spot color, also used for
 * manually authored TextTrends colors. */
export const SERIES_COLOR_AVOID_DISTANCE = 0.15;

const MAXIMIN_CONFIG: Record<SeriesColorScheme, MaximinConfig> = {
  light: {
    lightnesses: [0.42, 0.52, 0.62],
    chromas: [0.09, 0.15, 0.21],
    seed: { lightness: 0.52, chroma: 0.15, hue: 255 },
    avoid: { lightness: 0.556, chroma: 0.176, hue: 32 },
  },
  dark: {
    lightnesses: [0.62, 0.72, 0.82],
    chromas: [0.09, 0.15, 0.21],
    seed: { lightness: 0.72, chroma: 0.15, hue: 255 },
    avoid: { lightness: 0.646, chroma: 0.156, hue: 33 },
  },
};

const CANONICAL_HEX = /^#[0-9a-f]{6}$/u;

function createOklchCandidate(lightness: number, chroma: number, hue: number): OklchColor {
  const radians = (hue * Math.PI) / 180;
  return {
    lightness,
    chroma,
    hue,
    a: chroma * Math.cos(radians),
    b: chroma * Math.sin(radians),
  };
}

function oklchParameterDistance(
  candidate: OklchColor,
  target: Pick<OklchColor, 'lightness' | 'chroma' | 'hue'>,
): number {
  const hueDistance = Math.min(
    Math.abs(candidate.hue - target.hue),
    360 - Math.abs(candidate.hue - target.hue),
  );
  return Math.abs(candidate.lightness - target.lightness)
    + Math.abs(candidate.chroma - target.chroma)
    + hueDistance / 360;
}

function oklabDistanceSquared(left: OklabColor, right: OklabColor): number {
  return (left.lightness - right.lightness) ** 2
    + (left.a - right.a) ** 2
    + (left.b - right.b) ** 2;
}

function linearSrgb(color: OklabColor): readonly [number, number, number] {
  const l = (color.lightness + 0.3963377774 * color.a + 0.2158037573 * color.b) ** 3;
  const m = (color.lightness - 0.1055613458 * color.a - 0.0638541728 * color.b) ** 3;
  const s = (color.lightness - 0.0894841775 * color.a - 1.291485548 * color.b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function isInSrgbGamut(candidate: OklabColor): boolean {
  return linearSrgb(candidate).every((channel) => channel >= 0 && channel <= 1);
}

function hexToOklab(hex: string): OklabColor | null {
  const normalized = hex.toLowerCase();
  if (!CANONICAL_HEX.test(normalized)) return null;
  const encoded = [1, 3, 5].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = encoded.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const l = Math.cbrt(0.4122214708 * red! + 0.5363325363 * green! + 0.0514459929 * blue!);
  const m = Math.cbrt(0.2119034982 * red! + 0.6806995451 * green! + 0.1073969566 * blue!);
  const s = Math.cbrt(0.0883024619 * red! + 0.2817188376 * green! + 0.6299787005 * blue!);
  return {
    lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function formatHex(color: OklabColor): string {
  const channels = linearSrgb(color).map((channel) => {
    const encoded = channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, encoded)) * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

function renderedOklab(color: OklabColor): OklabColor {
  return hexToOklab(formatHex(color))!;
}

/** Perceptual OKLab distance between two canonical six-digit hex colors. */
export function seriesColorDistance(left: string, right: string): number | null {
  const leftLab = hexToOklab(left);
  const rightLab = hexToOklab(right);
  if (leftLab === null || rightLab === null) return null;
  return Math.sqrt(oklabDistanceSquared(leftLab, rightLab));
}

/**
 * Build a deterministic maximin prefix for one theme. Manual colors are
 * fixed sRGB overrides: candidates inside the reserved distance are removed,
 * and the remaining picks also maximize their distance from those overrides.
 */
export function maximinSeriesPalette(
  scheme: SeriesColorScheme,
  manualColors: readonly string[] = [],
  count = 5,
): readonly string[] {
  const config = MAXIMIN_CONFIG[scheme];
  const manualAnchors = manualColors
    .map(hexToOklab)
    .filter((color): color is OklabColor => color !== null);
  const avoidAnchors = [
    createOklchCandidate(config.avoid.lightness, config.avoid.chroma, config.avoid.hue),
    ...manualAnchors,
  ];
  const minimumDistanceSquared = SERIES_COLOR_AVOID_DISTANCE ** 2;
  const allCandidates = config.lightnesses
    .flatMap((lightness) => config.chromas.flatMap((chroma) => (
      Array.from({ length: 24 }, (_, index) => createOklchCandidate(lightness, chroma, index * 15))
    )))
    .filter(isInSrgbGamut);
  let candidates = allCandidates.filter((candidate) => {
    // Automatic colors are emitted as hex for native color-input and canvas
    // interoperability. Check the quantized, actually rendered color so
    // rounding cannot cross the promised clearance boundary.
    const rendered = renderedOklab(candidate);
    return avoidAnchors.every(
      (anchor) => oklabDistanceSquared(rendered, anchor) >= minimumDistanceSquared,
    );
  });
  let reserve = allCandidates.filter((candidate) => !candidates.includes(candidate));
  const safeCount = Math.min(
    Math.max(0, Math.trunc(count)),
    allCandidates.length,
  );
  if (safeCount === 0) return [];

  // Five active terms can all be manual, whose exclusion neighborhoods can
  // cover nearly the whole finite grid. In that display there is no active
  // automatic color, but the inactive slots must still remain valid CSS.
  // Fall back to the best remaining candidates only when strict clearance is
  // unavailable; this path chiefly keeps inactive slots well formed in an
  // all-manual display.
  let relaxedClearance = candidates.length === 0;
  if (relaxedClearance) {
    candidates = reserve;
    reserve = [];
  }
  const seedIndex = candidates.reduce((bestIndex, candidate, index) => {
    if (manualAnchors.length === 0) {
      return oklchParameterDistance(candidate, config.seed)
        < oklchParameterDistance(candidates[bestIndex]!, config.seed)
        ? index
        : bestIndex;
    }
    const candidateDistance = Math.min(...manualAnchors.map(
      (anchor) => oklabDistanceSquared(renderedOklab(candidate), anchor),
    ));
    const bestDistance = Math.min(...manualAnchors.map(
      (anchor) => oklabDistanceSquared(renderedOklab(candidates[bestIndex]!), anchor),
    ));
    if (candidateDistance !== bestDistance) {
      return candidateDistance > bestDistance ? index : bestIndex;
    }
    return oklchParameterDistance(candidate, config.seed)
      < oklchParameterDistance(candidates[bestIndex]!, config.seed)
      ? index
      : bestIndex;
  }, 0);
  const selected = [candidates.splice(seedIndex, 1)[0]!];
  if (candidates.length === 0 && reserve.length > 0 && selected.length < safeCount) {
    candidates = reserve;
    reserve = [];
    relaxedClearance = true;
  }

  while (selected.length < safeCount && candidates.length > 0) {
    const separated = candidates.filter((candidate) => selected.every(
      (color) => oklabDistanceSquared(renderedOklab(candidate), renderedOklab(color))
        >= minimumDistanceSquared,
    ));
    const pool = separated.length > 0 ? separated : candidates;
    let bestIndex = 0;
    let bestMinimumDistance = -Infinity;
    let bestPreviousDistance = -Infinity;
    pool.forEach((candidate) => {
      const candidateIndex = candidates.indexOf(candidate);
      const rendered = renderedOklab(candidate);
      const selectedDistances = selected.map(
        (color) => manualAnchors.length === 0
          ? oklabDistanceSquared(candidate, color)
          : oklabDistanceSquared(rendered, renderedOklab(color)),
      );
      const rankingAnchors = relaxedClearance ? avoidAnchors : manualAnchors;
      const distances = [...selectedDistances, ...rankingAnchors.map(
        (color) => oklabDistanceSquared(rendered, color),
      )];
      const minimumDistance = Math.min(...distances);
      const previousDistance = selectedDistances.at(-1)!;
      if (
        minimumDistance > bestMinimumDistance
        || (minimumDistance === bestMinimumDistance && previousDistance > bestPreviousDistance)
      ) {
        bestIndex = candidateIndex;
        bestMinimumDistance = minimumDistance;
        bestPreviousDistance = previousDistance;
      }
    });
    selected.push(candidates.splice(bestIndex, 1)[0]!);
    if (candidates.length === 0 && reserve.length > 0 && selected.length < safeCount) {
      candidates = reserve;
      reserve = [];
      relaxedClearance = true;
    }
  }

  return selected.map(formatHex);
}

/**
 * Assign a generated palette to durable automatic slot ordinals. Active slots
 * receive a maximin set sized specifically for them, then those colors are
 * matched toward their default slot colors as a secondary stability concern.
 * Inactive slots receive the remainder of the full palette.
 */
export function maximinSeriesPaletteForSlots(
  scheme: SeriesColorScheme,
  manualColors: readonly string[],
  activeSlots: readonly number[],
  count = 5,
): readonly string[] {
  const colors = maximinSeriesPalette(scheme, manualColors, count);
  const stablePalette = maximinSeriesPalette(scheme, [], count);
  const assignments: Array<string | undefined> = Array.from({ length: colors.length });
  const safeActiveSlots = [...new Set(activeSlots)]
    .filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < colors.length)
    .sort((left, right) => left - right);
  const activeColors = [...maximinSeriesPalette(scheme, manualColors, safeActiveSlots.length)];

  for (const slot of safeActiveSlots) {
    const stableTarget = stablePalette[slot]!;
    const candidateIndex = activeColors.reduce((bestIndex, color, index) => (
      (seriesColorDistance(color, stableTarget) ?? Infinity)
        < (seriesColorDistance(activeColors[bestIndex]!, stableTarget) ?? Infinity)
        ? index
        : bestIndex
    ), 0);
    assignments[slot] = activeColors.splice(candidateIndex, 1)[0]!;
  }
  const used = new Set(assignments.filter((color): color is string => color !== undefined));
  const remaining = colors.filter((color) => !used.has(color));
  for (let slot = 0; slot < assignments.length; slot++) {
    if (assignments[slot] === undefined) assignments[slot] = remaining.shift()!;
  }
  return assignments.map((color) => color!);
}

export const DEFAULT_MAXIMIN_SERIES_PALETTE: Record<
  SeriesColorScheme,
  readonly string[]
> = {
  dark: maximinSeriesPalette('dark'),
  light: maximinSeriesPalette('light'),
};
