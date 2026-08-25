import type { SettingsContext } from '../../lib/settings-entry.ts';
import { TrendSettings } from '../TrendSettings.tsx';

const METHOD_SUMMARY: Readonly<Record<Exclude<SettingsContext, 'trends'>, string>> = Object.freeze({
  inputs: 'Inputs composes the browser-local corpus. Reordering or removing a text changes reading order and recomputes analysis.',
  matches: 'Matches keeps occurrences centered on the shared reading position and shows their surrounding corpus context.',
  vocabulary: 'Vocabulary ranks words in the active corpus; its visible filters remain beside the table.',
  compare: 'Compare ranks words that distinguish two selected sides. Ranking controls will appear here.',
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
  return <p className="settings-method-summary">{METHOD_SUMMARY[context]}</p>;
}
