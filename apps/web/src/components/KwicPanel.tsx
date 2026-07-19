/**
 * KWIC concordance — the evidence layer. Fixed-width aligned contexts, the
 * node in an AA-contrast accent. The table IS the visualization; semantics
 * (caption, headers) are part of the evidence, not decoration.
 */

import { useApp } from '../lib/store-instance.ts';

export function KwicPanel() {
  const kwic = useApp((s) => s.kwic);
  const term = useApp((s) => s.term);
  if (!kwic || kwic.rows.length === 0) return null;

  return (
    <section style={{ marginTop: 'var(--space-3)' }}>
      <table
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          borderCollapse: 'collapse',
          whiteSpace: 'pre',
        }}
      >
        <caption
          style={{
            textAlign: 'left',
            color: 'var(--fg-muted)',
            paddingBottom: 'var(--space-1)',
          }}
        >
          Concordance: first {kwic.rows.length} of {kwic.total} occurrences of “{term}”
        </caption>
        <thead>
          <tr style={{ color: 'var(--fg-muted)' }}>
            <th scope="col" style={{ textAlign: 'right', fontWeight: 400 }}>book</th>
            <th scope="col" style={{ textAlign: 'right', fontWeight: 400 }}>left context</th>
            <th scope="col" style={{ fontWeight: 400 }}>node</th>
            <th scope="col" style={{ textAlign: 'left', fontWeight: 400 }}>right context</th>
          </tr>
        </thead>
        <tbody>
          {kwic.rows.map((r) => (
            <tr key={`${r.doc}:${r.pos}`} style={{ borderTop: '1px solid var(--rule)' }}>
              <td style={{ color: 'var(--fg-muted)', paddingRight: '1ch', textAlign: 'right' }}>
                {r.doc.replace(/ -.*$/, '').slice(0, 12)}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>{r.left.slice(-38)}</td>
              <td style={{ color: 'var(--accent-text)', padding: '0 1ch' }}>{r.nodeText}</td>
              <td style={{ color: 'var(--fg-muted)' }}>{r.right.slice(0, 38)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
