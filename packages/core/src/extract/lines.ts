/**
 * Bounded source-line windows (commit 8b, planner ruling §4). The correction UI
 * shows the exact source line around a section's char anchor so a user corrects
 * evidence, not opaque offsets. A pathological physical line (no break for
 * megabytes) must NOT be shipped whole: the window is clamped to `maxChars`
 * around the anchor with explicit leading/trailing truncation flags, and never
 * splits a surrogate pair. Pure and offset-faithful — the same Unicode line
 * breaks the structure recipe's linePolicy recognizes.
 */

/** LF, CR, NEL (U+0085), LS (U+2028), PS (U+2029) — the recipe's line breaks. */
const BREAKS: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x85, 0x2028, 0x2029]);
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

interface LineWindow {
  /** UTF-16 char offsets of the returned window, source-faithful. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** The physical line extends before `start` (window was clipped leading). */
  readonly truncatedStart: boolean;
  /** The physical line extends past `end` (window was clipped trailing). */
  readonly truncatedEnd: boolean;
}

/**
 * The source line containing `anchor`, clamped to at most ~`maxChars` UTF-16
 * units centered on the anchor. When the physical line fits, the whole line is
 * returned with both flags false; when it does not, the window is clipped and
 * the corresponding flag is set. Terminators are excluded from the window.
 */
export function lineWindowAround(text: string, anchor: number, maxChars: number): LineWindow {
  const n = text.length;
  const a = Number.isFinite(anchor) ? Math.max(0, Math.min(n, Math.floor(anchor))) : 0;
  // A non-finite budget would defeat both stopping comparisons below (every
  // `>= NaN` is false) and scan the whole line — always bound it to ≥ 1.
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const half = Math.floor(budget / 2);

  let start = a;
  let truncatedStart = false;
  while (start > 0) {
    if (BREAKS.has(text.charCodeAt(start - 1))) break; // reached the line start
    if (a - start >= half) {
      truncatedStart = true;
      break;
    }
    start--;
  }

  let end = a;
  let truncatedEnd = false;
  while (end < n) {
    if (BREAKS.has(text.charCodeAt(end))) break; // reached the line end
    if (end - start >= budget) {
      truncatedEnd = true;
      break;
    }
    end++;
  }

  // Never yield a lone surrogate half at a clipped boundary.
  if (truncatedStart && start < end && isLowSurrogate(text.charCodeAt(start))) start++;
  if (truncatedEnd && end > start && isHighSurrogate(text.charCodeAt(end - 1))) end--;

  return { start, end, text: text.slice(start, end), truncatedStart, truncatedEnd };
}
