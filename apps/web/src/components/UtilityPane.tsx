import {
  useId,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { FormLayer } from './FormLayer.tsx';

export function UtilityPane({
  title,
  subtitle,
  focusKey,
  initialFocus = 'first-control',
  initialFocusId,
  closeKeyshortcuts,
  className,
  layerClassName,
  compactClose = false,
  closeOnBackdrop = false,
  onClose,
  onKeyDown,
  bodyRef,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly focusKey?: string;
  readonly initialFocus?: 'heading' | 'first-control';
  readonly initialFocusId?: string;
  readonly closeKeyshortcuts?: string;
  readonly className?: string;
  readonly layerClassName?: string;
  readonly compactClose?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly onClose: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly bodyRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  const titleId = useId();

  return (
    <FormLayer
      labelledBy={titleId}
      {...(focusKey === undefined ? {} : { focusKey })}
      {...(initialFocusId === undefined
        ? initialFocus === 'heading' ? { initialFocusId: titleId } : {}
        : { initialFocusId })}
      {...(layerClassName === undefined ? {} : { className: layerClassName })}
      closeOnBackdrop={closeOnBackdrop}
      onClose={onClose}
    >
      <section
        className={['utility-pane', className].filter(Boolean).join(' ')}
        data-footer={footer ? true : undefined}
        onKeyDown={onKeyDown}
      >
        <header className="utility-pane-header">
          <div>
            <h2 id={titleId} tabIndex={initialFocus === 'heading' ? -1 : undefined}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            {...(compactClose ? { 'aria-label': 'close' } : {})}
            {...(closeKeyshortcuts === undefined ? {} : { 'aria-keyshortcuts': closeKeyshortcuts })}
            onClick={onClose}
          >
            {compactClose ? <span aria-hidden="true">×</span> : 'close'}
          </button>
        </header>
        <div ref={bodyRef} className="utility-pane-body">{children}</div>
        {footer && <footer className="utility-pane-footer">{footer}</footer>}
      </section>
    </FormLayer>
  );
}
