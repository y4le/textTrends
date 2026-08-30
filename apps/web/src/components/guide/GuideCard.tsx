import { useLayoutEffect, type KeyboardEvent } from 'react';
import {
  GUIDE_CARD_HEADING_ID,
} from '../../lib/guide/anchors.ts';
import type {
  GuideActionId,
  GuideCopy,
  GuideStep,
} from '../../lib/guide/definition.ts';

export function GuideCard({
  copy,
  side,
  stepId,
  focusRevision,
  reader,
  onAction,
}: {
  readonly copy: GuideCopy;
  readonly side: GuideStep['cardSide'];
  readonly stepId: string;
  readonly focusRevision: number;
  readonly reader: boolean;
  readonly onAction: (action: GuideActionId) => void;
}) {
  const bodyId = `guide-card-${stepId}-body`;
  const statusId = copy.status === undefined ? undefined : `guide-card-${stepId}-status`;
  useLayoutEffect(() => {
    document.getElementById(GUIDE_CARD_HEADING_ID)?.focus({ preventScroll: true });
  }, [focusRevision]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    onAction('exit');
  };

  return (
    <aside
      className="guide-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={GUIDE_CARD_HEADING_ID}
      aria-describedby={[bodyId, statusId].filter(Boolean).join(' ')}
      data-guide-side={side}
      data-guide-step={stepId}
      data-guide-reader={reader ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      <header className="guide-card-header">
        <p className="guide-card-kicker">{copy.kicker}</p>
        <button
          className="guide-card-close"
          type="button"
          aria-label="Exit guided tour"
          onClick={() => onAction('exit')}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="guide-card-content">
        <h2 id={GUIDE_CARD_HEADING_ID} tabIndex={-1}>{copy.title}</h2>
        <p id={bodyId}>{copy.body}</p>
        {copy.hints?.map((hint) => <p className="guide-card-hint" key={hint}>{hint}</p>)}
        {copy.status && (
          <p
            id={statusId}
            className="guide-card-status"
            data-tone={copy.status.tone}
          >
            {copy.status.text}
          </p>
        )}
      </div>
      <footer className="guide-card-actions">
        {copy.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            data-guide-action={action.id}
            disabled={action.disabled}
            {...(action.disabled && statusId !== undefined
              ? { 'aria-describedby': statusId }
              : {})}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </footer>
    </aside>
  );
}
