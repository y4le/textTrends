/**
 * KWIC concordance — the evidence layer for ONE focused series at a time
 * (the chart asks a comparative question; the concordance is close reading
 * of one selected signal — an interleaved multi-term merge of independently
 * paged queries would not be the true global ordering). Fixed-width aligned
 * contexts, the node in an AA-contrast accent. The table IS the
 * visualization; semantics (caption, headers) are part of the evidence.
 */

import { useApp } from '../lib/store-instance.ts';

/** One display line per occurrence: the source text's own line breaks (and
 *  any whitespace runs) collapse to single spaces before the fixed-width
 *  slice — presentation only, the underlying text is untouched. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ');

export function KwicPanel() {
  const kwic = useApp((s) => s.kwic);
  const series = useApp((s) => s.series);
  if (!kwic) return null;
  const label = series.find((s) => s.id === kwic.seriesId)?.label ?? kwic.seriesId;

  if (kwic.state.status === 'pending') return null;
  if (kwic.state.status === 'error') {
    return (
      <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>
        concordance for “{label}” failed: {kwic.state.message}
      </p>
    );
  }
  const { total, rows } = kwic.state;
  if (rows.length === 0) {
    return (
      <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-3)' }}>
        No occurrences of “{label}”.
      </p>
    );
  }

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
          Concordance: first {rows.length} of {total} occurrences of “{label}”
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
          {rows.map((r) => (
            <tr key={`${r.doc}:${r.pos}`} style={{ borderTop: '1px solid var(--rule)' }}>
              <td style={{ color: 'var(--fg-muted)', paddingRight: '1ch', textAlign: 'right' }}>
                {r.doc.replace(/ -.*$/, '').slice(0, 12)}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>{oneLine(r.left).slice(-38)}</td>
              <td style={{ color: 'var(--accent-text)', padding: '0 1ch' }}>{oneLine(r.nodeText)}</td>
              <td style={{ color: 'var(--fg-muted)' }}>{oneLine(r.right).slice(0, 38)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
