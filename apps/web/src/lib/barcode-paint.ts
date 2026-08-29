export interface BarcodeTrackRect {
  readonly top: number;
  readonly height: number;
}

/** Snap one barcode track to physical pixels while retaining CSS-pixel
 * coordinates for the scaled canvas context. */
export function barcodeTrackRect(
  row: number,
  trackHeight: number,
  trackGap: number,
  devicePixelRatio: number,
): BarcodeTrackRect {
  const safeRow = Number.isFinite(row) ? Math.max(0, Math.floor(row)) : 0;
  const safeHeight = Number.isFinite(trackHeight) ? Math.max(0, trackHeight) : 0;
  const safeGap = Number.isFinite(trackGap) ? Math.max(0, trackGap) : 0;
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const rawTop = safeRow * (safeHeight + safeGap);
  const top = Math.round(rawTop * scale) / scale;
  const bottom = Math.round((rawTop + safeHeight) * scale) / scale;
  return Object.freeze({
    top,
    height: safeHeight > 0 ? Math.max(1 / scale, bottom - top) : 0,
  });
}
