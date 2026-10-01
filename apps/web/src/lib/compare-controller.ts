/** Compare query ownership inside the single composed application store.
 * Each rank table and header inventory has its own lane. Cross-slice snapshot
 * publication and geometry subscriptions remain in the runtime.
 */
import type { StoreApi } from 'zustand';
import { STOPLIST_EN_ID, STOPLIST_EN_VERSION, STOPLIST_MAX_TOP_N, type WorkspaceV1 } from '@texttrends/core';
import type { AppState, KeynessViewV1, KeynessTableState, KeynessInventoryState, KeynessScope } from './app-state.ts';
import type { KeynessResultV1 } from '../shared/analysis-contract.ts';
import type { SessionState } from './project-session.ts';
import type { OperationScope } from './operation-lease.ts';
import { QueryLane, type QueryIssuer } from './query-lane.ts';
import { DEFAULT_KEYNESS_VIEW, INVENTORY_MATTR_WINDOW } from './app-defaults.ts';
import { COMPARE_MAX_RESIDENT_ROWS } from './compare-scroll.ts';
import { effectiveKeynessMinDocFreq, keynessSelections, reconcileKeynessView } from './keyness-view.ts';

type CompareActions = Pick<AppState,
  'runKeyness' | 'loadMoreKeyness' | 'setKeynessMode' | 'setKeynessDocument'
  | 'setKeynessSelection' | 'swapKeynessSides' | 'resetKeynessComparison' | 'applyKeynessSettings'
>;

interface CompareDependencies {
  get: StoreApi<AppState>['getState'];
  set: StoreApi<AppState>['setState'];
  scope: OperationScope;
  issue: QueryIssuer;
  snapshotKey(): string | null;
  keynessScope(): KeynessScope | null;
}

function keynessSideSelectionKey(
  scope: KeynessScope,
  side: 'a' | 'b',
): string | null {
  const pair = keynessSelections(scope);
  return pair ? JSON.stringify(pair[side]) : null;
}

function keynessTableIntentKey(
  scope: KeynessScope,
  side: 'a' | 'b',
): string | null {
  const { view } = scope;
  const pair = keynessSelections(scope);
  if (!pair) return null;
  return JSON.stringify([
    pair,
    view.minCountTotal,
    effectiveKeynessMinDocFreq(view, pair),
    view.classes,
    view.stoplistTopN,
    { by: view.sort.by, dir: side === 'a' ? view.sort.dirA : view.sort.dirB },
    view.pageLimit,
    side,
  ]);
}

export function createCompareController({
  get, set, scope, issue: issueOn, snapshotKey, keynessScope,
}: CompareDependencies) {
  // Each visible keyness table and comparison-header inventory owns its lane:
  // paging A cannot supersede B, and neither depends on the global brush.
  const keynessALane = new QueryLane(scope);
  const keynessBLane = new QueryLane(scope);
  const keynessInventoryALane = new QueryLane(scope);
  const keynessInventoryBLane = new QueryLane(scope);
  // A demo acquisition knows its declared first document before concurrent
  // extraction has made that document ready. Keep that one-shot intent outside
  // the durable workspace so async completion order cannot choose Book 2.
  let pendingKeynessResetDoc: string | null = null;
  let restoringCompareDocs: readonly string[] | null = null;
  const writeKeynessTable = (
    side: 'a' | 'b',
    value: KeynessTableState | null,
  ): void => {
    if (side === 'a') set({ keynessA: value });
    else set({ keynessB: value });
  };

  const writeKeynessInventory = (
    side: 'a' | 'b',
    value: KeynessInventoryState | null,
  ): void => {
    if (side === 'a') set({ keynessInventoryA: value });
    else set({ keynessInventoryB: value });
  };

  const runKeynessTable = (side: 'a' | 'b'): void => {
    const lane = side === 'a' ? keynessALane : keynessBLane;
    lane.supersede();
    const state = get();
    const { snapshot } = state;
    const scope = keynessScope();
    const pair = scope ? keynessSelections(scope) : null;
    if (!snapshot || !scope || !pair) {
      writeKeynessTable(side, null);
      return;
    }
    const issuedKey = snapshotKey();
    const issuedView = scope.view;
    const issuedIntent = keynessTableIntentKey(
      scope,
      side,
    );
    const minDocFreqTotal = effectiveKeynessMinDocFreq(issuedView, pair);
    const sort = {
      by: issuedView.sort.by,
      dir: side === 'a' ? issuedView.sort.dirA : issuedView.sort.dirB,
    };
    const page = {
      offset: 0,
      limit: issuedView.pageLimit,
    };
    const lease = lane.ops.begin(
      () => snapshotKey() === issuedKey,
      () => {
        const liveScope = keynessScope();
        return liveScope !== null
          && keynessTableIntentKey(liveScope, side) === issuedIntent;
      },
    );
    writeKeynessTable(side, {
      snapshot: snapshot.snapshot,
      side,
      view: issuedView,
      resident: null,
      state: { status: 'pending' },
    });
    issueOn(
      lane,
      snapshot.snapshot,
      {
        op: 'keyness',
        request: {
          method: 'keyness-g2-2x2/2',
          effect: 'log-ratio-proportional/1',
          a: pair.a,
          b: pair.b,
          filter: {
            minCountTotal: issuedView.minCountTotal,
            minDocFreqTotal,
            classes: issuedView.classes,
            ...(issuedView.stoplistTopN === 0 ? {} : {
              stoplist: {
                id: STOPLIST_EN_ID,
                version: STOPLIST_EN_VERSION,
                topN: issuedView.stoplistTopN,
              },
            }),
          },
          sort,
          page,
          side,
        },
      },
      lease,
      (data) => {
        writeKeynessTable(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          resident: data.keyness,
          state: { status: 'ready', result: data.keyness },
        });
      },
      (message) => writeKeynessTable(side, {
        snapshot: snapshot.snapshot,
        side,
        view: issuedView,
        resident: null,
        state: { status: 'error', message },
      }),
    );
  };

  const runKeynessInventory = (side: 'a' | 'b'): void => {
    const lane = side === 'a'
      ? keynessInventoryALane
      : keynessInventoryBLane;
    lane.supersede();
    const state = get();
    const { snapshot, keynessView } = state;
    const scope = keynessScope();
    const pair = scope ? keynessSelections(scope) : null;
    if (!snapshot || !scope || !pair) {
      writeKeynessInventory(side, null);
      return;
    }
    const issuedKey = snapshotKey();
    const issuedView = keynessView;
    const issuedSelection = keynessSideSelectionKey(
      scope,
      side,
    );
    const lease = lane.ops.begin(
      () => snapshotKey() === issuedKey,
      () => {
        const liveScope = keynessScope();
        return liveScope !== null
          && keynessSideSelectionKey(liveScope, side) === issuedSelection;
      },
    );
    writeKeynessInventory(side, {
      snapshot: snapshot.snapshot,
      side,
      view: issuedView,
      state: { status: 'pending' },
    });
    issueOn(
      lane,
      snapshot.snapshot,
      {
        op: 'inventory',
        selection: pair[side],
        request: {
          method: 'inventory/2',
          rhythmBinsPerDoc: 0,
          mattrWindow: INVENTORY_MATTR_WINDOW,
        },
      },
      lease,
      (data) => {
        writeKeynessInventory(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          state: { status: 'ready', result: data.inventory },
        });
      },
      (message) => writeKeynessInventory(side, {
        snapshot: snapshot.snapshot,
        side,
        view: issuedView,
        state: { status: 'error', message },
      }),
    );
  };

  const actions: CompareActions = {
    runKeyness() {
      runKeynessTable('a');
      runKeynessTable('b');
      runKeynessInventory('a');
      runKeynessInventory('b');
    },

    loadMoreKeyness(side) {
      if (side !== 'a' && side !== 'b') return;
      const lane = side === 'a' ? keynessALane : keynessBLane;
      const state = get();
      const { snapshot } = state;
      const table = side === 'a' ? state.keynessA : state.keynessB;
      const resident = table?.resident
        ?? (table?.state.status === 'ready' ? table.state.result : null);
      const scope = keynessScope();
      const pair = scope ? keynessSelections(scope) : null;
      if (
        !snapshot
        || !scope
        || !pair
        || resident === null
        || (
          table?.state.status !== 'ready'
          && table?.state.status !== 'error'
        )
        || resident.rows.length >= Math.min(
          resident.total,
          COMPARE_MAX_RESIDENT_ROWS,
        )
      ) return;
      const offset = resident.rows.length;
      const limit = Math.min(
        scope.view.pageLimit,
        resident.total - resident.rows.length,
        COMPARE_MAX_RESIDENT_ROWS - resident.rows.length,
      );
      if (
        limit < 1
        || !Number.isSafeInteger(offset + limit)
      ) return;
      const issuedKey = snapshotKey();
      const issuedView = scope.view;
      const issuedIntent = keynessTableIntentKey(
        scope,
        side,
      );
      const minDocFreqTotal = effectiveKeynessMinDocFreq(issuedView, pair);
      const sort = {
        by: issuedView.sort.by,
        dir: side === 'a' ? issuedView.sort.dirA : issuedView.sort.dirB,
      };
      lane.supersede();
      const lease = lane.ops.begin(
        () => snapshotKey() === issuedKey,
        () => {
          const liveScope = keynessScope();
          return liveScope !== null
            && keynessTableIntentKey(liveScope, side) === issuedIntent;
        },
      );
      writeKeynessTable(side, {
        snapshot: snapshot.snapshot,
        side,
        view: issuedView,
        resident,
        state: { status: 'pending' },
      });
      issueOn(
        lane,
        snapshot.snapshot,
        {
          op: 'keyness',
          request: {
            method: 'keyness-g2-2x2/2',
            effect: 'log-ratio-proportional/1',
            a: pair.a,
            b: pair.b,
            filter: {
              minCountTotal: issuedView.minCountTotal,
              minDocFreqTotal,
              classes: issuedView.classes,
              ...(issuedView.stoplistTopN === 0 ? {} : {
                stoplist: {
                  id: STOPLIST_EN_ID,
                  version: STOPLIST_EN_VERSION,
                  topN: issuedView.stoplistTopN,
                },
              }),
            },
            sort,
            page: { offset, limit },
            side,
          },
        },
        lease,
        (data) => {
          const next = data.keyness;
          if (
            next.method !== resident.method
            || next.effect !== resident.effect
            || next.total !== resident.total
            || next.totalsA.tokens !== resident.totalsA.tokens
            || next.totalsA.documents !== resident.totalsA.documents
            || next.totalsB.tokens !== resident.totalsB.tokens
            || next.totalsB.documents !== resident.totalsB.documents
            || next.rows.length !== limit
          ) {
            writeKeynessTable(side, {
              snapshot: snapshot.snapshot,
              side,
              view: issuedView,
              resident,
              state: {
                status: 'error',
                message: 'Comparison ranks changed while more rows were loading. Refresh the view to continue.',
              },
            });
            return;
          }
          const result: KeynessResultV1 = {
            ...next,
            rows: [...resident.rows, ...next.rows],
          };
          writeKeynessTable(side, {
            snapshot: snapshot.snapshot,
            side,
            view: issuedView,
            resident: result,
            state: { status: 'ready', result },
          });
        },
        (message) => writeKeynessTable(side, {
          snapshot: snapshot.snapshot,
          side,
          view: issuedView,
          resident,
          state: { status: 'error', message },
        }),
      );
    },

    setKeynessMode(mode) {
      pendingKeynessResetDoc = null;
      if (
        mode !== 'documents'
        && mode !== 'document-rest'
        && mode !== 'selection-rest'
      ) return;
      const state = get();
      if (state.keynessView.mode === mode) return;
      if (mode === 'selection-rest') {
        set({ keynessView: { ...state.keynessView, mode } });
        get().runKeyness();
        return;
      }
      const ready = state.snapshot?.readyDocs ?? [];
      const focus = state.keynessView.restOn === 'b'
        ? state.keynessView.documentA
        : state.keynessView.documentB;
      const documentA = focus && ready.includes(focus)
        ? focus
        : ready[0] ?? null;
      const documentB = ready.find((doc) => doc !== documentA) ?? null;
      set({
        keynessView: {
          ...state.keynessView,
          mode,
          documentA,
          documentB,
          restOn: 'b',
        },
      });
      get().runKeyness();
    },

    setKeynessDocument(side, doc) {
      pendingKeynessResetDoc = null;
      const state = get();
      const ready = state.snapshot?.readyDocs ?? [];
      if (!ready.includes(doc)) return;
      const view = state.keynessView;
      if (view.mode === 'document-rest') {
        const documentSide = view.restOn === 'b' ? 'a' : 'b';
        if (side !== documentSide) return;
      }
      if (
        (side === 'a' && doc === view.documentB) ||
        (side === 'b' && doc === view.documentA)
      ) {
        return;
      }
      set({
        keynessView: {
          ...view,
          ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
        },
      });
      get().runKeyness();
    },

    setKeynessSelection(side, doc) {
      pendingKeynessResetDoc = null;
      if (side !== 'a' && side !== 'b') return;
      const state = get();
      const ready = state.snapshot?.readyDocs ?? [];
      if (doc !== null && !ready.includes(doc)) return;
      const view = state.keynessView;
      if (view.mode === 'selection-rest') {
        if (doc === null || ready.length < 2) return;
        const other = ready.find((candidate) => candidate !== doc) ?? null;
        set({
          keynessView: {
            ...view,
            mode: 'documents',
            documentA: side === 'a' ? doc : other,
            documentB: side === 'b' ? doc : other,
            restOn: 'b',
          },
        });
        get().runKeyness();
        return;
      }
      if (ready.length < 2) return;
      const otherSide = side === 'a' ? 'b' : 'a';
      const currentDoc = side === 'a' ? view.documentA : view.documentB;
      const otherDoc = side === 'a' ? view.documentB : view.documentA;
      const thisIsRest = view.mode === 'document-rest' && view.restOn === side;
      const otherIsRest = view.mode === 'document-rest' && view.restOn === otherSide;
      let next: KeynessViewV1;

      if (doc === null) {
        if (thisIsRest) return;
        if (otherIsRest) {
          const focus = currentDoc && ready.includes(currentDoc)
            ? currentDoc
            : ready[0] ?? null;
          const filler = ready.find((candidate) => candidate !== focus) ?? null;
          next = {
            ...view,
            restOn: side,
            documentA: side === 'a' ? filler : focus,
            documentB: side === 'b' ? filler : focus,
          };
        } else {
          const focus = otherDoc && ready.includes(otherDoc)
            ? otherDoc
            : ready.find((candidate) => candidate !== currentDoc) ?? ready[0] ?? null;
          const filler = ready.find((candidate) => candidate !== focus) ?? null;
          next = {
            ...view,
            mode: 'document-rest',
            restOn: side,
            documentA: side === 'a' ? filler : focus,
            documentB: side === 'b' ? filler : focus,
          };
        }
      } else if (thisIsRest) {
        if (doc === otherDoc) return;
        next = {
          ...view,
          mode: 'documents',
          ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
        };
      } else if (otherIsRest) {
        const filler = ready.find((candidate) => candidate !== doc) ?? null;
        if (doc === currentDoc && otherDoc === filler) return;
        next = {
          ...view,
          ...(side === 'a'
            ? { documentA: doc, documentB: filler }
            : { documentA: filler, documentB: doc }),
        };
      } else {
        if (doc === otherDoc || doc === currentDoc) return;
        next = {
          ...view,
          ...(side === 'a' ? { documentA: doc } : { documentB: doc }),
        };
      }

      set({ keynessView: next });
      get().runKeyness();
    },

    swapKeynessSides() {
      pendingKeynessResetDoc = null;
      const view = get().keynessView;
      if (view.mode === 'selection-rest') return;
      const ready = get().snapshot?.readyDocs ?? [];
      let next: KeynessViewV1;
      if (view.mode === 'documents') {
        next = {
          ...view,
          documentA: view.documentB,
          documentB: view.documentA,
        };
      } else if (view.restOn === 'b') {
        const focus = view.documentA;
        next = {
          ...view,
          restOn: 'a',
          documentB: focus,
          documentA: ready.find((doc) => doc !== focus) ?? null,
        };
      } else {
        const focus = view.documentB;
        next = {
          ...view,
          restOn: 'b',
          documentA: focus,
          documentB: ready.find((doc) => doc !== focus) ?? null,
        };
      }
      set({ keynessView: next });
      get().runKeyness();
    },

    resetKeynessComparison(doc) {
      const state = get();
      const activeDocuments = [
        ...(state.projectSession?.project.data.order ?? []),
        ...(state.projectSession?.imports
          .filter((pendingImport) => pendingImport.status !== 'failed')
          .map((pendingImport) => pendingImport.doc) ?? []),
      ];
      if (!activeDocuments.includes(doc)) return;
      const ready = state.snapshot?.readyDocs ?? [];
      const focusReady = ready.includes(doc);
      pendingKeynessResetDoc = focusReady ? null : doc;
      set({
        keynessView: {
          ...state.keynessView,
          mode: ready.length < 2
            ? 'selection-rest'
            : DEFAULT_KEYNESS_VIEW.mode,
          documentA: focusReady ? doc : null,
          documentB: focusReady
            ? ready.find((candidate) => candidate !== doc) ?? null
            : null,
          restOn: DEFAULT_KEYNESS_VIEW.restOn,
        },
      });
      get().runKeyness();
    },

    applyKeynessSettings(input) {
      if (
        !Number.isSafeInteger(input.minCountTotal) ||
        input.minCountTotal < 1 ||
        !Number.isSafeInteger(input.minDocFreqTotal) ||
        input.minDocFreqTotal < 1 ||
        !Array.isArray(input.classes) ||
        input.classes.length < 1 ||
        input.classes.length > 2 ||
        new Set(input.classes).size !== input.classes.length ||
        input.classes.some(
          (value) => value !== 'lexical' && value !== 'numeral',
        ) ||
        !Number.isSafeInteger(input.stoplistTopN) ||
        input.stoplistTopN < 0 ||
        input.stoplistTopN > STOPLIST_MAX_TOP_N ||
        !['logRatio', 'logRatioLow', 'g2', 'countA', 'countB']
          .includes(input.sortBy) ||
        (input.dirA !== 1 && input.dirA !== -1) ||
        (input.dirB !== 1 && input.dirB !== -1) ||
        typeof input.showConfidenceIntervals !== 'boolean'
      ) {
        return;
      }
      const view = get().keynessView;
      const sharedQueryChanged =
        view.minCountTotal !== input.minCountTotal ||
        view.minDocFreqTotal !== input.minDocFreqTotal ||
        view.classes.length !== input.classes.length ||
        view.classes.some((value, index) => value !== input.classes[index]) ||
        view.stoplistTopN !== input.stoplistTopN ||
        view.sort.by !== input.sortBy;
      const queryAChanged = sharedQueryChanged || view.sort.dirA !== input.dirA;
      const queryBChanged = sharedQueryChanged || view.sort.dirB !== input.dirB;
      if (
        !queryAChanged &&
        !queryBChanged &&
        view.showConfidenceIntervals === input.showConfidenceIntervals
      ) {
        return;
      }
      set({
        keynessView: {
          ...view,
          minCountTotal: input.minCountTotal,
          minDocFreqTotal: input.minDocFreqTotal,
          classes: [...input.classes],
          stoplistTopN: input.stoplistTopN,
          sort: {
            by: input.sortBy,
            dirA: input.dirA,
            dirB: input.dirB,
          },
          showConfidenceIntervals: input.showConfidenceIntervals,
        },
      });
      if (queryAChanged) runKeynessTable('a');
      if (queryBChanged) runKeynessTable('b');
    },

  };

  return {
    initial: {
      keynessView: DEFAULT_KEYNESS_VIEW,
      keynessA: null,
      keynessB: null,
      keynessInventoryA: null,
      keynessInventoryB: null,
    } satisfies Pick<AppState, 'keynessView' | 'keynessA' | 'keynessB' | 'keynessInventoryA' | 'keynessInventoryB'>,
    actions,
    /** Return the next view for atomic publication with the session snapshot. */
    reconcileSession(next: SessionState): KeynessViewV1 {
      const readyDocs = next.snapshot?.readyDocs ?? next.project.data.order;
      const currentKeynessView = get().keynessView;
      const activeDocuments = new Set([
        ...next.project.data.order,
        ...next.imports
          .filter((pendingImport) => pendingImport.status !== 'failed')
          .map((pendingImport) => pendingImport.doc),
      ]);
      if (
        pendingKeynessResetDoc !== null
        && !activeDocuments.has(pendingKeynessResetDoc)
      ) {
        pendingKeynessResetDoc = null;
      }
      let keynessView: KeynessViewV1;
      if (restoringCompareDocs !== null && (
        restoringCompareDocs.every((doc) => next.snapshot?.readyDocs.includes(doc))
        || restoringCompareDocs.some((doc) => !activeDocuments.has(doc))
      )) restoringCompareDocs = null;
      if (pendingKeynessResetDoc !== null) {
        if (readyDocs.includes(pendingKeynessResetDoc)) {
          const focus = pendingKeynessResetDoc;
          pendingKeynessResetDoc = null;
          keynessView = {
            ...currentKeynessView,
            mode: readyDocs.length < 2
              ? 'selection-rest'
              : DEFAULT_KEYNESS_VIEW.mode,
            documentA: focus,
            documentB: readyDocs.find((doc) => doc !== focus) ?? null,
            restOn: DEFAULT_KEYNESS_VIEW.restOn,
          };
        } else {
          keynessView = {
            ...currentKeynessView,
            mode: readyDocs.length === 1
              ? 'selection-rest'
              : DEFAULT_KEYNESS_VIEW.mode,
            documentA: null,
            documentB: null,
            restOn: DEFAULT_KEYNESS_VIEW.restOn,
          };
        }
      } else {
        // A cold reopen can publish TXT before HTML/EPUB. That temporary ready
        // subset must not rewrite the saved comparison or its mode. Query scopes
        // still require ready inputs; actual document removal ends this fence.
        keynessView = restoringCompareDocs !== null
          ? currentKeynessView
          : reconcileKeynessView(currentKeynessView, readyDocs);
      }
      return keynessView;
    },
    /** Establish the cold-restore fence before the runtime publishes preferences. */
    restoreView(workspace: WorkspaceV1, liveDocuments: ReadonlySet<string>): KeynessViewV1 {
      pendingKeynessResetDoc = null;
      restoringCompareDocs = workspace.corpus.order.filter((doc) => liveDocuments.has(doc));
      const compare = workspace.views.compare;
      return {
        schema: 'texttrends/keyness-view/1',
        mode: compare.mode,
        documentA: compare.documentA,
        documentB: compare.documentB,
        restOn: compare.restOn,
        minCountTotal: compare.minCountTotal,
        minDocFreqTotal: compare.minDocFreqTotal,
        classes: compare.classes,
        stoplistTopN: compare.stoplistTopN,
        sort: compare.sort,
        showConfidenceIntervals: compare.showConfidenceIntervals,
        pageLimit: compare.pageSize,
      };
    },
    dispose() {
      keynessALane.supersede();
      keynessBLane.supersede();
      keynessInventoryALane.supersede();
      keynessInventoryBLane.supersede();
    },
  };
}
