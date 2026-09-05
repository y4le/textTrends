import type { BarcodePointerSample, CapturedBarcodeTarget } from './barcode-view.ts';

export type CaptureBarcodePointer = (
  sample: BarcodePointerSample,
  allowExactSnap: boolean,
) => CapturedBarcodeTarget | null;
