import type { InventoryGrowthV1 } from '../../shared/analysis-contract.ts';

const number = new Intl.NumberFormat('en-US');

export function GrowthCurve({ growth }: { readonly growth: InventoryGrowthV1 }) {
  const width = 560;
  const height = 120;
  const maxTokens = growth.tokens.at(-1) ?? 0;
  const maxTypes = growth.types.at(-1) ?? 0;
  const points = Array.from(growth.tokens, (tokens, index) => {
    const x = maxTokens === 0 ? 0 : tokens / maxTokens * width;
    const y = maxTypes === 0
      ? height
      : height - (growth.types[index] as number) / maxTypes * height;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Vocabulary growth to ${number.format(maxTypes)} types over ${number.format(maxTokens)} selected tokens`}
        style={{ width: '100%', maxWidth: width, height, display: 'block', borderLeft: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' }}
      >
        <polyline points={points} fill="none" stroke="var(--accent-text)" strokeWidth="1.5" />
      </svg>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
          exact growth values
        </summary>
        <table>
          <thead><tr><th scope="col">selected tokens</th><th scope="col">types seen</th></tr></thead>
          <tbody>
            {Array.from(growth.tokens, (tokens, index) => (
              <tr key={`${tokens}:${index}`}>
                <td className="selectable-stat">{number.format(tokens)}</td>
                <td className="selectable-stat">{number.format(growth.types[index] as number)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
