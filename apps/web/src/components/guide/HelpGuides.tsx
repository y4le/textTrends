import type {
  GuideId,
  GuideReadiness,
  GuideReadinessRemedy,
} from '../../lib/guide/definition.ts';
import {
  GUIDED_TOUR_SYNOPSIS,
  GUIDE_NOTE_SYNOPSES,
} from '../../lib/guide/help-content.ts';
import type { Place } from '../../lib/places.ts';
import type { ShortcutHelpContext } from '../../lib/shortcuts.ts';

export interface HelpGuidesProps {
  readonly context: ShortcutHelpContext;
  readonly place: Place;
  readonly readiness: GuideReadiness;
  readonly active: boolean;
  readonly onStart: (id: GuideId) => void;
  readonly onRemedy: (remedy: GuideReadinessRemedy) => void;
}

export function HelpGuides({
  context,
  place,
  readiness,
  active,
  onStart,
  onRemedy,
}: HelpGuidesProps) {
  const reasonId = readiness.status === 'disabled' ? 'help-guide-disabled-reason' : undefined;
  const notes = context === 'workbench'
    ? GUIDE_NOTE_SYNOPSES.filter((synopsis) => synopsis.places.includes(place))
    : [];
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
          aria-haspopup="dialog"
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
      {notes.length > 0 && (
        <div className="help-guide-notes">
          <h4>Guides for this view</h4>
          <ul>
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => onStart(note.id)}
                >
                  {note.title} · {note.duration}
                </button>
                <span>{note.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
