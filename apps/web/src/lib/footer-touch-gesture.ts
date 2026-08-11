import type { ScrubTarget } from './store.ts';

export const FOOTER_TOUCH_INTENT_PX = 8;
export const FOOTER_TOUCH_AXIS_RATIO = 1.15;

export interface FooterTouchContact {
  readonly pointerId: number;
  readonly origin: ScrubTarget;
  readonly downX: number;
  readonly downY: number;
  readonly clientX: number;
  readonly clientY: number;
}

export type FooterTouchGesture =
  | { readonly phase: 'idle' }
  | { readonly phase: 'pending'; readonly contact: FooterTouchContact }
  | { readonly phase: 'scrubbing'; readonly contact: FooterTouchContact }
  | { readonly phase: 'spent'; readonly heldPointerIds: readonly number[] };

export type FooterTouchEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'jump'; readonly point: ScrubTarget }
  | { readonly kind: 'scrub'; readonly point: ScrubTarget };

export interface FooterTouchTransition {
  readonly state: FooterTouchGesture;
  readonly effect: FooterTouchEffect;
}

export interface FooterTouchSample {
  readonly pointerId: number;
  readonly point: ScrubTarget | null;
  readonly clientX: number;
  readonly clientY: number;
}

const idle = (): FooterTouchGesture => ({ phase: 'idle' });
const none = (state: FooterTouchGesture): FooterTouchTransition => ({
  state,
  effect: { kind: 'none' },
});
const without = (ids: readonly number[], pointerId: number): number[] =>
  ids.filter((id) => id !== pointerId);
const withPointer = (ids: readonly number[], pointerId: number): number[] =>
  ids.includes(pointerId) ? [...ids] : [...ids, pointerId];

function contactFrom(
  sample: FooterTouchSample & { readonly point: ScrubTarget },
): FooterTouchContact {
  return {
    pointerId: sample.pointerId,
    origin: sample.point,
    downX: sample.clientX,
    downY: sample.clientY,
    clientX: sample.clientX,
    clientY: sample.clientY,
  };
}

function updateContact(
  contact: FooterTouchContact,
  sample: FooterTouchSample,
): FooterTouchContact {
  if (contact.pointerId !== sample.pointerId) return contact;
  return {
    ...contact,
    clientX: sample.clientX,
    clientY: sample.clientY,
  };
}

function heldIds(state: FooterTouchGesture): readonly number[] {
  switch (state.phase) {
    case 'idle': return [];
    case 'pending':
    case 'scrubbing': return [state.contact.pointerId];
    case 'spent': return state.heldPointerIds;
  }
}

export function beginFooterTouchGesture(): FooterTouchGesture {
  return idle();
}

export function footerTouchDown(
  state: FooterTouchGesture,
  sample: FooterTouchSample & { readonly point: ScrubTarget },
): FooterTouchTransition {
  if (state.phase === 'idle') {
    return none({ phase: 'pending', contact: contactFrom(sample) });
  }
  return none({
    phase: 'spent',
    heldPointerIds: withPointer(heldIds(state), sample.pointerId),
  });
}

export function footerTouchMove(
  state: FooterTouchGesture,
  sample: FooterTouchSample,
): FooterTouchTransition {
  if (state.phase === 'idle' || state.phase === 'spent') return none(state);
  if (state.contact.pointerId !== sample.pointerId) return none(state);
  const contact = updateContact(state.contact, sample);
  if (state.phase === 'scrubbing') {
    return {
      state: { phase: 'scrubbing', contact },
      effect: sample.point ? { kind: 'scrub', point: sample.point } : { kind: 'none' },
    };
  }
  const dx = Math.abs(sample.clientX - contact.downX);
  const dy = Math.abs(sample.clientY - contact.downY);
  if (Math.hypot(dx, dy) < FOOTER_TOUCH_INTENT_PX) {
    return none({ phase: 'pending', contact });
  }
  if (dy > dx * FOOTER_TOUCH_AXIS_RATIO) {
    return none({ phase: 'spent', heldPointerIds: [contact.pointerId] });
  }
  if (dx < dy * FOOTER_TOUCH_AXIS_RATIO) {
    return none({ phase: 'pending', contact });
  }
  return {
    state: { phase: 'scrubbing', contact },
    effect: sample.point ? { kind: 'scrub', point: sample.point } : { kind: 'none' },
  };
}

export function footerTouchUp(
  state: FooterTouchGesture,
  sample: FooterTouchSample,
): FooterTouchTransition {
  if (state.phase === 'idle') return none(state);
  if (state.phase === 'spent') {
    const heldPointerIds = without(state.heldPointerIds, sample.pointerId);
    return none(heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle());
  }
  if (state.contact.pointerId !== sample.pointerId) return none(state);
  if (state.phase === 'pending') {
    return {
      state: idle(),
      effect: { kind: 'jump', point: sample.point ?? state.contact.origin },
    };
  }
  return {
    state: idle(),
    effect: sample.point ? { kind: 'scrub', point: sample.point } : { kind: 'none' },
  };
}

export function footerTouchCancel(
  state: FooterTouchGesture,
  pointerId: number,
): FooterTouchTransition {
  if (state.phase === 'idle') return none(state);
  if (state.phase === 'spent') {
    const heldPointerIds = without(state.heldPointerIds, pointerId);
    return none(heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle());
  }
  return state.contact.pointerId === pointerId ? none(idle()) : none(state);
}

export function resetFooterTouchGesture(): FooterTouchTransition {
  return none(idle());
}
