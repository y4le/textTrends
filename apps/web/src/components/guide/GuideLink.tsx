import { useId, type ReactNode } from 'react';
import type { Place } from '../../lib/places.ts';
import type { GuideId } from '../../lib/guide/definition.ts';
import { useGuide } from './GuideContext.ts';

export function GuideLink({
  guideId,
  place,
  children,
  className,
}: {
  readonly guideId: GuideId;
  readonly place: Place;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const guide = useGuide();
  const reactId = useId();
  const id = `guide-link-${guideId}-${reactId.replaceAll(':', '')}`;
  const start = () => {
    void guide.startGuide(guideId, {
      place,
      focusCandidates: [id, 'global-help-open', `place-${place}-heading`],
    });
  };
  return (
    <button
      id={id}
      type="button"
      className={className}
      aria-haspopup="dialog"
      onClick={start}
    >
      {children}
    </button>
  );
}
