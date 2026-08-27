import type { SettingsContext } from '../../lib/settings-entry.ts';
import { TrendSettings } from '../TrendSettings.tsx';
import { CompareSettingsSection } from './CompareSettingsSection.tsx';
import { VocabularySettings } from './VocabularySettings.tsx';

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
  if (context === 'vocabulary') return <VocabularySettings />;
  return null;
}
