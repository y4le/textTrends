import { useEffect, useRef } from 'react';
import { findScope, type InteractionState } from '../../lib/interaction.ts';
import type { Place } from '../../lib/places.ts';

/** The Find lifetime keeps a connected return target, or restores a new
 * place/Reader region when closing Find leaves focus orphaned. */
export function useFindFocusReturn({ interaction, place, readerOpen }: {
  readonly interaction: InteractionState;
  readonly place: Place;
  readonly readerOpen: boolean;
}) {
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const restoreFindFocus = useRef(false);
  const previousFindScope = useRef(findScope(interaction) !== null);

  useEffect(() => {
    const current = findScope(interaction) !== null;
    const previous = previousFindScope.current;
    previousFindScope.current = current;
    if (!previous || current) return;
    const shouldRestore = restoreFindFocus.current;
    restoreFindFocus.current = false;
    const target = findReturnFocus.current;
    findReturnFocus.current = null;
    const orphaned = document.activeElement === null || document.activeElement === document.body;
    if (!shouldRestore && !orphaned) return;
    requestAnimationFrame(() => {
      const connectedTarget = target?.isConnected
        ? target
        : target?.id
          ? document.getElementById(target.id)
          : null;
      if (connectedTarget) {
        connectedTarget.focus({ preventScroll: true });
        return;
      }
      document.getElementById(readerOpen ? 'reader-region' : `place-${place}-heading`)
        ?.focus({ preventScroll: true });
    });
  }, [interaction.kind, place, readerOpen]);

  return { findReturnFocus, restoreFindFocus };
}
