export type PointerIntent = 'precise' | 'direct';

/** Interaction capability belongs to the event, not the device's primary
 * pointer media query. Hybrid tablets can remain coarse-layout devices while
 * a trackpad, mouse, or hovering pen emits precise pointer events. */
export function pointerIntentFor(pointerType: string): PointerIntent {
  return pointerType === 'mouse' || pointerType === 'pen' ? 'precise' : 'direct';
}
