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
 * One capacity vocabulary for every Pin entry point. The route is declarative
 * until canonical place routing lands in W1; callers must not invent another
 * at-capacity destination.
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
    label: `${used} of ${cap} pinned`,
    enabled: !full,
    reason: full ? `Pin limit reached — remove pinned evidence before retaining another passage.` : null,
    route: full ? 'findings' : null,
  };
}
