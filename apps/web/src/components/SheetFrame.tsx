import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { SheetDetent } from '../lib/layers.ts';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function SheetFrame({
  title,
  detent,
  compact,
  onDetent,
  onClose,
  children,
}: {
  readonly title: string;
  readonly detent: SheetDetent;
  readonly compact: boolean;
  readonly onDetent: (detent: SheetDetent) => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const modal = detent !== 'peek';

  useEffect(() => {
    const close = sheetRef.current?.querySelector<HTMLElement>('[data-sheet-close]');
    close?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!modal) return undefined;
    const root = document.getElementById('root');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    return () => {
      if (root) root.inert = wasInert;
    };
  }, [modal]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!modal || event.key !== 'Tab') return;
    const controls = [...(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((node) => node.getClientRects().length > 0);
    if (controls.length === 0) {
      event.preventDefault();
      sheetRef.current?.focus();
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
    <>
      {modal && <div className="sheet-scrim" aria-hidden="true" />}
      <section
        ref={sheetRef}
        className="workbench-sheet"
        data-detent={detent}
        data-compact={compact}
        role="dialog"
        aria-modal={modal ? 'true' : 'false'}
        aria-label={`${title} sheet`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="sheet-header">
          <strong>{title}</strong>
          <div className="sheet-controls">
            <button
              type="button"
              aria-pressed={detent === 'peek'}
              onClick={() => onDetent('peek')}
            >
              peek
            </button>
            <button
              type="button"
              aria-pressed={detent === 'half'}
              onClick={() => onDetent('half')}
            >
              half
            </button>
            <button
              type="button"
              aria-pressed={detent === 'tall'}
              onClick={() => onDetent('tall')}
            >
              tall
            </button>
            <button
              type="button"
              data-sheet-close
              aria-label={`Close ${title} sheet`}
              onClick={onClose}
            >
              close
            </button>
          </div>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </>,
    document.body,
  );
}
