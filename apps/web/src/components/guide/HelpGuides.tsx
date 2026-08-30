import type {
  GuideId,
  GuideReadiness,
  GuideReadinessRemedy,
} from '../../lib/guide/definition.ts';
import { GUIDED_TOUR_SYNOPSIS } from '../../lib/guide/help-content.ts';

export interface HelpGuidesProps {
  readonly readiness: GuideReadiness;
  readonly active: boolean;
  readonly onStart: (id: GuideId) => void;
  readonly onRemedy: (remedy: GuideReadinessRemedy) => void;
}

export function HelpGuides({
  readiness,
  active,
  onStart,
  onRemedy,
}: HelpGuidesProps) {
  const reasonId = readiness.status === 'disabled' ? 'help-guide-disabled-reason' : undefined;
  return (
    <section className="help-guides" aria-labelledby="help-guides">
      <h3 id="help-guides">Guided learning</h3>
      <p>
        <strong>{GUIDED_TOUR_SYNOPSIS.title}</strong> · {GUIDED_TOUR_SYNOPSIS.summary}
      </p>
      {readiness.status === 'disabled' && (
        <p id={reasonId} className="help-guide-reason">{readiness.reason}</p>
      )}
      <div className="help-actions">
        <button
          id="help-guide-start"
          type="button"
          disabled={readiness.status === 'disabled'}
          {...(reasonId === undefined ? {} : { 'aria-describedby': reasonId })}
          onClick={() => onStart(GUIDED_TOUR_SYNOPSIS.id)}
        >
          {active ? 'Restart' : 'Start'} the guided tour · {GUIDED_TOUR_SYNOPSIS.duration}
        </button>
        {readiness.status === 'disabled' && readiness.remedy && (
          <button type="button" onClick={() => onRemedy(readiness.remedy!)}>
            {readiness.remedy.label}
          </button>
        )}
      </div>
    </section>
  );
}
