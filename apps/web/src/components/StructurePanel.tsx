/**
 * Chapter structure preview (commit 8a — READ ONLY). Shows the focused
 * document's detected outline with per-row detection provenance, a durable
 * encoding badge, and a toggle to mark the top-level chapter boundaries on the
 * chart. Correction controls (editing the outline into a declarative override)
 * are commit 8c; this panel only reads the structure query and the durable
 * source descriptor.
 *
 * The outline is rendered in the canonical order the query already returns
 * (root first, then depth-first by character start); depth is derived from the
 * PARENT chain, never the `level` metadata field.
 */

import { useEffect, useState } from 'react';
import { useApp } from '../lib/store-instance.ts';
import { provenanceLabel, type StructureRow } from '../lib/structure-view.ts';
import { StructureEditor } from './StructureEditor.tsx';

/** Ancestor depth of each row via the parent chain (root = 0). */
function depthByRow(rows: readonly StructureRow[]): Map<string, number> {
  const parent = new Map<string, string | undefined>();
  for (const r of rows) parent.set(r.section.id, r.section.parent);
  const depth = new Map<string, number>();
  const resolve = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const p = parent.get(id);
    const d = p === undefined || !parent.has(p) ? 0 : resolve(p) + 1;
    depth.set(id, d);
    return d;
  };
  for (const r of rows) resolve(r.section.id);
  return depth;
}

export function StructurePanel() {
  const project = useApp((s) => s.projectSession?.project ?? null);
  const snapshot = useApp((s) => s.snapshot);
  const focusedDoc = useApp((s) => s.focusedDoc);
  const structure = useApp((s) => s.structure);
  const sectionMarks = useApp((s) => s.sectionMarks);
  const sourceEvidence = useApp((s) => s.projectSession?.sourceEvidence ?? null);
  const setFocusedDoc = useApp((s) => s.setFocusedDoc);
  const setSectionMarks = useApp((s) => s.setSectionMarks);
  const setStructureOverride = useApp((s) => s.setStructureOverride);

  const [editing, setEditing] = useState(false);
  // A doc switch closes the editor — its draft belonged to the previous doc.
  useEffect(() => {
    setEditing(false);
  }, [focusedDoc]);

  if (!project || !snapshot || !focusedDoc) return null;

  const ready = new Set(snapshot.readyDocs);
  const readyInOrder = project.data.order.filter((d) => ready.has(d));
  if (readyInOrder.length === 0) return null;
  const titleOf = (doc: string): string =>
    project.data.docs.find((d) => d.doc === doc)?.meta.title ?? doc;

  const doc = project.data.docs.find((d) => d.doc === focusedDoc) ?? null;
  // Text and markup (html) sources carry a single decoded encoding; a container
  // (epub) reports no encoding badge (its documents are decoded internally).
  const encoding =
    doc && (doc.source.kind === 'text' || doc.source.kind === 'markup') ? doc.source.encoding : null;
  const evidence = sourceEvidence?.[focusedDoc] ?? null;
  const overrideStatus = doc?.structure.override.status ?? 'none';
  const isUser = project.kind === 'user';

  // The result is only meaningful when it echoes the currently-focused doc.
  const st = structure && structure.doc === focusedDoc ? structure.state : null;
  const rows = st?.status === 'ready' ? st.result.rows : [];
  const depth = depthByRow(rows);
  const chapters = rows.filter((r) => r.section.origin !== 'fixed');

  return (
    <section
      aria-label="Chapter structure"
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-2)',
        border: '1px solid var(--rule)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>chapters</strong>
        <label style={{ color: 'var(--fg-muted)' }}>
          document{' '}
          <select
            aria-label="Document to preview"
            value={focusedDoc}
            onChange={(e) => setFocusedDoc(e.target.value)}
            style={{ font: 'inherit', fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule-strong)' }}
          >
            {readyInOrder.map((d) => (
              <option key={d} value={d}>{titleOf(d)}</option>
            ))}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <label style={{ cursor: 'pointer', color: 'var(--fg-muted)', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={sectionMarks}
            onChange={(e) => setSectionMarks(e.target.checked)}
            aria-label="Mark top-level chapters on the chart"
          />{' '}
          mark chapters on chart
        </label>
        {isUser && !editing && overrideStatus !== 'needs-review' && (
          <button type="button" onClick={() => setEditing(true)} style={editBtn}>
            edit chapters
          </button>
        )}
      </div>

      {encoding && (
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }} role="note">
          encoding:{' '}
          {encoding.detected === 'windows-1252' ? (
            <span style={{ color: 'var(--accent-text)' }}>Windows-1252 (inferred — no BOM/UTF-8)</span>
          ) : (
            <span>{encoding.detected}</span>
          )}
          {encoding.hadReplacementChars && <span> · contains replacement characters</span>}
          {evidence
            ? <span> · this session: {evidence.decoderReplacementCount} replaced, {evidence.suspiciousControlCount} control chars</span>
            : <span> · exact counts unavailable (warm reopen)</span>}
        </p>
      )}

      {overrideStatus === 'active' && !editing && (
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--fg-muted)' }}>your chapter correction is applied.</p>
      )}
      {overrideStatus === 'needs-review' && (
        <p role="alert" style={{ margin: 'var(--space-1) 0 0', color: 'var(--accent-text)' }}>
          a saved chapter correction is INACTIVE — the source was re-extracted and the correction no longer matches.{' '}
          {isUser && (
            <button type="button" onClick={() => setStructureOverride(focusedDoc, null)} style={editBtn}>
              discard stale correction and start from current detection
            </button>
          )}
        </p>
      )}

      {editing && <StructureEditor doc={focusedDoc} onClose={() => setEditing(false)} />}

      {st?.status === 'pending' && (
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--fg-muted)' }}>reading structure…</p>
      )}
      {st?.status === 'error' && (
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--accent-text)' }}>structure unavailable: {st.message}</p>
      )}
      {!editing && st?.status === 'ready' && chapters.length === 0 && (
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--fg-muted)' }}>
          no chapters detected — the whole document is one section
        </p>
      )}
      {!editing && st?.status === 'ready' && chapters.length > 0 && (
        <ol aria-label="Detected chapters" style={{ listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'grid', gap: '2px' }}>
          {rows.map((r) => {
            if (r.section.origin === 'fixed') return null; // the whole-document root
            const d = depth.get(r.section.id) ?? 1;
            return (
              <li key={r.section.id} style={{ display: 'flex', gap: 'var(--space-2)', paddingLeft: `${(d - 1) * 2}ch`, alignItems: 'baseline' }}>
                <span style={{ minWidth: '28ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.section.title ?? '(untitled)'}
                </span>
                <span style={{ color: r.section.origin === 'user' ? 'var(--fg)' : 'var(--fg-muted)' }}>
                  {provenanceLabel(r.section.origin)}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  chars {r.section.chars.start.toLocaleString()}–{r.section.chars.end.toLocaleString()}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const editBtn: React.CSSProperties = {
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule-strong)',
  cursor: 'pointer',
  padding: '1px 0.75ch',
};
