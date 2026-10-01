/** Vocabulary and Inventory query ownership. The full-corpus inventory lane
 * remains independent from range queries because it supplies shared geometry.
 * Notebook mutations and cross-slice geometry policy stay in the runtime.
 */
import type { StoreApi } from 'zustand';
import { FREQUENCY_FILTER_MAX_UNITS, STOPLIST_EN_ID, STOPLIST_EN_VERSION, STOPLIST_MAX_TOP_N } from '@texttrends/core';
import type { AppState, InventoryState } from './app-state.ts';
import type { InventoryResultV1, FrequencyListResultV1 } from '../shared/analysis-contract.ts';
import type { OperationScope } from './operation-lease.ts';
import { QueryLane, type QueryIssuer } from './query-lane.ts';
import { INVENTORY_MATTR_WINDOW } from './app-defaults.ts';
import { detailSelection } from './selection.ts';

type VocabularyActions = Pick<AppState,
  'runInventory' | 'runFrequency' | 'loadMoreFrequency' | 'setFrequencySort'
  | 'setFrequencyFilter' | 'setFrequencyStoplistTopN' | 'setFrequencyPage'
>;

interface VocabularyDependencies {
  get: StoreApi<AppState>['getState'];
  set: StoreApi<AppState>['setState'];
  scope: OperationScope;
  issue: QueryIssuer;
  snapshotKey(): string | null;
  /** Merge measured extents and clamped history atomically with inventory. */
  inventoryGeometryPatch(state: AppState, documents: InventoryResultV1['documents']):
    Pick<AppState, 'corpusTokenCounts' | 'positionHistory'>;
  /** Normalize shared trend geometry only after full-corpus evidence lands. */
  onCorpusInventoryReady(): void;
}

export function createVocabularyController({
  get, set, scope, issue: issueOn, snapshotKey,
  inventoryGeometryPatch, onCorpusInventoryReady,
}: VocabularyDependencies) {
  // Vocabulary-wide analytics are independent of notebook query lanes.
  const inventoryLane = new QueryLane(scope);
  // Inputs presents stable, full-text facts. Its baseline query must be able
  // to land even when a rapid range gesture supersedes the vocabulary lane.
  const corpusInventoryLane = new QueryLane(scope);
  const frequencyLane = new QueryLane(scope);
  const actions: VocabularyActions = {
    runInventory() {
      inventoryLane.supersede();
      const { snapshot, linkedSelection, corpusInventory } = get();
      if (!snapshot) {
        corpusInventoryLane.supersede();
        set({ inventory: null, corpusInventory: null });
        return;
      }
      const issuedKey = snapshotKey();
      const issuedSelection = linkedSelection;

      // Full-corpus inventory is a separate resident lane. Clearing a range
      // can reveal the authenticated baseline immediately, and creating a
      // range never cancels a baseline that is still landing.
      if (issuedSelection === null) {
        if (
          corpusInventory?.snapshot === snapshot.snapshot
          && corpusInventory.state.status !== 'error'
        ) {
          set({ inventory: corpusInventory });
          return;
        }
        corpusInventoryLane.supersede();
        const pending: InventoryState = {
          snapshot: snapshot.snapshot,
          selection: null,
          state: { status: 'pending' },
        };
        const lease = corpusInventoryLane.ops.begin(
          () => snapshotKey() === issuedKey,
        );
        set({ inventory: pending, corpusInventory: pending });
        issueOn(
          corpusInventoryLane,
          snapshot.snapshot,
          {
            op: 'inventory',
            selection: { docs: [...snapshot.readyDocs] },
            request: {
              method: 'inventory/2',
              rhythmBinsPerDoc: 0,
              mattrWindow: INVENTORY_MATTR_WINDOW,
            },
          },
          lease,
          (data) => {
            const ready: InventoryState = {
              snapshot: snapshot.snapshot,
              selection: null,
              state: { status: 'ready', result: data.inventory },
            };
            set((state) => ({
              corpusInventory: ready,
              inventory: state.linkedSelection === null ? ready : state.inventory,
              ...inventoryGeometryPatch(state, data.inventory.documents),
            }));
            onCorpusInventoryReady();
          },
          (message) => {
            const error: InventoryState = {
              snapshot: snapshot.snapshot,
              selection: null,
              state: { status: 'error', message },
            };
            set((state) => ({
              corpusInventory: error,
              inventory: state.linkedSelection === null ? error : state.inventory,
            }));
          },
        );
        return;
      }

      const lease = inventoryLane.ops.begin(
        () => snapshotKey() === issuedKey,
        () => get().linkedSelection === issuedSelection,
      );
      set({
        inventory: {
          snapshot: snapshot.snapshot,
          selection: issuedSelection,
          state: { status: 'pending' },
        },
      });
      issueOn(
        inventoryLane,
        snapshot.snapshot,
        {
          op: 'inventory',
          selection: detailSelection(snapshot.readyDocs, issuedSelection),
          request: {
            method: 'inventory/2',
            rhythmBinsPerDoc: 0,
            mattrWindow: INVENTORY_MATTR_WINDOW,
          },
        },
        lease,
        (data) => {
          set((state) => ({
            inventory: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              state: { status: 'ready', result: data.inventory },
            },
            ...inventoryGeometryPatch(state, data.inventory.documents),
          }));
        },
        (message) => set({
          inventory: {
            snapshot: snapshot.snapshot,
            selection: issuedSelection,
            state: { status: 'error', message },
          },
        }),
      );
    },

    runFrequency(retainResident = false) {
      frequencyLane.supersede();
      const {
        snapshot,
        linkedSelection,
        frequencyView,
        frequency: currentFrequency,
      } = get();
      if (!snapshot) {
        set({ frequency: null });
        return;
      }
      const issuedKey = snapshotKey();
      const issuedSelection = linkedSelection;
      const issuedView = frequencyView;
      const resident = retainResident
        && currentFrequency?.snapshot === snapshot.snapshot
        && currentFrequency.selection === issuedSelection
        ? currentFrequency.resident
          ?? (currentFrequency.state.status === 'ready'
            ? currentFrequency.state.result
            : null)
        : null;
      const lease = frequencyLane.ops.begin(
        () => snapshotKey() === issuedKey,
        () => get().linkedSelection === issuedSelection,
        () => get().frequencyView === issuedView,
      );
      set({
        frequency: {
          snapshot: snapshot.snapshot,
          selection: issuedSelection,
          view: issuedView,
          resident,
          state: { status: 'pending' },
        },
      });
      issueOn(
        frequencyLane,
        snapshot.snapshot,
        {
          op: 'freq-list',
          selection: detailSelection(snapshot.readyDocs, issuedSelection),
          request: {
            method: 'freq-list/2',
            filter: {
              minCount: issuedView.minCount,
              minDocFreq: issuedView.minDocFreq,
              classes: issuedView.classes,
              ...(issuedView.stoplistTopN === 0 ? {} : {
                stoplist: {
                  id: STOPLIST_EN_ID,
                  version: STOPLIST_EN_VERSION,
                  topN: issuedView.stoplistTopN,
                },
              }),
              ...(issuedView.filter === undefined
                ? {}
                : { text: issuedView.filter }),
            },
            sort: issuedView.sort,
            page: issuedView.page,
            dispersion: true,
          },
        },
        lease,
        (data) => {
          set({
            frequency: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              view: issuedView,
              resident: data.frequency,
              state: { status: 'ready', result: data.frequency },
            },
          });
        },
        (message) => set({
          frequency: {
            snapshot: snapshot.snapshot,
            selection: issuedSelection,
            view: issuedView,
            resident: null,
            state: { status: 'error', message },
          },
        }),
      );
    },

    loadMoreFrequency() {
      const { snapshot, linkedSelection, frequencyView, frequency } = get();
      const resident = frequency?.resident
        ?? (frequency?.state.status === 'ready' ? frequency.state.result : null);
      if (
        !snapshot
        || resident === null
        || frequency?.state.status !== 'ready'
        || resident.rows.length >= resident.total
      ) {
        return;
      }
      const issuedKey = snapshotKey();
      const issuedSelection = linkedSelection;
      const issuedView = frequencyView;
      const offset = issuedView.page.offset + resident.rows.length;
      const limit = Math.min(
        issuedView.page.limit,
        resident.total - resident.rows.length,
      );
      if (!Number.isSafeInteger(offset + limit) || limit < 1) return;

      frequencyLane.supersede();
      const lease = frequencyLane.ops.begin(
        () => snapshotKey() === issuedKey,
        () => get().linkedSelection === issuedSelection,
        () => get().frequencyView === issuedView,
      );
      set({
        frequency: {
          snapshot: snapshot.snapshot,
          selection: issuedSelection,
          view: issuedView,
          resident,
          state: { status: 'pending' },
        },
      });
      issueOn(
        frequencyLane,
        snapshot.snapshot,
        {
          op: 'freq-list',
          selection: detailSelection(snapshot.readyDocs, issuedSelection),
          request: {
            method: 'freq-list/2',
            filter: {
              minCount: issuedView.minCount,
              minDocFreq: issuedView.minDocFreq,
              classes: issuedView.classes,
              ...(issuedView.stoplistTopN === 0 ? {} : {
                stoplist: {
                  id: STOPLIST_EN_ID,
                  version: STOPLIST_EN_VERSION,
                  topN: issuedView.stoplistTopN,
                },
              }),
              ...(issuedView.filter === undefined
                ? {}
                : { text: issuedView.filter }),
            },
            sort: issuedView.sort,
            page: { offset, limit },
            dispersion: true,
          },
        },
        lease,
        (data) => {
          const next = data.frequency;
          if (
            next.total !== resident.total
            || next.totalTokens !== resident.totalTokens
            || next.parts !== resident.parts
            || next.selection !== resident.selection
            || (next.rows.length === 0 && resident.rows.length < resident.total)
          ) {
            set({
              frequency: {
                snapshot: snapshot.snapshot,
                selection: issuedSelection,
                view: issuedView,
                resident,
                state: {
                  status: 'error',
                  message: 'Vocabulary changed while more rows were loading. Refresh the view to continue.',
                },
              },
            });
            return;
          }
          const result: FrequencyListResultV1 = {
            ...next,
            rows: [...resident.rows, ...next.rows],
          };
          set({
            frequency: {
              snapshot: snapshot.snapshot,
              selection: issuedSelection,
              view: issuedView,
              resident: result,
              state: { status: 'ready', result },
            },
          });
        },
        (message) => set({
          frequency: {
            snapshot: snapshot.snapshot,
            selection: issuedSelection,
            view: issuedView,
            resident,
            state: { status: 'error', message },
          },
        }),
      );
    },

    setFrequencySort(by) {
      const current = get().frequencyView;
      const dir = current.sort.by === by
        ? (current.sort.dir === 1 ? -1 : 1)
        : (by === 'key' || by === 'class' ? 1 : -1);
      set({
        frequencyView: {
          ...current,
          sort: { by, dir },
          page: { ...current.page, offset: 0 },
        },
      });
      get().runFrequency();
    },

    setFrequencyFilter(filter) {
      const normalized = filter?.query.normalize('NFC') ?? '';
      if (normalized.length > FREQUENCY_FILTER_MAX_UNITS) return;
      if (filter?.mode === 'regex' && normalized !== '') {
        try {
          new RegExp(normalized, 'u');
        } catch {
          return;
        }
      }
      const current = get().frequencyView;
      const nextFilter = filter === null || normalized === ''
        ? undefined
        : { mode: filter.mode, query: normalized } as const;
      if (
        current.filter?.mode === nextFilter?.mode
        && current.filter?.query === nextFilter?.query
      ) return;
      const { filter: _oldFilter, ...withoutFilter } = current;
      set({
        frequencyView: nextFilter === undefined
          ? {
              ...withoutFilter,
              page: { ...current.page, offset: 0 },
            }
          : {
              ...current,
              filter: nextFilter,
              page: { ...current.page, offset: 0 },
            },
      });
      get().runFrequency(true);
    },

    setFrequencyStoplistTopN(topN) {
      if (
        !Number.isSafeInteger(topN)
        || topN < 0
        || topN > STOPLIST_MAX_TOP_N
      ) {
        return;
      }
      const current = get().frequencyView;
      if (current.stoplistTopN === topN) return;
      set({
        frequencyView: {
          ...current,
          stoplistTopN: topN,
          page: { ...current.page, offset: 0 },
        },
      });
      get().runFrequency(true);
    },

    setFrequencyPage(offset) {
      const current = get().frequencyView;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(offset + current.page.limit)
      ) {
        return;
      }
      set({
        frequencyView: {
          ...current,
          page: { ...current.page, offset },
        },
      });
      get().runFrequency();
    },

  };

  return {
    initial: {
      inventory: null,
      corpusInventory: null,
      frequencyView: {
        schema: 'texttrends/frequency-view/2',
        minCount: 1,
        minDocFreq: 1,
        classes: ['lexical'],
        stoplistTopN: 0,
        sort: { by: 'count', dir: -1 },
        page: { offset: 0, limit: 100 },
      },
      frequency: null,
    } satisfies Pick<AppState, 'inventory' | 'corpusInventory' | 'frequencyView' | 'frequency'>,
    actions,
    dispose() {
      inventoryLane.supersede();
      corpusInventoryLane.supersede();
      frequencyLane.supersede();
    },
  };
}
