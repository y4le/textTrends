import type { Place } from './places.ts';
import { MAX_PINNED_SNIPPETS } from './pins.ts';

export interface PinCapacityVM {
  readonly used: number;
  readonly cap: number;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly route: Place | null;
}

/**
 * One capacity vocabulary for every Save excerpt entry point. Callers must
 * not invent another refusal or at-capacity destination.
 */
export function pinCapacity(
  used: number,
  cap = MAX_PINNED_SNIPPETS,
): PinCapacityVM {
  if (
    !Number.isSafeInteger(used)
    || !Number.isSafeInteger(cap)
    || used < 0
    || cap < 1
    || used > cap
  ) {
    throw new RangeError('pin capacity requires integers with 0 <= used <= cap');
  }
  const full = used === cap;
  return {
    used,
    cap,
    label: `${used} of ${cap} saved excerpts`,
    enabled: !full,
    reason: full ? `Saved excerpts are limited to ${cap} — remove one from Findings first.` : null,
    route: full ? 'findings' : null,
  };
}
