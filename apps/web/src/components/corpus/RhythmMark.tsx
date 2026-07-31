import type { InventoryRhythmV1 } from '../../shared/analysis-contract.ts';
import {
  rhythmBinsForDocument,
  rhythmDescription,
} from '../../lib/corpus-dashboard-view.ts';

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const value = (input: number | null) =>
  input === null || !Number.isFinite(input) ? '—' : decimal.format(input);

export function RhythmMark({
  rhythm,
  docOrdinal,
}: {
  readonly rhythm: InventoryRhythmV1 | null;
  readonly docOrdinal: number;
}) {
  if (!rhythm) return <>—</>;
  const bins = rhythmBinsForDocument(rhythm, docOrdinal);
  const max = Math.max(
    1,
    ...bins.map((bin) => Number.isFinite(bin.mean) ? bin.mean : 0),
  );
  return (
    <span
      role="img"
      aria-label={rhythmDescription(bins, value)}
      style={{ display: 'inline-flex', gap: 1, height: 22, alignItems: 'end' }}
    >
      {bins.map((bin, index) => (
        <span
          key={index}
          title={`bin ${index + 1}: mean ${value(bin.mean)} tokens`}
          style={{
            display: 'inline-block',
            width: 3,
            height: Number.isFinite(bin.mean) ? Math.max(1, bin.mean / max * 22) : 1,
            background: bin.tokens === 0 ? 'var(--rule)' : 'var(--accent-text)',
            opacity: bin.tokens === 0 ? 0.4 : 0.75,
          }}
        />
      ))}
    </span>
  );
}
