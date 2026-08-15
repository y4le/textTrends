import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** A viewport-aware, input-agnostic explanation tooltip. The disabled state is
 * used by adjustable data grids so a resize gesture can never open or pin a
 * tooltip over a separator. */
export function InfoTooltip({
  id,
  label,
  explanation,
  disabled = false,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly explanation: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const open = !disabled && (hovered || focused || pinned);

  useEffect(() => {
    if (!disabled) return;
    setHovered(false);
    setFocused(false);
    setPinned(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setHovered(false);
      setFocused(false);
      setPinned(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const triggerBox = button.current?.getBoundingClientRect();
      const tooltipBox = tooltip.current?.getBoundingClientRect();
      if (!triggerBox || !tooltipBox) return;
      const padding = 8;
      const gap = 4;
      const centered = triggerBox.left + (triggerBox.width - tooltipBox.width) / 2;
      const left = Math.min(
        Math.max(padding, centered),
        Math.max(padding, window.innerWidth - tooltipBox.width - padding),
      );
      const below = triggerBox.bottom + gap;
      const above = triggerBox.top - tooltipBox.height - gap;
      const top = below + tooltipBox.height <= window.innerHeight - padding || above < padding
        ? below
        : above;
      setPosition({ left, top: Math.max(padding, top), ready: true });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <>
      <span
        ref={root}
        className={['measurement-info', className].filter(Boolean).join(' ')}
        data-open={open || undefined}
        onPointerEnter={(event) => {
          if (!disabled && event.pointerType !== 'touch') setHovered(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') setHovered(false);
        }}
      >
        <button
          ref={button}
          type="button"
          className="measurement-info-button"
          aria-label={`About ${label}`}
          aria-describedby={disabled ? undefined : id}
          aria-controls={disabled ? undefined : id}
          disabled={disabled}
          onClick={() => setPinned((current) => !current)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setPinned(false);
          }}
        >
          <span aria-hidden="true">ⓘ</span>
        </button>
      </span>
      {createPortal(
        <span
          ref={tooltip}
          id={id}
          role="tooltip"
          className="measurement-info-tooltip"
          data-open={open || undefined}
          style={{
            display: open ? 'block' : 'none',
            left: position.left,
            top: position.top,
            visibility: open && position.ready ? 'visible' : 'hidden',
          }}
        >
          {explanation}
        </span>,
        document.body,
      )}
    </>
  );
}
