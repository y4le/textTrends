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
  { by: 'logRatioLow', label: 'lower 95% bound' },
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
      aria-label="Compare settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <header className="compare-settings-header">
        <h2>Compare settings</h2>
      </header>

      <div className="compare-settings-sections">
        <section aria-labelledby="compare-ranking-settings">
          <h3 id="compare-ranking-settings">Rankings</h3>
          <p className="compare-settings-note">
            One sort field applies to both projections; each side can keep its
            own direction.
          </p>
          <div className="compare-settings-fields">
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
            {(['a', 'b'] as const).map((side) => (
              <label key={side}>
                {side === 'a' ? 'left' : 'right'} ranking order
                <select
                  className="exact-input"
                  value={side === 'a' ? draft.dirA : draft.dirB}
                  onChange={(event) => onDraft({
                    ...draft,
                    ...(side === 'a'
                      ? { dirA: Number(event.currentTarget.value) as 1 | -1 }
                      : { dirB: Number(event.currentTarget.value) as 1 | -1 }),
                  })}
                >
                  <option value={-1}>descending</option>
                  <option value={1}>ascending</option>
                </select>
              </label>
            ))}
          </div>
        </section>

        <section aria-labelledby="compare-filter-settings">
          <h3 id="compare-filter-settings">Filters</h3>
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
          </div>
        </section>

        <section aria-labelledby="compare-display-settings">
          <h3 id="compare-display-settings">Display</h3>
          <label className="compare-settings-toggle">
            <input
              type="checkbox"
              checked={draft.showConfidenceIntervals}
              onChange={(event) => onDraft({
                ...draft,
                showConfidenceIntervals: event.currentTarget.checked,
              })}
            />
            Show 95% confidence interval whiskers
          </label>
          <p className="compare-settings-note">
            Adds interval whiskers to ranked terms. Exact intervals remain
            available in each term’s detail.
          </p>
        </section>
      </div>
      {message && <p role="status" className="compare-settings-message">{message}</p>}
      <div className="form-layer-actions compare-settings-actions">
        <button type="button" onClick={onCancel}>cancel</button>
        <button type="submit">apply</button>
      </div>
    </form>
  );
}
