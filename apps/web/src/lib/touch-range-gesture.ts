import type { SelectionPoint } from './selection.ts';

export const TOUCH_RANGE_MIN_PX = 24;
export const TOUCH_RANGE_HOLD_MS = 500;
export const TOUCH_RANGE_HOLD_MOVE_PX = 8;
const TOUCH_READ_MOVE_PX = 4;

export interface TouchRangeContact {
  readonly pointerId: number;
  readonly origin: SelectionPoint;
  readonly point: SelectionPoint;
  readonly downX: number;
  readonly downY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly moved: boolean;
}

export type TouchRangeGesture =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading'; readonly contact: TouchRangeContact }
  | {
      readonly phase: 'anchored';
      readonly anchor: TouchRangeContact;
      readonly endpoint: TouchRangeContact | null;
      readonly heldPointerIds: readonly number[];
    }
  | {
      readonly phase: 'ranging';
      readonly first: TouchRangeContact;
      readonly second: TouchRangeContact;
      readonly heldPointerIds: readonly number[];
    }
  | { readonly phase: 'spent'; readonly heldPointerIds: readonly number[] };

export type TouchRangeEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'scrub'; readonly point: SelectionPoint }
  | { readonly kind: 'tap'; readonly point: SelectionPoint }
  | { readonly kind: 'anchor'; readonly point: SelectionPoint }
  | {
      readonly kind: 'preview';
      readonly origin: SelectionPoint;
      readonly head: SelectionPoint;
    }
  | {
      readonly kind: 'commit';
      readonly origin: SelectionPoint;
      readonly head: SelectionPoint;
    }
  | { readonly kind: 'cancel' };

export interface TouchRangeTransition {
  readonly state: TouchRangeGesture;
  readonly effect: TouchRangeEffect;
}

interface TouchSample {
  readonly pointerId: number;
  readonly point: SelectionPoint | null;
  readonly clientX: number;
  readonly clientY: number;
}

const idle = (): TouchRangeGesture => ({ phase: 'idle' });
const none = (state: TouchRangeGesture): TouchRangeTransition => ({
  state,
  effect: { kind: 'none' },
});
const without = (ids: readonly number[], pointerId: number): number[] =>
  ids.filter((id) => id !== pointerId);
const withPointer = (ids: readonly number[], pointerId: number): number[] =>
  ids.includes(pointerId) ? [...ids] : [...ids, pointerId];

function contactFrom(sample: TouchSample & { readonly point: SelectionPoint }): TouchRangeContact {
  return {
    pointerId: sample.pointerId,
    origin: sample.point,
    point: sample.point,
    downX: sample.clientX,
    downY: sample.clientY,
    clientX: sample.clientX,
    clientY: sample.clientY,
    moved: false,
  };
}

function updateContact(contact: TouchRangeContact, sample: TouchSample): TouchRangeContact {
  if (contact.pointerId !== sample.pointerId) return contact;
  return {
    ...contact,
    point: sample.point ?? contact.point,
    clientX: sample.clientX,
    clientY: sample.clientY,
    moved: contact.moved || Math.hypot(
      sample.clientX - contact.downX,
      sample.clientY - contact.downY,
    ) >= TOUCH_READ_MOVE_PX,
  };
}

function rangeMeetsFloor(first: TouchRangeContact, second: TouchRangeContact): boolean {
  return first.point.doc !== second.point.doc
    || Math.abs(first.clientX - second.clientX) >= TOUCH_RANGE_MIN_PX;
}

export function beginTouchRangeGesture(): TouchRangeGesture {
  return idle();
}

export function touchRangeDown(
  state: TouchRangeGesture,
  sample: TouchSample & { readonly point: SelectionPoint },
): TouchRangeTransition {
  if (state.phase === 'idle') {
    return none({ phase: 'reading', contact: contactFrom(sample) });
  }
  if (state.phase === 'reading') {
    if (state.contact.pointerId === sample.pointerId) return none(state);
    const second = contactFrom(sample);
    const next: TouchRangeGesture = {
      phase: 'ranging',
      first: state.contact,
      second,
      heldPointerIds: [state.contact.pointerId, second.pointerId],
    };
    return {
      state: next,
      effect: {
        kind: 'preview',
        origin: next.first.point,
        head: next.second.point,
      },
    };
  }
  if (state.phase === 'anchored') {
    if (state.heldPointerIds.includes(sample.pointerId)) return none(state);
    const endpoint = contactFrom(sample);
    if (state.heldPointerIds.includes(state.anchor.pointerId)) {
      const next: TouchRangeGesture = {
        phase: 'ranging',
        first: state.anchor,
        second: endpoint,
        heldPointerIds: withPointer(state.heldPointerIds, endpoint.pointerId),
      };
      return {
        state: next,
        effect: {
          kind: 'preview',
          origin: next.first.point,
          head: next.second.point,
        },
      };
    }
    if (state.endpoint !== null) {
      return none({
        ...state,
        heldPointerIds: withPointer(state.heldPointerIds, sample.pointerId),
      });
    }
    return {
      state: {
        ...state,
        endpoint,
        heldPointerIds: withPointer(state.heldPointerIds, endpoint.pointerId),
      },
      effect: { kind: 'preview', origin: state.anchor.point, head: endpoint.point },
    };
  }
  if (state.phase === 'ranging') {
    return none({
      ...state,
      heldPointerIds: withPointer(state.heldPointerIds, sample.pointerId),
    });
  }
  return none({
    ...state,
    heldPointerIds: withPointer(state.heldPointerIds, sample.pointerId),
  });
}

export function touchRangeMove(
  state: TouchRangeGesture,
  sample: TouchSample,
): TouchRangeTransition {
  if (state.phase === 'reading') {
    if (state.contact.pointerId !== sample.pointerId) return none(state);
    const contact = updateContact(state.contact, sample);
    return {
      state: { phase: 'reading', contact },
      effect: sample.point
        ? { kind: 'scrub', point: contact.point }
        : { kind: 'none' },
    };
  }
  if (state.phase === 'anchored') {
    if (state.endpoint?.pointerId !== sample.pointerId) return none(state);
    const endpoint = updateContact(state.endpoint, sample);
    return {
      state: { ...state, endpoint },
      effect: {
        kind: 'preview',
        origin: state.anchor.point,
        head: endpoint.point,
      },
    };
  }
  if (state.phase !== 'ranging') return none(state);
  if (
    state.first.pointerId !== sample.pointerId
    && state.second.pointerId !== sample.pointerId
  ) return none(state);
  const first = updateContact(state.first, sample);
  const second = updateContact(state.second, sample);
  return {
    state: { ...state, first, second },
    effect: { kind: 'preview', origin: first.point, head: second.point },
  };
}

export function touchRangeUp(
  state: TouchRangeGesture,
  sample: TouchSample,
): TouchRangeTransition {
  if (state.phase === 'idle') return none(state);
  if (state.phase === 'reading') {
    if (state.contact.pointerId !== sample.pointerId) return none(state);
    const contact = updateContact(state.contact, sample);
    return {
      state: idle(),
      effect: contact.moved
        ? { kind: 'none' }
        : { kind: 'tap', point: contact.origin },
    };
  }
  if (state.phase === 'anchored') {
    const heldPointerIds = without(state.heldPointerIds, sample.pointerId);
    if (state.endpoint?.pointerId === sample.pointerId) {
      const endpoint = updateContact(state.endpoint, sample);
      return {
        state: heldPointerIds.length > 0
          ? { phase: 'spent', heldPointerIds }
          : idle(),
        effect: rangeMeetsFloor(state.anchor, endpoint)
          ? {
              kind: 'commit',
              origin: state.anchor.point,
              head: endpoint.point,
            }
          : { kind: 'cancel' },
      };
    }
    if (state.anchor.pointerId === sample.pointerId) {
      return none({ ...state, heldPointerIds });
    }
    return none({ ...state, heldPointerIds });
  }
  if (state.phase === 'spent') {
    const heldPointerIds = without(state.heldPointerIds, sample.pointerId);
    return none(heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle());
  }
  const heldPointerIds = without(state.heldPointerIds, sample.pointerId);
  const ownsEndpoint = state.first.pointerId === sample.pointerId
    || state.second.pointerId === sample.pointerId;
  if (!ownsEndpoint) return none({ ...state, heldPointerIds });
  const first = updateContact(state.first, sample);
  const second = updateContact(state.second, sample);
  return {
    state: heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle(),
    effect: rangeMeetsFloor(first, second)
      ? { kind: 'commit', origin: first.point, head: second.point }
      : { kind: 'cancel' },
  };
}

export function touchRangeCancel(
  state: TouchRangeGesture,
  pointerId: number,
): TouchRangeTransition {
  if (state.phase === 'idle') return none(state);
  if (state.phase === 'reading') {
    return state.contact.pointerId === pointerId ? none(idle()) : none(state);
  }
  if (state.phase === 'anchored') {
    const heldPointerIds = without(state.heldPointerIds, pointerId);
    const ownsSelection = state.anchor.pointerId === pointerId
      || state.endpoint?.pointerId === pointerId;
    if (!ownsSelection) return none({ ...state, heldPointerIds });
    return {
      state: heldPointerIds.length > 0
        ? { phase: 'spent', heldPointerIds }
        : idle(),
      effect: { kind: 'cancel' },
    };
  }
  if (state.phase === 'spent') {
    const heldPointerIds = without(state.heldPointerIds, pointerId);
    return none(heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle());
  }
  const heldPointerIds = without(state.heldPointerIds, pointerId);
  const ownsEndpoint = state.first.pointerId === pointerId
    || state.second.pointerId === pointerId;
  if (!ownsEndpoint) return none({ ...state, heldPointerIds });
  return {
    state: heldPointerIds.length > 0
      ? { phase: 'spent', heldPointerIds }
      : idle(),
    effect: { kind: 'cancel' },
  };
}

export function resetTouchRangeGesture(
  state: TouchRangeGesture,
): TouchRangeTransition {
  const activePointerIds = state.phase === 'ranging' || state.phase === 'anchored'
    ? state.heldPointerIds
    : [];
  return {
    state: state.phase === 'ranging' || state.phase === 'anchored'
      ? activePointerIds.length > 0
        ? { phase: 'spent', heldPointerIds: activePointerIds }
        : idle()
      : state.phase === 'spent'
        ? state
        : idle(),
    effect: state.phase === 'ranging' || state.phase === 'anchored'
      ? { kind: 'cancel' }
      : { kind: 'none' },
  };
}

export function touchRangeHold(
  state: TouchRangeGesture,
  pointerId: number,
): TouchRangeTransition {
  if (state.phase !== 'reading' || state.contact.pointerId !== pointerId) {
    return none(state);
  }
  if (Math.hypot(
    state.contact.clientX - state.contact.downX,
    state.contact.clientY - state.contact.downY,
  ) > TOUCH_RANGE_HOLD_MOVE_PX) {
    return none(state);
  }
  return {
    state: {
      phase: 'anchored',
      anchor: state.contact,
      endpoint: null,
      heldPointerIds: [state.contact.pointerId],
    },
    effect: { kind: 'anchor', point: state.contact.point },
  };
}
