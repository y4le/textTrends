export interface ViewportSample {
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly offsetTop: number;
  readonly scale: number;
}

/** Differences below this are browser-chrome or subpixel noise, not a keyboard. */
export const KEYBOARD_INSET_MIN_PX = 24;
/** Pinch zoom changes VisualViewport.scale; browser page zoom does not. */
export const ZOOM_EPSILON = 0.01;
/** Defend against transient zero-height reports during rotation/WebView churn. */
export const KEYBOARD_INSET_MAX_RATIO = 0.6;

/**
 * Return the layout-viewport band occluded below the visual viewport.
 *
 * Comparing against innerHeight makes the compensation self-cancel when a
 * browser already resizes the layout viewport. Pinch zoom is deliberately
 * ignored so the app never fights native pan/zoom.
 */
export function keyboardInsetFor(sample: ViewportSample): number {
  const values = [
    sample.innerHeight,
    sample.visualHeight,
    sample.offsetTop,
    sample.scale,
  ];
  if (
    values.some((value) => !Number.isFinite(value))
    || sample.innerHeight <= 0
    || sample.visualHeight < 0
    || sample.offsetTop < 0
    || sample.scale <= 0
    || sample.scale > 1 + ZOOM_EPSILON
  ) {
    return 0;
  }

  const raw = sample.innerHeight - (sample.visualHeight + sample.offsetTop);
  if (raw < KEYBOARD_INSET_MIN_PX) return 0;
  return Math.round(Math.min(raw, sample.innerHeight * KEYBOARD_INSET_MAX_RATIO));
}
