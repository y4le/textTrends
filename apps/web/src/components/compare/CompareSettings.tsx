import type {
  FrequencyTokenClassV1,
  KeynessSortFieldV1,
} from '@texttrends/core';
import type { KeynessSettingsInputV1 } from '../../lib/store.ts';
import { toggleCompareClass } from '../../lib/compare-view.ts';

const SORTS: readonly {
  readonly by: KeynessSortFieldV1;
  readonly label: string;
}[] = [
  { by: 'logRatio', label: 'log₂ ratio' },
  { by: 'g2', label: 'signed G²' },
  { by: 'countA', label: 'A count' },
  { by: 'countB', label: 'B count' },
];

export function CompareSettings({
  draft,
  message,
  onDraft,
  onApply,
  onCancel,
}: {
  readonly draft: KeynessSettingsInputV1;
  readonly message: string | null;
  readonly onDraft: (next: KeynessSettingsInputV1) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <form
      className="compare-settings-form"
      aria-label="Compare sort and filter"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <h3>Sort and filter</h3>
      <p className="compare-settings-note">
        One field applies to both projections. Each side keeps its own
        direction.
      </p>
      <div className="compare-settings-fields">
        <label>
          combined count ≥
          <input
            className="exact-input"
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(draft.minCountTotal) ? draft.minCountTotal : ''}
            onChange={(event) => onDraft({
              ...draft,
              minCountTotal: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <label>
          combined documents ≥
          <input
            className="exact-input"
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(draft.minDocFreqTotal)
              ? draft.minDocFreqTotal
              : ''}
            onChange={(event) => onDraft({
              ...draft,
              minDocFreqTotal: event.currentTarget.valueAsNumber,
            })}
          />
        </label>
        <fieldset>
          <legend>token classes</legend>
          {(['lexical', 'numeral'] as const).map((tokenClass) => (
            <label key={tokenClass}>
              <input
                type="checkbox"
                checked={draft.classes.includes(tokenClass)}
                onChange={() => onDraft({
                  ...draft,
                  classes: toggleCompareClass(
                    draft.classes,
                    tokenClass as FrequencyTokenClassV1,
                  ),
                })}
              />
              {tokenClass}
            </label>
          ))}
        </fieldset>
        <label>
          shared sort field
          <select
            className="exact-input"
            value={draft.sortBy}
            onChange={(event) => onDraft({
              ...draft,
              sortBy: event.currentTarget.value as KeynessSortFieldV1,
            })}
          >
            {SORTS.map(({ by, label }) => (
              <option key={by} value={by}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      {message && <p role="status" className="compare-settings-message">{message}</p>}
      <div className="form-layer-actions compare-settings-actions">
        <button type="button" onClick={onCancel}>cancel</button>
        <button type="submit">apply</button>
      </div>
    </form>
  );
}
