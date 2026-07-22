/**
 * Chapter-correction editor (commit 8c). Keeps a LOCAL draft outline; the user
 * edits titles, boundaries, parents, adds/removes chapters, and issues ONE
 * explicit Apply — never a generation reopen per keystroke. Apply diffs the
 * draft against the detected baseline (core `overrideFromEditedOutline`, which
 * validates + proves the result) and hands the resulting declarative override
 * to the fenced async session command. A stale saved correction (needs-review)
 * cannot be re-applied; it is discarded to start from current detection.
 *
 * The override targets LINEAGE keys. The edit-context's current rows carry both
 * their own lineage key and their bound SectionId, so a parent's lineage key is
 * reconstructed here from the bound-id → key map — no protocol change needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { overrideFromEditedOutline, ROOT_KEY, type EditableSectionValue, type StructureSectionRecordV2 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { canAddSection, newDraftSection, normalizeLevels } from '../lib/structure-view.ts';
import type { StructureEditContextV1 } from '../worker/protocol-v4.ts';

/** The added-row key allocator — injectable so tests are deterministic;
 *  production mints a fresh uuid per Add (ruling §5, no per-session counter). */
const defaultNewKey = (): string => `user-${crypto.randomUUID()}`;

/** Build the initial editable draft from the current composed outline. */
function draftFromContext(ctx: StructureEditContextV1): EditableSectionValue[] {
  const idToKey = new Map(ctx.current.map((r) => [r.section.id, r.key]));
  return ctx.current.map((r) => {
    const parentKey = r.section.parent === undefined ? undefined : idToKey.get(r.section.parent);
    return {
      key: r.key,
      ...(parentKey === undefined ? {} : { parent: parentKey }),
      level: r.section.level,
      ...(r.section.title === undefined ? {} : { title: r.section.title }),
      chars: { start: r.section.chars.start, end: r.section.chars.end },
    };
  });
}

export function StructureEditor({ doc, onClose, newKey = defaultNewKey }: { doc: string; onClose: () => void; newKey?: () => string }) {
  const editContext = useApp((s) => s.editContext);
  const correction = useApp((s) => s.projectSession?.corrections?.[doc] ?? null);
  const requestEditContext = useApp((s) => s.requestEditContext);
  const setStructureOverride = useApp((s) => s.setStructureOverride);

  const [draft, setDraft] = useState<EditableSectionValue[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Fetch the authoring context once when the editor opens for this doc.
  useEffect(() => {
    requestEditContext(doc);
  }, [doc, requestEditContext]);

  const ctx = editContext && editContext.doc === doc && editContext.state.status === 'ready' ? editContext.state.context : null;
  const ctxError = editContext && editContext.doc === doc && editContext.state.status === 'error' ? editContext.state.message : null;

  // Seed the draft once the context arrives (and re-seed if the doc changes).
  useEffect(() => {
    if (ctx) setDraft(draftFromContext(ctx));
    else setDraft(null);
  }, [ctx]);

  const rows = draft ?? [];
  const nonRoot = rows.filter((r) => r.key !== ROOT_KEY);
  const parentOptions = useMemo(
    () => rows.filter((r) => r.key !== ROOT_KEY).map((r) => ({ key: r.key, label: r.title ?? r.key })),
    [rows],
  );

  const patchRow = (key: string, patch: Partial<EditableSectionValue>) => {
    setApplyError(null);
    setDraft((d) => (d ? d.map((r) => (r.key === key ? { ...r, ...patch } : r)) : d));
  };

  // Title is optional — an empty input REMOVES it (never stores `undefined`,
  // which exactOptionalPropertyTypes forbids and the hash would treat distinctly).
  const setTitle = (key: string, value: string) => {
    setApplyError(null);
    setDraft((d) =>
      d
        ? d.map((r) => {
            if (r.key !== key) return r;
            if (value === '') {
              const { title: _drop, ...rest } = r;
              return rest;
            }
            return { ...r, title: value };
          })
        : d,
    );
  };

  const removeRow = (key: string) => {
    setApplyError(null);
    setDraft((d) => (d ? d.filter((r) => r.key !== key) : d));
  };

  const addRow = () => {
    if (!draft || !canAddSection(draft.length)) return;
    setApplyError(null);
    const rootEnd = draft.find((r) => r.key === ROOT_KEY)?.chars.end ?? 1;
    setDraft([...draft, newDraftSection(newKey(), rootEnd)]);
  };

  const setParent = (key: string, parentKey: string) => {
    // Only the parent changes here; every level is derived from the parent
    // chain at Apply (normalizeLevels), so a moved subtree stays consistent.
    patchRow(key, { parent: parentKey });
  };

  const apply = () => {
    if (!ctx || !draft) return;
    try {
      // EditSectionRow[] is structurally StructureSectionRecordV2[].
      const detected = ctx.detected as readonly StructureSectionRecordV2[];
      const override = overrideFromEditedOutline(ctx.base, detected, normalizeLevels(draft));
      // The session treats an empty change set as `none` (clears the correction).
      setStructureOverride(doc, override);
      onClose();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    }
  };

  const numField = (value: number, onChange: (n: number) => void, label: string) => (
    <input
      type="number"
      aria-label={label}
      value={value}
      min={0}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      style={{ width: '9ch', font: 'inherit', fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule)' }}
    />
  );

  return (
    <div style={{ marginTop: 'var(--space-2)', borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong>editing chapters</strong>
        {correction?.phase === 'hashing' && <span style={{ color: 'var(--fg-muted)' }}>applying…</span>}
        {correction?.phase === 'error' && <span role="alert" style={{ color: 'var(--accent-text)' }}>{correction.message}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={addRow} disabled={!ctx || !canAddSection(rows.length)} style={btn}>add chapter</button>
        {/* Apply stays enabled while a prior correction is still hashing: a newer
            Apply (or discard) intentionally SUPERSEDES the pending one — the
            session's per-doc token fence guarantees only the latest installs. */}
        <button type="button" onClick={apply} disabled={!ctx} style={btn}>apply</button>
        <button type="button" onClick={onClose} style={btn}>cancel</button>
      </div>

      {ctxError && <p role="alert" style={{ color: 'var(--accent-text)' }}>could not open the editor: {ctxError}</p>}
      {applyError && <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0 0' }}>invalid outline: {applyError}</p>}
      {!ctx && !ctxError && <p style={{ color: 'var(--fg-muted)' }}>loading the editable outline…</p>}

      {ctx && (
        <ul aria-label="Editable chapters" style={{ listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'grid', gap: '4px' }}>
          {nonRoot.length === 0 && <li style={{ color: 'var(--fg-muted)' }}>no chapters — add one, or leave the document as a single section</li>}
          {nonRoot.map((r) => (
            <li key={r.key} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <input
                aria-label={`Title for ${r.key}`}
                value={r.title ?? ''}
                placeholder="(untitled)"
                onChange={(e) => setTitle(r.key, e.target.value)}
                style={{ width: '22ch', font: 'inherit', fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule)' }}
              />
              <label style={{ color: 'var(--fg-muted)' }}>chars {numField(r.chars.start, (n) => patchRow(r.key, { chars: { ...r.chars, start: n } }), `Start char for ${r.key}`)}–{numField(r.chars.end, (n) => patchRow(r.key, { chars: { ...r.chars, end: n } }), `End char for ${r.key}`)}</label>
              <label style={{ color: 'var(--fg-muted)' }}>
                under{' '}
                <select
                  aria-label={`Parent for ${r.key}`}
                  value={r.parent ?? ROOT_KEY}
                  onChange={(e) => setParent(r.key, e.target.value)}
                  style={{ font: 'inherit', fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule)' }}
                >
                  <option value={ROOT_KEY}>— top level</option>
                  {parentOptions.filter((o) => o.key !== r.key).map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => removeRow(r.key)} style={btn}>remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--fg)',
  background: 'none',
  border: '1px solid var(--rule-strong)',
  cursor: 'pointer',
  padding: '1px 0.75ch',
};
