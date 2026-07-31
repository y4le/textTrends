import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type ReactPortal,
} from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A domain-free, full-height form surface. Callers own navigation, drafts,
 * targets, and Apply/Cancel semantics; this shell owns only modal presentation.
 */
export function FormLayer({
  label,
  labelledBy,
  focusKey,
  onClose,
  children,
}: {
  readonly label?: string;
  readonly labelledBy?: string;
  readonly focusKey?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactPortal {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.getElementById('root');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert;
    };
  }, []);

  useEffect(() => {
    const initial = [...(layerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .find((node) => node.getClientRects().length > 0)
      ?? layerRef.current;
    initial?.focus({ preventScroll: true });
  }, [focusKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...(layerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((node) => node.getClientRects().length > 0);
    if (controls.length === 0) {
      event.preventDefault();
      layerRef.current?.focus();
      return;
    }
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={layerRef}
      className="form-layer"
      role="dialog"
      aria-modal="true"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
