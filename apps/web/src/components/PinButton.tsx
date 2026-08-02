import type { PinCapacityVM } from '../lib/pin-capacity.ts';
import { SMALL_BUTTON_STYLE } from './chrome.tsx';

export function PinButton({
  capacity,
  label,
  onPin,
}: {
  readonly capacity: PinCapacityVM;
  readonly label: string;
  readonly onPin: () => void;
}) {
  return (
    <button
      className="coarse-target"
      type="button"
      aria-label={label}
      aria-disabled={!capacity.enabled || undefined}
      title={capacity.reason ?? 'Save this excerpt to Findings'}
      // Stay focusable at capacity: activation reaches the store's existing
      // live refusal message instead of hiding the reason in a tooltip.
      onClick={onPin}
      style={{
        ...SMALL_BUTTON_STYLE,
        opacity: capacity.enabled ? 1 : 0.55,
        cursor: capacity.enabled ? 'pointer' : 'default',
      }}
    >
      Save excerpt
    </button>
  );
}
