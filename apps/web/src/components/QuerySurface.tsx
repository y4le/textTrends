import { MAX_KWIC_TRACKS, NOTEBOOK_LIMITS_V1 } from '@texttrends/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DockTakeover } from './DockTakeover.tsx';
import { FormLayer } from './FormLayer.tsx';
import {
  formatAliasAlternatives,
  groupTitle,
  parseAuthoredAliases,
} from '../lib/notebook.ts';
import { NotebookPanel } from './NotebookPanel.tsx';
import {
  queryEditorTarget,
  querySurfaceView,
  termFocusControlId,
  type QueryEditorTarget,
} from '../lib/query-surface.ts';
import { rowDetailSurface, rowDetailWrite } from '../lib/row-detail.ts';
import type { NotebookRowVM } from '../lib/notebook-view.ts';
import { shortcutAria, shortcutMatches } from '../lib/shortcuts.ts';
import { useApp } from '../lib/store-instance.ts';
import { guideAnchorProps } from '../lib/guide/anchors.ts';
import { TermBucket, TermActionMenu } from './terms/TermControls.tsx';

const ADD_TERM_LABEL = 'Add term';
const INLINE_ALIAS_HINT_ID = 'term-inline-alias-hint';

interface TermRailPosition {
  readonly before: boolean;
  readonly after: boolean;
}

const EMPTY_TERM_RAIL_POSITION: TermRailPosition = Object.freeze({
  before: false,
  after: false,
});

export function QuerySurface({
  inlineAddOpen,
  onInlineAddOpenChange,
}: {
  readonly inlineAddOpen: boolean;
  readonly onInlineAddOpenChange: (open: boolean) => void;
}) {
  const place = useApp((state) => state.place);
  const notebook = useApp((state) => state.notebook);
  const activeGroupIds = useApp((state) => state.activeGroupIds);
  const soloGroupId = useApp((state) => state.soloGroupId);
  const styles = useApp((state) => state.styles);
  const trends = useApp((state) => state.trends);
  const selectedTrends = useApp((state) => state.selectedTrends);
  const linkedSelection = useApp((state) => state.linkedSelection);
  const snapshot = useApp((state) => state.snapshot);
  const layers = useApp((state) => state.layers);
  const removedGroups = useApp((state) => state.removedGroups);
  const setGroupActive = useApp((state) => state.setGroupActive);
  const setSolo = useApp((state) => state.setSolo);
  const addTerm = useApp((state) => state.addTerm);
  const removeGroup = useApp((state) => state.removeGroup);
  const clearNotebookError = useApp((state) => state.clearNotebookError);
  const notebookError = useApp((state) => state.notebookError);
  const undoRemoveGroup = useApp((state) => state.undoRemoveGroup);
  const dismissRemovedGroup = useApp((state) => state.dismissRemovedGroup);
  const pushLayer = useApp((state) => state.pushLayer);
  const replaceLayer = useApp((state) => state.replaceLayer);
  const popLayer = useApp((state) => state.popLayer);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [inlineTerm, setInlineTerm] = useState('');
  const [managerNewTermDraft, setManagerNewTermDraft] = useState('');
  const [termKeyboardStatus, setTermKeyboardStatus] = useState('');
  const [termRailPosition, setTermRailPosition] = useState<TermRailPosition>(
    EMPTY_TERM_RAIL_POSITION,
  );
  const inlineReturnFocus = useRef('term-add');
  const termPortRef = useRef<HTMLDivElement | null>(null);

  const view = querySurfaceView({
    place,
    groups: notebook.groups,
    activeGroupIds,
    soloGroupId,
    styles,
    trends,
    selectedTrends,
    hasSelection: linkedSelection !== null,
    hasSnapshot: snapshot !== null,
    partialCorpus: (snapshot?.missingDocs.length ?? 0) > 0,
  });
  const termIdentity = view.rows.map((row) => row.id).join('\u001f');
  const inlineAliases = parseAuthoredAliases(inlineTerm);
  const inlineAliasHint = inlineAliases.length > 1
    ? `Matches ${formatAliasAlternatives(inlineAliases)}`
    : null;
  const topLayer = layers.at(-1);
  const target = topLayer?.kind === 'row-detail'
    ? queryEditorTarget(topLayer.target)
    : null;
  const writeLayer = (next: QueryEditorTarget, returnFocusTo: string) => {
    const write = rowDetailWrite(
      topLayer?.kind === 'row-detail' ? rowDetailSurface(topLayer.target) : null,
      'query-editor',
    );
    if (write === 'replace') replaceLayer('row-detail', Object.freeze(next), returnFocusTo);
    else pushLayer('row-detail', Object.freeze(next), returnFocusTo);
  };
  const openGroup = (groupId: string, returnFocusTo: string) => writeLayer(
    { surface: 'query-editor', mode: 'manage', groupId },
    returnFocusTo,
  );
  const closeEditor = () => {
    setManagerNewTermDraft('');
    clearNotebookError();
    popLayer();
  };
  const focusTerm = (groupId: string) => {
    requestAnimationFrame(() => {
      const control = document.getElementById(termFocusControlId(groupId));
      control?.focus({ preventScroll: true });
      control?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };
  const closeTermMenu = (restoreFocus: boolean) => {
    const closingId = openMenuId;
    setOpenMenuId(null);
    if (restoreFocus && closingId !== null) focusTerm(closingId);
  };
  const openInlineAdd = (returnFocusTo: string) => {
    setOpenMenuId(null);
    clearNotebookError();
    setTermKeyboardStatus('');
    inlineReturnFocus.current = returnFocusTo;
    setInlineTerm('');
    onInlineAddOpenChange(true);
  };
  const closeInlineAdd = (restoreFocus = true) => {
    onInlineAddOpenChange(false);
    setInlineTerm('');
    clearNotebookError();
    if (restoreFocus) {
      requestAnimationFrame(() => document.getElementById(inlineReturnFocus.current)?.focus({
        preventScroll: true,
      }));
    }
  };
  const navigateTerm = (groupId: string, delta: -1 | 1) => {
    const index = view.rows.findIndex((row) => row.id === groupId);
    if (index < 0 || view.rows.length === 0) return;
    const next = (index + delta + view.rows.length) % view.rows.length;
    const row = view.rows[next]!;
    setTermKeyboardStatus(`${row.name}, term ${next + 1} of ${view.rows.length}`);
    focusTerm(row.id);
  };
  const exitTermNavigation = () => {
    setTermKeyboardStatus('Terms');
    requestAnimationFrame(() => document.getElementById('term-query-port')?.focus({
      preventScroll: true,
    }));
  };
  const deleteTerm = (groupId: string) => {
    const index = view.rows.findIndex((row) => row.id === groupId);
    if (index < 0) return;
    const removed = view.rows[index]!;
    const next = view.rows[index + 1] ?? view.rows[index - 1];
    setOpenMenuId(null);
    removeGroup(groupId);
    setTermKeyboardStatus(`Deleted ${removed.name}. Undo is available.`);
    if (next) focusTerm(next.id);
    else requestAnimationFrame(() => document.getElementById('term-add')?.focus({ preventScroll: true }));
  };
  const selectOnly = (row: NotebookRowVM) => {
    clearNotebookError();
    if (row.solo) {
      setSolo(null);
      setTermKeyboardStatus('Showing all selected terms');
    } else {
      if (!row.active) setGroupActive(row.id, true);
      if (useApp.getState().activeGroupIds.has(row.id)) {
        setSolo(row.id);
        setTermKeyboardStatus(`Showing only ${row.name}`);
      }
    }
    closeTermMenu(true);
  };
  const submitInlineAdd = () => {
    const existingIds = new Set(notebook.groups.map((group) => group.id));
    const groupId = addTerm({ aliases: parseAuthoredAliases(inlineTerm) });
    if (groupId === null) {
      requestAnimationFrame(() => document.getElementById('term-inline-add-input')?.focus({
        preventScroll: true,
      }));
      return;
    }
    const group = useApp.getState().notebook.groups.find((candidate) => candidate.id === groupId);
    const name = group ? groupTitle(group) : inlineTerm.trim();
    const added = !existingIds.has(groupId);
    const shown = useApp.getState().activeGroupIds.has(groupId);
    const alsoMatches = group?.aliases.slice(1) ?? [];
    setTermKeyboardStatus(!added
      ? `${name} is already in Terms.`
      : !shown
        ? `Added ${name}. Hidden — ${MAX_KWIC_TRACKS} terms already shown.`
        : alsoMatches.length > 0
          ? `Added ${name} — also matches ${formatAliasAlternatives(alsoMatches)}.`
          : `Added ${name}.`);
    closeInlineAdd(false);
    focusTerm(groupId);
  };
  const openInlineManager = () => {
    setManagerNewTermDraft(inlineTerm);
    onInlineAddOpenChange(false);
    setInlineTerm('');
    clearNotebookError();
    writeLayer(
      { surface: 'query-editor', mode: 'manage', create: true },
      inlineReturnFocus.current,
    );
  };

  useEffect(() => {
    if (!inlineAddOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById('term-inline-add-input') as HTMLInputElement | null;
      input?.focus({ preventScroll: true });
      input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [inlineAddOpen]);

  useEffect(() => () => onInlineAddOpenChange(false), [onInlineAddOpenChange]);

  useEffect(() => {
    if (target?.mode !== 'manage' || managerNewTermDraft === '') return;
    // The draft is a one-render handoff into TermEditor's state, not manager state.
    // Consuming it here keeps Back and an in-manager Cancel from resurrecting it.
    setManagerNewTermDraft('');
  }, [managerNewTermDraft, target?.mode]);

  useEffect(() => {
    if (openMenuId !== null && !view.rows.some((row) => row.id === openMenuId)) {
      setOpenMenuId(null);
    }
  }, [openMenuId, view.rows]);
  useLayoutEffect(() => {
    const port = termPortRef.current;
    if (port === null) return undefined;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const maximumScroll = Math.max(0, port.scrollWidth - port.clientWidth);
      const next: TermRailPosition = {
        before: port.scrollLeft > 1,
        after: port.scrollLeft < maximumScroll - 1,
      };
      setTermRailPosition((current) => current.before === next.before
        && current.after === next.after
        ? current
        : next);
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedule);
    observer?.observe(port);
    for (const child of port.children) {
      if (child instanceof HTMLElement) observer?.observe(child);
    }
    port.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      port.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [inlineAddOpen, termIdentity]);
  const openMenuRow = openMenuId === null
    ? null
    : view.rows.find((row) => row.id === openMenuId) ?? null;

  return (
    <>
      <aside
        {...guideAnchorProps('terms-rail')}
        className="query-region term-bar"
        aria-label="Terms"
        data-takeover={inlineAddOpen ? 'add' : undefined}
        data-uses-query-encoding={view.usesQueryEncoding}
      >
        <span
          id="term-rail-status"
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {termKeyboardStatus}
        </span>
        <span
          id="term-rail-error"
          className="visually-hidden"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {target?.mode === 'manage' ? null : notebookError}
        </span>
        <span id={INLINE_ALIAS_HINT_ID} className="visually-hidden">
          {inlineAliasHint}
        </span>
        {inlineAddOpen && (
          <DockTakeover
            mode="add"
            formLabel="Add a term inline"
            label="New term"
            input={{
              id: 'term-inline-add-input',
              type: 'text',
              value: inlineTerm,
              placeholder: 'new term',
              enterKeyHint: 'done',
              describedBy: [
                notebookError ? 'term-rail-error' : 'term-rail-status',
                inlineAliasHint ? INLINE_ALIAS_HINT_ID : null,
              ].filter(Boolean).join(' '),
              onChange: (value) => {
                setInlineTerm(value);
                if (notebookError !== null) clearNotebookError();
              },
            }}
            status={notebookError ?? inlineAliasHint}
            statusTone={notebookError === null ? 'muted' : 'error'}
            onSubmit={submitInlineAdd}
            onDismiss={() => closeInlineAdd()}
            controls={(
              <>
                <button type="submit" disabled={inlineTerm.trim() === ''}>Add</button>
                <button type="button" onClick={openInlineManager}>
                  More options
                </button>
                <button
                  type="button"
                  className="dock-takeover-icon-action"
                  aria-label="Cancel"
                  onClick={() => closeInlineAdd()}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </>
            )}
          />
        )}
        {!inlineAddOpen && (
          <>
        <strong className="term-bar-label">
          Terms
          {activeGroupIds.size >= MAX_KWIC_TRACKS
            ? ` · ${activeGroupIds.size}/${MAX_KWIC_TRACKS} shown`
            : ''}
        </strong>
        <div
          className="term-bucket-frame"
          data-overflow-before={termRailPosition.before || undefined}
          data-overflow-after={termRailPosition.after || undefined}
        >
          <div
            ref={termPortRef}
            id="term-query-port"
            className="term-bucket-port"
            role="group"
            aria-label={[
              `Query terms (${view.rows.length})`,
              termRailPosition.before && termRailPosition.after
                ? 'More terms before and after.'
                : termRailPosition.before
                  ? 'More terms before.'
                  : termRailPosition.after ? 'More terms after.' : '',
            ].filter(Boolean).join('. ')}
            tabIndex={-1}
          >
            {view.rows.length === 0 && (
              <span className="term-bar-empty">No terms yet.</span>
            )}
            {view.rows.map((row) => (
              <TermBucket
                key={row.id}
                row={row}
                aliases={notebook.groups.find((group) => group.id === row.id)?.aliases ?? [row.name]}
                menuOpen={openMenuId === row.id}
                onToggle={() => setGroupActive(row.id, !row.active)}
                onEdit={() => openGroup(row.id, `term-edit-${row.id}`)}
                onOpenMenu={() => setOpenMenuId(row.id)}
                onNavigate={(delta) => navigateTerm(row.id, delta)}
                onDelete={() => deleteTerm(row.id)}
                onAddInline={() => openInlineAdd(termFocusControlId(row.id))}
                onExit={exitTermNavigation}
              />
            ))}
          </div>
        </div>
        <div className="term-bar-actions">
          <button
            id="term-add"
            className="term-bar-icon-action"
            type="button"
            aria-label={ADD_TERM_LABEL}
            aria-keyshortcuts={shortcutAria(['term-add-inline'])}
            title={ADD_TERM_LABEL}
            onClick={() => openInlineAdd('term-add')}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter'
                && event.key !== ' '
                && !shortcutMatches(event, 'term-add-inline')
              ) return;
              event.preventDefault();
              openInlineAdd('term-add');
            }}
          >
            <span className="term-bar-action-glyph" aria-hidden="true">+</span>
          </button>
          <button
            id="term-manage"
            className="term-bar-icon-action"
            type="button"
            aria-label="Manage"
            aria-haspopup="dialog"
            title="Manage"
            onClick={() => writeLayer({ surface: 'query-editor', mode: 'manage' }, 'term-manage')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            </svg>
          </button>
        </div>
          </>
        )}
        {removedGroups.length > 0 && (
          <div className="term-undo" role="status">
            Removed {groupTitle(removedGroups.at(-1)!.group)}.
            {' '}<button type="button" onClick={undoRemoveGroup}>Undo</button>
            {' '}<button type="button" onClick={dismissRemovedGroup}>Dismiss</button>
          </div>
        )}
      </aside>

      {openMenuRow !== null && (
        <TermActionMenu
          row={openMenuRow}
          onClose={closeTermMenu}
          onSelectOnly={() => selectOnly(openMenuRow)}
          onDelete={() => deleteTerm(openMenuRow.id)}
          onManage={() => {
            const groupId = openMenuRow.id;
            setOpenMenuId(null);
            openGroup(groupId, termFocusControlId(groupId));
          }}
        />
      )}

      {target?.mode === 'manage' && (
        <FormLayer
          label="Manage terms"
          focusKey={target.groupId ?? (target.create ? 'new-term' : 'manage-terms')}
          onClose={closeEditor}
        >
          <section className="term-manager">
            <header className="term-manager-header">
              <div>
                <h2>Manage terms</h2>
                <p>
                  {view.rows.length} of {NOTEBOOK_LIMITS_V1.maxGroups} terms · up to{' '}
                  {MAX_KWIC_TRACKS} shown in analysis
                </p>
              </div>
            </header>
            <NotebookPanel
              rows={view.rows}
              onDone={closeEditor}
              initialNewTermAliases={managerNewTermDraft}
              {...(target.groupId ? { initialGroupId: target.groupId } : {})}
              {...(target.create ? { createOnOpen: true } : {})}
            />
          </section>
        </FormLayer>
      )}
    </>
  );
}
