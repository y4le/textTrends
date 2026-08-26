import type { SettingsContext } from '../../lib/settings-entry.ts';
import { TrendSettings } from '../TrendSettings.tsx';
import { CompareSettingsSection } from './CompareSettingsSection.tsx';

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
  return null;
}
