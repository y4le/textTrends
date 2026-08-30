/** Truthful native occurrence activation, independent of guide copy. */

export const GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE =
  'data-guide-occurrence-activation' as const;

export type OccurrenceActivation = 'available' | 'minimized' | 'coarse';
export type ObservedOccurrenceActivation = OccurrenceActivation | 'unknown';

export function occurrenceActivationFor(input: {
  readonly coarse: boolean;
  readonly barcodeInteractive: boolean;
}): OccurrenceActivation {
  if (!input.barcodeInteractive) return 'minimized';
  return input.coarse ? 'coarse' : 'available';
}

export interface OccurrenceActivationProps {
  readonly 'data-guide-occurrence-activation': OccurrenceActivation;
}

export function occurrenceActivationProps(input: {
  readonly coarse: boolean;
  readonly barcodeInteractive: boolean;
}): OccurrenceActivationProps {
  return {
    [GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE]: occurrenceActivationFor(input),
  };
}

export function readOccurrenceActivation(
  anchor: Pick<Element, 'getAttribute'> | null,
): ObservedOccurrenceActivation {
  const value = anchor?.getAttribute(GUIDE_OCCURRENCE_ACTIVATION_ATTRIBUTE);
  return value === 'available' || value === 'minimized' || value === 'coarse'
    ? value
    : 'unknown';
}
