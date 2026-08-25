import type { SettingsContext } from '../../lib/settings-entry.ts';
import { TrendSettings } from '../TrendSettings.tsx';
import { CompareSettingsSection } from './CompareSettingsSection.tsx';

const METHOD_SUMMARY: Readonly<Record<Exclude<SettingsContext, 'trends' | 'compare'>, string>> = Object.freeze({
  inputs: 'Inputs composes the browser-local corpus. Reordering or removing a text changes reading order and recomputes analysis.',
  matches: 'Matches keeps occurrences centered on the shared reading position and shows their surrounding corpus context.',
  vocabulary: 'Vocabulary ranks words in the active corpus; its visible filters remain beside the table.',
  reader: 'Reader presents authenticated plain text from the active corpus. Page fitting preserves the current start position.',
});

export function PlaceSettings({
  context,
  onApplied,
}: {
  readonly context: SettingsContext;
  readonly onApplied: () => void;
}) {
  if (context === 'trends') return <TrendSettings onApplied={onApplied} />;
  if (context === 'compare') {
    return <CompareSettingsSection onApplied={onApplied} onCancel={onApplied} />;
  }
  return <p className="settings-method-summary">{METHOD_SUMMARY[context]}</p>;
}
