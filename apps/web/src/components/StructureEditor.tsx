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

import { SMALL_BUTTON_STYLE } from './chrome.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { overrideFromEditedOutline, ROOT_KEY, type EditableSectionValue, type StructureSectionRecordV2 } from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import { canAddSection, newDraftSection, normalizeLevels } from '../lib/structure-view.ts';
import type { StructureEditContextV1 } from '../shared/analysis-contract.ts';

/** The added-row key allocator — injectable so tests are deterministic;
 *  production mints a fresh uuid per Add (ruling §5, no per-session counter). */
const defaultNewKey = (): string => `user-${crypto.randomUUID()}`;

export type StructureEditorDraft = readonly EditableSectionValue[];

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

export function StructureEditor({
  doc,
  onClose,
  onCancel = onClose,
  newKey = defaultNewKey,
  initialDraft,
  onDraftChange,
}: {
  readonly doc: string;
  readonly onClose: () => void;
  readonly onCancel?: () => void;
  readonly newKey?: () => string;
  readonly initialDraft?: StructureEditorDraft;
  readonly onDraftChange?: (draft: StructureEditorDraft) => void;
}) {
  const editContext = useApp((s) => s.editContext);
  const correction = useApp((s) => s.projectSession?.corrections?.[doc] ?? null);
  const requestEditContext = useApp((s) => s.requestEditContext);
  const setStructureOverride = useApp((s) => s.setStructureOverride);

  const [draft, setDraft] = useState<EditableSectionValue[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const draftRef = useRef<EditableSectionValue[] | null>(null);
  const initialDraftRef = useRef(initialDraft);
  const onDraftChangeRef = useRef(onDraftChange);
  initialDraftRef.current = initialDraft;
  onDraftChangeRef.current = onDraftChange;

  // Fetch the authoring context once per snapshot/doc. Presentation changes
  // can remount this editor (compact portal ↔ in-flow) and must not reissue
  // analysis; snapshot publication clears stale contexts in the store.
  useEffect(() => {
    if (editContext?.doc !== doc) requestEditContext(doc);
  }, [doc, editContext?.doc, requestEditContext]);

  const ctx = editContext && editContext.doc === doc && editContext.state.status === 'ready' ? editContext.state.context : null;
  const ctxError = editContext && editContext.doc === doc && editContext.state.status === 'error' ? editContext.state.message : null;

  // Seed the draft once the context arrives (and re-seed if the doc changes).
  useEffect(() => {
    if (ctx) {
      const seeded = initialDraftRef.current
        ? initialDraftRef.current.map((row) => ({
            ...row,
            chars: { ...row.chars },
          }))
        : draftFromContext(ctx);
      draftRef.current = seeded;
      setDraft(seeded);
      onDraftChangeRef.current?.(seeded);
    } else {
      draftRef.current = null;
      setDraft(null);
    }
  }, [ctx]);

  const rows = draft ?? [];
  const nonRoot = rows.filter((r) => r.key !== ROOT_KEY);
  const parentOptions = useMemo(
    () => rows.filter((r) => r.key !== ROOT_KEY).map((r) => ({ key: r.key, label: r.title ?? r.key })),
    [rows],
  );

  const updateDraft = (
    transform: (current: EditableSectionValue[]) => EditableSectionValue[],
  ) => {
    const current = draftRef.current;
    if (!current) return;
    const next = transform(current);
    draftRef.current = next;
    setDraft(next);
    onDraftChange?.(next);
  };

  const patchRow = (key: string, patch: Partial<EditableSectionValue>) => {
    setApplyError(null);
    updateDraft((current) =>
      current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  // Title is optional — an empty input REMOVES it (never stores `undefined`,
  // which exactOptionalPropertyTypes forbids and the hash would treat distinctly).
  const setTitle = (key: string, value: string) => {
    setApplyError(null);
    updateDraft((current) =>
      current.map((r) => {
        if (r.key !== key) return r;
        if (value === '') {
          const { title: _drop, ...rest } = r;
          return rest;
        }
        return { ...r, title: value };
      }),
    );
  };

  const removeRow = (key: string) => {
    setApplyError(null);
    updateDraft((current) => current.filter((r) => r.key !== key));
  };

  const addRow = () => {
    const current = draftRef.current;
    if (!current || !canAddSection(current.length)) return;
    setApplyError(null);
    const rootEnd = current.find((r) => r.key === ROOT_KEY)?.chars.end ?? 1;
    updateDraft((latest) => [...latest, newDraftSection(newKey(), rootEnd)]);
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
      className="exact-input"
      type="number"
      aria-label={label}
      value={value}
      min={0}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      style={{ width: '9ch', font: 'inherit', fontFamily: 'var(--font-mono)', background: 'transparent', color: 'var(--fg)', border: '1px solid var(--rule)' }}
    />
  );

  return (
    <div className="structure-editor" style={{ marginTop: 'var(--space-2)', borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-2)' }}>
      <div className="structure-editor-heading" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong>editing chapters</strong>
        {correction?.phase === 'hashing' && <span style={{ color: 'var(--fg-muted)' }}>applying…</span>}
        {correction?.phase === 'error' && <span role="alert" style={{ color: 'var(--accent-text)' }}>{correction.message}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={addRow} disabled={!ctx || !canAddSection(rows.length)} style={SMALL_BUTTON_STYLE}>add chapter</button>
      </div>

      {ctxError && (
        <p role="alert" style={{ color: 'var(--accent-text)' }}>
          could not open the editor: {ctxError}{' '}
          <button type="button" onClick={() => requestEditContext(doc)} style={SMALL_BUTTON_STYLE}>
            retry
          </button>
        </p>
      )}
      {applyError && <p role="alert" style={{ color: 'var(--accent-text)', margin: 'var(--space-1) 0 0' }}>invalid outline: {applyError}</p>}
      {!ctx && !ctxError && <p style={{ color: 'var(--fg-muted)' }}>loading the editable outline…</p>}

      {ctx && (
        <ul aria-label="Editable chapters" style={{ listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'grid', gap: '4px' }}>
          {nonRoot.length === 0 && <li style={{ color: 'var(--fg-muted)' }}>no chapters — add one, or leave the document as a single section</li>}
          {nonRoot.map((r) => (
            <li key={r.key} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <input
                className="exact-input structure-title-input"
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
                  className="exact-input"
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
              <button type="button" onClick={() => removeRow(r.key)} style={SMALL_BUTTON_STYLE}>remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-layer-actions structure-editor-actions">
        <button type="button" onClick={onCancel} style={SMALL_BUTTON_STYLE}>cancel</button>
        {/* Apply stays enabled while a prior correction is still hashing: a newer
            Apply (or discard) intentionally SUPERSEDES the pending one — the
            session's per-doc token fence guarantees only the latest installs. */}
        <button type="button" onClick={apply} disabled={!ctx || !draft} style={SMALL_BUTTON_STYLE}>apply</button>
      </div>
    </div>
  );
}
