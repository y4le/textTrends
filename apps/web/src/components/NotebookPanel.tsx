import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  SERIES_COLOR_IDS,
  SERIES_LINE_IDS,
  type NotebookGroupV1,
  type SeriesColorId,
  type SeriesLineId,
  type SeriesStyleV1,
} from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import {
  aliasesForTermEditor,
  firstFreeStyle,
  groupTitle,
  styleSlotOf,
  termAliasesForSave,
} from '../lib/notebook.ts';
import type { GroupCountVM, NotebookRowVM } from '../lib/notebook-view.ts';
import { SeriesLineSample } from './chrome.tsx';

function CountCell({ count }: { readonly count: GroupCountVM }) {
  switch (count.kind) {
    case 'not-run': return <span>not run</span>;
    case 'pending': return <span>counting…</span>;
    case 'error': return <span title={count.message}>error</span>;
    case 'selected': return count.selected.kind === 'ready'
      ? <span>{count.selected.total} selected / {count.total}</span>
      : <span>{count.selected.kind} selected / {count.total}</span>;
    case 'ready': return <span>{count.total}{count.partial ? ' partial' : ''}</span>;
  }
}

const COLOR_LABELS: Record<SeriesColorId, string> = {
  blue: 'Blue',
  orange: 'Orange',
  green: 'Green',
  violet: 'Violet',
  gold: 'Gold',
};

const LINE_LABELS: Record<SeriesLineId, string> = {
  solid: 'Solid',
  dash: 'Dashed',
  dot: 'Dotted',
  'dash-dot': 'Dash dot',
  'fine-dot': 'Fine dots',
};

interface TermDraft {
  readonly aliases: string;
  readonly exactMatch: boolean;
  readonly countOverlaps: boolean;
  readonly style: SeriesStyleV1;
}

interface TermDropTarget {
  readonly id: string;
  readonly after: boolean;
}

function draftOf(group: NotebookGroupV1): TermDraft {
  return {
    aliases: aliasesForTermEditor(group).join(', '),
    exactMatch: group.exactMatch,
    countOverlaps: group.countOverlaps,
    style: group.style,
  };
}

function aliasesOf(input: string): string[] {
  return input.split(',').map((alias) => alias.trim()).filter(Boolean);
}

function StylePicker({
  name,
  style,
  onChange,
}: {
  readonly name: string;
  readonly style: SeriesStyleV1;
  readonly onChange: (style: SeriesStyleV1) => void;
}) {
  return (
    <div className="term-style-picker">
      <fieldset>
        <legend>Color</legend>
        <div className="term-style-options term-color-options">
          {SERIES_COLOR_IDS.map((color) => {
            const selected = style.color === color;
            return (
              <label key={color} data-selected={selected || undefined}>
                <input
                  type="radio"
                  name={`${name}-color`}
                  value={color}
                  checked={selected}
                  onChange={() => onChange({ ...style, color })}
                />
                <span
                  className="term-color-swatch"
                  style={{ color: `var(--series-${SERIES_COLOR_IDS.indexOf(color) + 1})` }}
                  aria-hidden="true"
                />
                {COLOR_LABELS[color]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Line</legend>
        <div className="term-style-options term-line-options">
          {SERIES_LINE_IDS.map((line) => {
            const selected = style.line === line;
            const candidate = { ...style, line };
            return (
              <label key={line} data-selected={selected || undefined}>
                <input
                  type="radio"
                  name={`${name}-line`}
                  value={line}
                  checked={selected}
                  onChange={() => onChange(candidate)}
                />
                <SeriesLineSample slot={styleSlotOf(candidate)} emphasized />
                {LINE_LABELS[line]}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

function TermEditor({
  group,
  initialStyle,
  onSaved,
  onCancel,
}: {
  readonly group: NotebookGroupV1 | null;
  readonly initialStyle: SeriesStyleV1;
  readonly onSaved: (groupId: string) => void;
  readonly onCancel: () => void;
}) {
  const addTerm = useApp((state) => state.addTerm);
  const saveTerm = useApp((state) => state.saveTerm);
  const clearNotebookError = useApp((state) => state.clearNotebookError);
  const notebookError = useApp((state) => state.notebookError);
  const groups = useApp((state) => state.notebook.groups);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [aliasesTouched, setAliasesTouched] = useState(false);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<TermDraft>(() => group
    ? draftOf(group)
    : {
        aliases: '',
        exactMatch: false,
        countOverlaps: false,
        style: initialStyle,
      });
  const label = group ? groupTitle(group) : 'new term';

  useEffect(() => {
    clearNotebookError();
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [clearNotebookError, group?.id]);

  const save = () => {
    clearNotebookError();
    setEditorNotice(null);
    const aliases = aliasesOf(draft.aliases);
    if (group) {
      if (!saveTerm(group.id, {
        ...draft,
        ...termAliasesForSave(group, aliases, aliasesTouched),
      })) return;
      onSaved(group.id);
      return;
    }
    const groupId = addTerm({ ...draft, aliases });
    if (groupId === null) return;
    const duplicate = groups.find((candidate) => candidate.id === groupId);
    if (duplicate) {
      setEditorNotice(`${groupTitle(duplicate)} is already in Terms.`);
      return;
    }
    onSaved(groupId);
  };

  return (
    <form
      className="term-inline-editor"
      aria-label={`Edit term: ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="term-alias-field">
        <span>Term and aliases</span>
        <input
          ref={inputRef}
          id={`term-aliases-${group?.id ?? 'new'}`}
          className="exact-input"
          value={draft.aliases}
          onChange={(event) => {
            setAliasesTouched(true);
            setEditorNotice(null);
            setDraft({ ...draft, aliases: event.currentTarget.value });
          }}
          aria-label={`Term and aliases for ${label}`}
          aria-describedby={`term-help-${group?.id ?? 'new'}`}
          placeholder="NYC, NY, New York, New Yo*"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <p className="term-editor-help" id={`term-help-${group?.id ?? 'new'}`}>
        Separate aliases with commas. The first alias is the term name. Spaces make phrases;
        put one * at the start or end for a wildcard.
      </p>
      <div className="term-match-options">
        <label>
          <input
            type="checkbox"
            checked={draft.exactMatch}
            onChange={(event) => setDraft({ ...draft, exactMatch: event.currentTarget.checked })}
          />
          Exact match
        </label>
        <span>Case and accents are ignored unless exact match is on.</span>
        <label>
          <input
            type="checkbox"
            checked={draft.countOverlaps}
            onChange={(event) => setDraft({ ...draft, countOverlaps: event.currentTarget.checked })}
          />
          Count overlapping matches
        </label>
      </div>
      <StylePicker
        name={group?.id ?? 'new-term'}
        style={draft.style}
        onChange={(style) => setDraft({ ...draft, style })}
      />
      {notebookError && (
        <p className="term-manager-error" role="alert">{notebookError}</p>
      )}
      {editorNotice && <p className="term-manager-notice" role="status">{editorNotice}</p>}
      <div className="term-editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit">{group ? 'Save term' : 'Add term'}</button>
      </div>
    </form>
  );
}

export function NotebookPanel({
  rows,
  initialGroupId,
  createOnOpen,
  onDone,
}: {
  readonly rows: readonly NotebookRowVM[];
  readonly initialGroupId?: string;
  readonly createOnOpen?: boolean;
  readonly onDone: () => void;
}) {
  const notebook = useApp((state) => state.notebook);
  const activeGroupIds = useApp((state) => state.activeGroupIds);
  const removeGroup = useApp((state) => state.removeGroup);
  const reorderGroups = useApp((state) => state.reorderGroups);
  const setGroupActive = useApp((state) => state.setGroupActive);
  const clearNotebookError = useApp((state) => state.clearNotebookError);
  const notebookError = useApp((state) => state.notebookError);
  const removedGroups = useApp((state) => state.removedGroups);
  const undoRemoveGroup = useApp((state) => state.undoRemoveGroup);
  const dismissRemovedGroup = useApp((state) => state.dismissRemovedGroup);
  const [editingId, setEditingId] = useState<string | 'new' | null>(
    createOnOpen ? 'new' : initialGroupId ?? null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TermDropTarget | null>(null);
  const [keyboardGrabbedId, setKeyboardGrabbedId] = useState<string | null>(null);
  const [reorderStatus, setReorderStatus] = useState('');
  const pointerDragRef = useRef<{
    readonly id: string;
    readonly pointerId: number;
    target: TermDropTarget | null;
  } | null>(null);
  const newStyle = useMemo(
    () => firstFreeStyle(notebook.groups, activeGroupIds),
    [activeGroupIds, notebook.groups],
  );
  const order = notebook.groups.map((group) => group.id);

  const move = (id: string, delta: -1 | 1) => {
    const from = order.indexOf(id);
    const to = from + delta;
    const group = notebook.groups.find((candidate) => candidate.id === id);
    if (from < 0 || !group) return;
    if (to < 0 || to >= order.length) {
      setReorderStatus(`${groupTitle(group)} is already ${delta === -1 ? 'first' : 'last'}.`);
      return;
    }
    const next = [...order];
    [next[from], next[to]] = [next[to]!, next[from]!];
    reorderGroups(next);
    setReorderStatus(`${groupTitle(group)} moved to position ${to + 1} of ${order.length}`);
    requestAnimationFrame(() => document.getElementById(`term-drag-${id}`)?.focus());
  };

  const place = (dragged: string, overId: string, after: boolean) => {
    if (!dragged || dragged === overId) return;
    const group = notebook.groups.find((candidate) => candidate.id === dragged);
    if (!group) return;
    const without = order.filter((id) => id !== dragged);
    const over = without.indexOf(overId);
    if (over < 0) return;
    without.splice(over + (after ? 1 : 0), 0, dragged);
    reorderGroups(without);
    setReorderStatus(
      `${groupTitle(group)} moved to position ${without.indexOf(dragged) + 1} of ${without.length}`,
    );
  };

  const pointerTargetAt = (
    clientX: number,
    clientY: number,
    draggedId: string,
  ): TermDropTarget | null => {
    const item = document.elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-term-manager-id]');
    const overId = item?.dataset.termManagerId;
    if (!item || !overId || overId === draggedId || !order.includes(overId)) return null;
    const row = item.querySelector<HTMLElement>('.term-manager-row');
    const rect = (row ?? item).getBoundingClientRect();
    return { id: overId, after: clientY >= rect.top + rect.height / 2 };
  };

  const showDropTarget = (next: TermDropTarget | null) => {
    setDropTarget((current) => (
      current?.id === next?.id && current?.after === next?.after ? current : next
    ));
  };

  const clearPointerDrag = () => {
    pointerDragRef.current = null;
    setDraggingId(null);
    showDropTarget(null);
  };

  const updatePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = pointerTargetAt(event.clientX, event.clientY, id);
    pointerDrag.target = target;
    showDropTarget(target);
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = pointerTargetAt(event.clientX, event.clientY, id) ?? pointerDrag.target;
    if (target) place(id, target.id, target.after);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Synthetic pointer tests do not create browser-level capture state.
    }
    clearPointerDrag();
  };

  const beginNew = () => {
    clearNotebookError();
    setEditingId('new');
    requestAnimationFrame(() => document.getElementById('term-aliases-new')?.scrollIntoView({ block: 'center' }));
  };

  const closeEditorAndFocus = (controlId: string) => {
    setEditingId(null);
    requestAnimationFrame(() => document.getElementById(controlId)?.focus());
  };

  const focusAfterNotice = (preferredId?: string) => {
    requestAnimationFrame(() => {
      const preferred = preferredId ? document.getElementById(preferredId) : null;
      (preferred ?? document.getElementById('term-manager-add'))?.focus();
    });
  };

  return (
    <section className="query-notebook" aria-label="Query notebook">
      <p id="term-reorder-instructions" className="visually-hidden">
        Drag this handle to reorder. With a keyboard, press Space or Enter to grab,
        use the up and down arrow keys, then press Space or Enter to drop.
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">{reorderStatus}</p>
      {notebookError && editingId === null && (
        <p className="term-manager-error" role="alert">{notebookError}</p>
      )}
      {removedGroups.length > 0 && (
        <div className="term-manager-undo" role="status">
          Removed {groupTitle(removedGroups.at(-1)!.group)}.
          {' '}<button
            type="button"
            onClick={() => {
              const restoredId = removedGroups.at(-1)!.group.id;
              undoRemoveGroup();
              focusAfterNotice(`term-summary-${restoredId}`);
            }}
          >Undo</button>
          {' '}<button
            type="button"
            onClick={() => {
              dismissRemovedGroup();
              focusAfterNotice();
            }}
          >Dismiss</button>
        </div>
      )}
      <ul className="term-manager-list" aria-label="Terms">
        {rows.map((row) => {
          const group = notebook.groups.find((candidate) => candidate.id === row.id)!;
          const expanded = editingId === row.id;
          return (
            <li
              key={row.id}
              className="term-manager-item"
              data-term-manager-id={row.id}
              data-dragging={draggingId === row.id || undefined}
              data-drop-position={dropTarget?.id === row.id
                ? dropTarget.after ? 'after' : 'before'
                : undefined}
            >
              <div className="term-manager-row">
                <button
                  id={`term-drag-${row.id}`}
                  type="button"
                  className="term-drag-handle"
                  aria-label={`Reorder ${row.name}`}
                  aria-describedby="term-reorder-instructions"
                  aria-pressed={keyboardGrabbedId === row.id || draggingId === row.id}
                  onPointerDown={(event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus({ preventScroll: true });
                    pointerDragRef.current = {
                      id: row.id,
                      pointerId: event.pointerId,
                      target: null,
                    };
                    setKeyboardGrabbedId(null);
                    setDraggingId(row.id);
                    showDropTarget(null);
                    setReorderStatus(`${row.name} grabbed. Drag to a new position.`);
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // Pointer capture is unavailable for synthetic events.
                    }
                  }}
                  onPointerMove={(event) => updatePointerDrag(event, row.id)}
                  onPointerUp={(event) => finishPointerDrag(event, row.id)}
                  onPointerCancel={() => {
                    clearPointerDrag();
                    setReorderStatus(`${row.name} reorder cancelled.`);
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      const grabbed = keyboardGrabbedId !== row.id;
                      setKeyboardGrabbedId(grabbed ? row.id : null);
                      setReorderStatus(grabbed
                        ? `${row.name} grabbed. Use the up and down arrow keys to reorder.`
                        : `${row.name} dropped at position ${order.indexOf(row.id) + 1} of ${order.length}`);
                      return;
                    }
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    if (keyboardGrabbedId !== row.id) {
                      setReorderStatus(`${row.name} is not grabbed. Press Space or Enter to grab it.`);
                      return;
                    }
                    move(row.id, event.key === 'ArrowUp' ? -1 : 1);
                  }}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <button
                  id={`term-summary-${row.id}`}
                  type="button"
                  className="term-manager-summary"
                  aria-label={`Edit term: ${row.name}`}
                  aria-expanded={expanded}
                  {...(expanded ? { 'aria-controls': `term-editor-${row.id}` } : {})}
                  onClick={() => {
                    clearNotebookError();
                    setEditingId(expanded ? null : row.id);
                  }}
                >
                  <SeriesLineSample slot={row.slot ?? styleSlotOf(group.style)} emphasized={row.active} />
                  <span className="term-manager-title">{row.name}</span>
                  {group.aliases.length > 1 && (
                    <span className="term-manager-alias-count">+{group.aliases.length - 1} aliases</span>
                  )}
                </button>
                <span className="term-manager-count"><CountCell count={row.count} /></span>
                <label
                  className="term-manager-visible"
                  title={row.active ? `Hide ${row.name} from analysis` : `Show ${row.name} in analysis`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Shown in analysis: ${row.name}`}
                    checked={row.active}
                    onChange={(event) => setGroupActive(row.id, event.currentTarget.checked)}
                  />
                </label>
                <button
                  type="button"
                  className="term-manager-remove"
                  aria-label={`Remove ${row.name}`}
                  onClick={() => {
                    if (expanded) setEditingId(null);
                    removeGroup(row.id);
                    requestAnimationFrame(() => {
                      document.querySelector<HTMLButtonElement>('.term-manager-undo button')?.focus();
                    });
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              {expanded && (
                <div id={`term-editor-${row.id}`}>
                  <TermEditor
                    key={row.id}
                    group={group}
                    initialStyle={group.style}
                    onSaved={() => closeEditorAndFocus(`term-summary-${row.id}`)}
                    onCancel={() => {
                      clearNotebookError();
                      closeEditorAndFocus(`term-summary-${row.id}`);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
        {rows.length === 0 && editingId !== 'new' && (
          <li className="term-manager-empty">No terms yet. Add one to begin comparing.</li>
        )}
        {editingId === 'new' && (
          <li className="term-manager-item term-new-row" id="term-editor-new">
            <span className="term-drag-placeholder" aria-hidden="true">⠿</span>
            <TermEditor
              group={null}
              initialStyle={newStyle}
              onSaved={(groupId) => closeEditorAndFocus(`term-summary-${groupId}`)}
              onCancel={() => {
                clearNotebookError();
                closeEditorAndFocus('term-manager-add');
              }}
            />
          </li>
        )}
      </ul>
      <div className="term-manager-actions">
        <button type="button" className="term-manager-add" onClick={onDone}>Done</button>
        <button id="term-manager-add" type="button" className="term-manager-add" onClick={beginNew}>
          + Add term
        </button>
      </div>
    </section>
  );
}
