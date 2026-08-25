import { useEffect, useState } from 'react';
import {
  compareSettingsError,
  compareSettingsInput,
} from '../../lib/compare-view.ts';
import type { KeynessSettingsInputV1 } from '../../lib/store.ts';
import { useApp } from '../../lib/store-instance.ts';
import { CompareSettings } from '../compare/CompareSettings.tsx';

export function CompareSettingsSection({
  onApplied,
  onCancel,
}: {
  readonly onApplied: () => void;
  readonly onCancel: () => void;
}) {
  const view = useApp((state) => state.keynessView);
  const applySettings = useApp((state) => state.applyKeynessSettings);
  const [draft, setDraft] = useState<KeynessSettingsInputV1>(
    () => compareSettingsInput(view),
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(compareSettingsInput(view));
    setMessage(null);
  }, [
    view.minCountTotal,
    view.minDocFreqTotal,
    view.classes,
    view.stoplistTopN,
    view.sort.by,
    view.sort.dirA,
    view.sort.dirB,
    view.showConfidenceIntervals,
  ]);

  const apply = () => {
    const error = compareSettingsError(draft);
    if (error) {
      setMessage(error);
      return;
    }
    setMessage(null);
    applySettings(draft);
    onApplied();
  };

  return (
    <CompareSettings
      draft={draft}
      message={message}
      onDraft={(next) => {
        setMessage(null);
        setDraft(next);
      }}
      onApply={apply}
      onCancel={onCancel}
    />
  );
}
