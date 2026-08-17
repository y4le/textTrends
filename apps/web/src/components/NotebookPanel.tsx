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
  type SeriesLineId,
  type SeriesStyleV1,
} from '@texttrends/core';
import { useApp } from '../lib/store-instance.ts';
import {
  aliasesForTermEditor,
  firstFreeStyle,
  groupTitle,
  termAliasesForSave,
} from '../lib/notebook.ts';
import type { GroupCountVM, NotebookRowVM } from '../lib/notebook-view.ts';
import { termReorderScrollStep } from '../lib/term-reorder-gesture.ts';
import {
  isLegacySeriesColor,
  seriesColorContrastWarning,
  seriesColorFromNativeInput,
  seriesColorLabel,
} from '../lib/series-style.ts';
import { DEFAULT_MAXIMIN_SERIES_PALETTE } from '../lib/series-palette.ts';
import { SeriesLineSample } from './chrome.tsx';
import { usePresentation } from './PresentationProvider.tsx';

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

function nativeColorValue(
  color: SeriesStyleV1['color'],
  scheme: 'dark' | 'light',
): string {
  if (!isLegacySeriesColor(color)) return color;
  if (typeof document !== 'undefined') {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(`--series-${SERIES_COLOR_IDS.indexOf(color) + 1}`)
      .trim()
      .toLowerCase();
    if (/^#[0-9a-f]{6}$/u.test(value)) return value;
  }
  return DEFAULT_MAXIMIN_SERIES_PALETTE[scheme][SERIES_COLOR_IDS.indexOf(color)]!;
}

function StylePicker({
  name,
  termLabel,
  style,
  onChange,
}: {
  readonly name: string;
  readonly termLabel: string;
  readonly style: SeriesStyleV1;
  readonly onChange: (style: SeriesStyleV1) => void;
}) {
  const { colorScheme } = usePresentation();
  const inputColor = nativeColorValue(style.color, colorScheme);
  const contrastWarning = seriesColorContrastWarning(style.color);
  const warningText = contrastWarning === 'both'
    ? 'This color may be hard to see in dark and light mode.'
    : contrastWarning
      ? `This color may be hard to see in ${contrastWarning} mode.`
      : null;
  const warningId = `${name}-color-contrast`;
  return (
    <div className="term-style-picker">
      <fieldset>
        <legend>Color</legend>
        <label className="term-native-color">
          <input
            type="color"
            name={`${name}-color`}
            aria-label={`Color for ${termLabel}`}
            aria-describedby={warningText ? warningId : undefined}
            value={inputColor}
            onInput={(event) => {
              const color = seriesColorFromNativeInput(
                style.color,
                event.currentTarget.value,
                inputColor,
              );
              if (color === style.color) return;
              onChange({ ...style, color });
            }}
          />
          <span className="term-native-color-value">{seriesColorLabel(style.color)}</span>
        </label>
        {warningText && (
          <p id={warningId} className="term-color-warning">{warningText}</p>
        )}
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
                <SeriesLineSample style={candidate} emphasized />
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
        termLabel={label}
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
    readonly pointerType: string;
    readonly scrollContainer: HTMLElement | null;
    clientX: number;
    clientY: number;
    target: TermDropTarget | null;
  } | null>(null);
  const dragScrollFrame = useRef<number | null>(null);
  const spentTouchIds = useRef(new Set<number>());
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
    if (dragScrollFrame.current !== null) {
      cancelAnimationFrame(dragScrollFrame.current);
      dragScrollFrame.current = null;
    }
    pointerDragRef.current = null;
    setDraggingId(null);
    showDropTarget(null);
  };

  useEffect(() => () => {
    if (dragScrollFrame.current !== null) cancelAnimationFrame(dragScrollFrame.current);
  }, []);

  useEffect(() => {
    const cancelForAdditionalTouch = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const spent = spentTouchIds.current;
      if (spent.size > 0) {
        spent.add(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const active = pointerDragRef.current;
      if (
        !active
        || active.pointerId === event.pointerId
      ) return;
      if (active.pointerType === 'touch') spent.add(active.pointerId);
      spent.add(event.pointerId);
      clearPointerDrag();
      setReorderStatus('Term reorder cancelled because another touch was detected.');
      event.preventDefault();
      event.stopPropagation();
    };
    const releaseSpentTouch = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch' || !spentTouchIds.current.has(event.pointerId)) return;
      spentTouchIds.current.delete(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', cancelForAdditionalTouch, true);
    document.addEventListener('pointerup', releaseSpentTouch, true);
    document.addEventListener('pointercancel', releaseSpentTouch, true);
    return () => {
      document.removeEventListener('pointerdown', cancelForAdditionalTouch, true);
      document.removeEventListener('pointerup', releaseSpentTouch, true);
      document.removeEventListener('pointercancel', releaseSpentTouch, true);
      spentTouchIds.current.clear();
    };
  }, []);

  const runPointerAutoscroll = () => {
    if (dragScrollFrame.current !== null) return;
    const tick = () => {
      dragScrollFrame.current = null;
      const pointerDrag = pointerDragRef.current;
      const scroller = pointerDrag?.scrollContainer;
      if (!pointerDrag || !scroller) return;
      const rect = scroller.getBoundingClientRect();
      const step = termReorderScrollStep(pointerDrag.clientY, rect.top, rect.bottom);
      if (step === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop === before) return;
      const target = pointerTargetAt(pointerDrag.clientX, pointerDrag.clientY, pointerDrag.id);
      if (target) {
        pointerDrag.target = target;
        showDropTarget(target);
      }
      dragScrollFrame.current = requestAnimationFrame(tick);
    };
    dragScrollFrame.current = requestAnimationFrame(tick);
  };

  const updatePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    pointerDrag.clientX = event.clientX;
    pointerDrag.clientY = event.clientY;
    const target = pointerTargetAt(event.clientX, event.clientY, id);
    pointerDrag.target = target;
    showDropTarget(target);
    runPointerAutoscroll();
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = pointerTargetAt(event.clientX, event.clientY, id) ?? pointerDrag.target;
    if (target) place(id, target.id, target.after);
    // Clear first so the expected lostpointercapture from a successful drop
    // cannot be mistaken for a cancellation of this (or a reused-id) drag.
    clearPointerDrag();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Synthetic pointer tests do not create browser-level capture state.
    }
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
                      pointerType: event.pointerType,
                      scrollContainer: event.currentTarget.closest<HTMLElement>('.form-layer'),
                      clientX: event.clientX,
                      clientY: event.clientY,
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
                  onPointerCancel={(event) => {
                    const active = pointerDragRef.current;
                    if (
                      active?.id !== row.id
                      || active.pointerId !== event.pointerId
                    ) return;
                    clearPointerDrag();
                    setReorderStatus(`${row.name} reorder cancelled.`);
                  }}
                  onLostPointerCapture={(event) => {
                    const active = pointerDragRef.current;
                    if (
                      active?.id !== row.id
                      || active.pointerId !== event.pointerId
                    ) return;
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
                  <SeriesLineSample style={row.style ?? group.style} emphasized={row.active} />
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
