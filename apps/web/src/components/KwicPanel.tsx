/**
 * KWIC concordance — the merged evidence layer for ALL enabled terms, ordered
 * by proximity to the current axis position (the served `center`), or reading
 * order when no position is set. Each occurrence's node is drawn in its own
 * series colour; per-term toggle chips (accessible, `aria-pressed`, not colour
 * alone) add or remove a term from the merge without touching the chart's
 * focused series. The table IS the visualization.
 */

import { useApp } from '../lib/store-instance.ts';
import type { KwicRowView } from '../lib/store.ts';
import { slotColor } from '../lib/series-style.ts';
import { SeriesLineSample } from './chrome.tsx';

/** One display line per occurrence: the source text's own line breaks (and
 *  any whitespace runs) collapse to single spaces before the fixed-width
 *  slice — presentation only, the underlying text is untouched. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ');

export function KwicPanel() {
  const kwic = useApp((s) => s.kwic);
  const project = useApp((s) => s.projectSession?.project ?? null);
  const series = useApp((s) => s.series);
  const enabled = useApp((s) => s.kwicEnabledSeries);
  const toggle = useApp((s) => s.toggleKwicSeries);

  if (series.length === 0) return null;
  // Map lookups, built once per render — the table does up to 50 rows × 5
  // cells of these (matching TrendPanel's titleByDoc pattern).
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const slotOf = (id: string) => seriesById.get(id)?.styleSlot ?? 0;
  const labelOf = (id: string) => seriesById.get(id)?.label ?? id;
  // Presentation titles come from document metadata — doc ids are opaque
  // identity (user projects use UUIDs).
  const titleByDoc = new Map((project?.data.docs ?? []).map((d) => [d.doc, d.meta.title]));
  const titleOf = (doc: string) => titleByDoc.get(doc) ?? doc;

  const table = (total: number, rows: readonly KwicRowView[]) => (
    <table
      aria-label="Concordance"
      style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', borderCollapse: 'collapse', whiteSpace: 'pre' }}
    >
      <caption style={{ textAlign: 'left', color: 'var(--fg-muted)', paddingBottom: 'var(--space-1)' }}>
        Concordance ({caption}): {rows.length} of {total.toLocaleString()} occurrences
      </caption>
      <thead>
        <tr style={{ color: 'var(--fg-muted)' }}>
          <th scope="col" style={{ textAlign: 'left', fontWeight: 400 }}>term</th>
          <th scope="col" style={{ textAlign: 'right', fontWeight: 400 }}>book</th>
          <th scope="col" style={{ textAlign: 'right', fontWeight: 400 }}>left context</th>
          <th scope="col" style={{ fontWeight: 400 }}>node</th>
          <th scope="col" style={{ textAlign: 'left', fontWeight: 400 }}>right context</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.seriesId}:${r.doc}:${r.pos}`} style={{ borderTop: '1px solid var(--rule)' }}>
            <td style={{ color: slotColor(slotOf(r.seriesId)), paddingRight: '1ch', whiteSpace: 'nowrap' }}>{labelOf(r.seriesId)}</td>
            <td style={{ color: 'var(--fg-muted)', paddingRight: '1ch', textAlign: 'right' }}>{titleOf(r.doc).slice(0, 12)}</td>
            <td style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>{oneLine(r.left).slice(-38)}</td>
            <td style={{ color: slotColor(slotOf(r.seriesId)), padding: '0 1ch', fontWeight: 600 }}>{oneLine(r.nodeText)}</td>
            <td style={{ color: 'var(--fg-muted)' }}>{oneLine(r.right).slice(0, 38)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  // Every pending load: reserve a few rows of height so the result lands into
  // space that already exists rather than pushing the page.
  const skeleton = (
    <div aria-hidden="true" style={{ opacity: 0.4 }}>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          style={{ height: '1.35em', margin: '0.35em 0', background: 'var(--rule)', maxWidth: `${70 - i * 4}%` }}
        />
      ))}
    </div>
  );

  // Per-term toggle chips: every series, on/off, independent of chart focus.
  const chips = (
    <div role="group" aria-label="Concordance terms" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
      <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>terms:</span>
      {series.map((s) => {
        const on = enabled.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.id)}
            aria-pressed={on}
            title={on ? `hide “${s.label}” from the concordance` : `show “${s.label}” in the concordance`}
            style={{
              font: 'inherit',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: on ? 'var(--fg)' : 'var(--fg-muted)',
              background: 'none',
              border: '1px solid',
              borderColor: on ? 'var(--rule-strong)' : 'var(--rule)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.75ch',
              padding: '1px 0.75ch',
              opacity: on ? 1 : 0.6,
            }}
          >
            <SeriesLineSample slot={s.styleSlot} emphasized={on} />
            {on ? '✓ ' : ''}{s.label}
          </button>
        );
      })}
    </div>
  );

  const caption =
    kwic?.center != null
      ? `nearest to ${titleOf(kwic.center.doc)} · token ${(kwic.center.token + 1).toLocaleString()}`
      : 'reading order';

  const status = kwic?.state.status ?? 'pending';
  let body: React.ReactNode = null;
  if (status === 'no-terms') {
    body = <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>No concordance terms enabled.</p>;
  } else if (status === 'error') {
    const message = kwic?.state.status === 'error' ? kwic.state.message : 'unknown error';
    body = <p style={{ color: 'var(--accent-text)', fontSize: 'var(--text-sm)' }}>concordance failed: {message}</p>;
  } else if (status === 'pending') {
    // EVIDENCE DISCIPLINE (pass-2 ruling): the panel renders ONLY rows the
    // current store state owns. A component-local "last table" cache showed
    // center-A rows under a center-B caption during reloads — the skeleton
    // reserves height instead, so the page still never shoves.
    body = skeleton;
  } else if (kwic?.state.status === 'ready' && kwic.state.rows.length === 0) {
    body = <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>No occurrences of the enabled terms.</p>;
  } else if (kwic?.state.status === 'ready') {
    body = table(kwic.state.total, kwic.state.rows);
  }

  return (
    <section style={{ marginTop: 'var(--space-3)' }}>
      {chips}
      {body}
    </section>
  );
}
