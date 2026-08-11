const commonRate = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});
const rareRateFormats = new Map<number, Intl.NumberFormat>();

function rareRateFormat(maximumFractionDigits: number): Intl.NumberFormat {
  const existing = rareRateFormats.get(maximumFractionDigits);
  if (existing) return existing;
  const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits });
  rareRateFormats.set(maximumFractionDigits, formatter);
  return formatter;
}

/**
 * Keep the ordinary one-decimal rate grammar while giving sub-unit values
 * three significant decimal digits. A real non-zero rate must not be printed
 * as zero merely because its corpus is large.
 */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  if (value === 0) return '0';
  const absolute = Math.abs(value);
  if (absolute >= 1) return commonRate.format(value);
  const maximumFractionDigits = 2 - Math.floor(Math.log10(absolute));
  if (maximumFractionDigits > 20) return value.toExponential(2);
  return rareRateFormat(maximumFractionDigits).format(value);
}
