import { fingerprint } from '@texttrends/core';
import { workerProtocolVersion, type WorkerClientDiagnostics } from './client.ts';
import { LOCAL_LIBRARY_DB_NAME, LOCAL_LIBRARY_DB_VERSION, localLibrary } from './local-library.ts';
import type { Presentation } from './presentation.ts';
import type { AppState } from './store.ts';
import { ARTIFACT_DB_NAME, ARTIFACT_DB_VERSION } from '../shared/storage-schema.ts';

type LaneStatus = 'absent' | 'pending' | 'ready' | 'edge' | 'error';

export interface DebugDiagnostics {
  readonly schema: 'texttrends/debug-diagnostics/1';
  readonly generatedAt: string;
  readonly build: {
    readonly mode: string;
    readonly commit: string | null;
    readonly protocol: number;
    readonly baseUrl: string;
  };
  readonly worker: WorkerClientDiagnostics;
  readonly workspace: {
    readonly bootstrap: AppState['bootstrap']['phase'];
    readonly analysis: string;
    readonly persistence: AppState['workspacePersistence']['phase'];
    readonly projectKind: 'library' | 'builtin' | 'none';
    readonly activeDocuments: number;
    readonly pendingImports: number;
    readonly generation: string | null;
    readonly snapshot: string | null;
    readonly readyDocuments: number;
    readonly missingDocuments: number;
    readonly documentTokenCounts: readonly number[];
    readonly pendingImportStates: Readonly<Record<string, number>>;
    readonly route: {
      readonly place: AppState['place'];
      readonly status: AppState['routeStatus'];
      readonly layers: readonly string[];
    };
  };
  readonly recipes: {
    readonly index: readonly string[];
    readonly extraction: readonly string[];
    readonly segmenters: readonly {
      readonly locale: string;
      readonly adapter: string;
      readonly adapterVersion: string;
      readonly probeHash: string;
    }[];
    readonly extractionDiagnostics: {
      readonly documents: number;
      readonly decoderReplacements: number;
      readonly suspiciousControls: number;
    };
  };
  readonly lanes: Readonly<Record<string, LaneStatus | Readonly<Record<LaneStatus, number>>>>;
  readonly storage: {
    readonly localLibrary: { readonly files: number; readonly bytes: number };
    readonly estimate: {
      readonly usage: number | null;
      readonly quota: number | null;
      readonly persisted: boolean | null;
    };
    readonly databases: readonly {
      readonly name: string;
      readonly version: number;
      readonly disposable: boolean;
    }[];
  };
  readonly presentation: Presentation & {
    readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number };
  };
}

interface StateWrapper {
  readonly state: { readonly status: 'pending' | 'ready' | 'edge' | 'error' };
}

function lane(value: StateWrapper | null | undefined): LaneStatus {
  return value?.state.status ?? 'absent';
}

function mapLanes(values: ReadonlyMap<string, { readonly status: 'pending' | 'ready' | 'error' }>): Readonly<Record<LaneStatus, number>> {
  const counts: Record<LaneStatus, number> = { absent: 0, pending: 0, ready: 0, edge: 0, error: 0 };
  if (values.size === 0) counts.absent = 1;
  for (const value of values.values()) counts[value.status]++;
  return counts;
}

export async function collectDebugDiagnostics(
  state: AppState,
  presentation: Presentation,
  worker: WorkerClientDiagnostics,
): Promise<DebugDiagnostics> {
  const session = state.projectSession;
  const documents = session?.project.data.docs ?? [];
  const extractionDiagnostics = Object.values(session?.extractionDiagnostics ?? {});
  const languages = [...new Set(documents.map((doc) => doc.meta.language))].sort();
  const [library, estimate, persisted, segmenters] = await Promise.all([
    localLibrary.list(),
    navigator.storage?.estimate?.().catch((): StorageEstimate => ({}))
      ?? Promise.resolve<StorageEstimate>({}),
    navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
    Promise.all(languages.map(async (language) => {
      const value = await fingerprint(language);
      return {
        locale: value.locale,
        adapter: value.adapter,
        adapterVersion: value.adapterVersion,
        probeHash: value.probeHash,
      };
    })),
  ]);
  return {
    schema: 'texttrends/debug-diagnostics/1',
    generatedAt: new Date().toISOString(),
    build: {
      mode: __TT_BUILD__.mode,
      commit: __TT_BUILD__.commit,
      protocol: workerProtocolVersion,
      baseUrl: import.meta.env.BASE_URL ?? '/',
    },
    worker,
    workspace: {
      bootstrap: state.bootstrap.phase,
      analysis: session?.analysis.phase ?? 'none',
      persistence: state.workspacePersistence.phase,
      projectKind: session?.project.kind ?? 'none',
      activeDocuments: session?.project.data.order.length ?? 0,
      pendingImports: session?.imports.length ?? 0,
      generation: state.snapshot?.generation ?? null,
      snapshot: state.snapshot?.snapshot ?? null,
      readyDocuments: state.snapshot?.readyDocs.length ?? 0,
      missingDocuments: state.snapshot?.missingDocs.length ?? 0,
      documentTokenCounts: (session?.project.data.order ?? []).map((doc) => state.corpusTokenCounts.get(doc) ?? 0),
      pendingImportStates: (session?.imports ?? []).reduce<Record<string, number>>((counts, item) => {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        return counts;
      }, {}),
      route: {
        place: state.place,
        status: state.routeStatus,
        layers: state.layers.map((layer) => layer.kind),
      },
    },
    recipes: {
      index: session === null ? [] : [session.project.data.indexRecipeHash],
      extraction: [...new Set(documents.map((doc) => doc.extraction.recipeHash))].sort(),
      segmenters,
      extractionDiagnostics: {
        documents: extractionDiagnostics.length,
        decoderReplacements: extractionDiagnostics.reduce((sum, value) => sum + value.decoderReplacementCount, 0),
        suspiciousControls: extractionDiagnostics.reduce((sum, value) => sum + value.suspiciousControlCount, 0),
      },
    },
    lanes: {
      trends: mapLanes(state.trends),
      selectedTrends: mapLanes(state.selectedTrends),
      matches: lane(state.kwic),
      dispersion: lane(state.dispersion),
      selectedDispersion: lane(state.selectedDispersion),
      inventory: lane(state.inventory),
      corpusInventory: lane(state.corpusInventory),
      frequency: lane(state.frequency),
      keynessA: lane(state.keynessA),
      keynessB: lane(state.keynessB),
      keynessInventoryA: lane(state.keynessInventoryA),
      keynessInventoryB: lane(state.keynessInventoryB),
      footerPassage: lane(state.footerPassage),
      reader: lane(state.readerPage),
      occurrenceNavigation: lane(state.occurrenceNavigation),
    },
    storage: {
      localLibrary: {
        files: library.length,
        bytes: library.reduce((sum, item) => sum + item.size, 0),
      },
      estimate: {
        usage: typeof estimate.usage === 'number' ? estimate.usage : null,
        quota: typeof estimate.quota === 'number' ? estimate.quota : null,
        persisted,
      },
      databases: [
        { name: LOCAL_LIBRARY_DB_NAME, version: LOCAL_LIBRARY_DB_VERSION, disposable: false },
        { name: ARTIFACT_DB_NAME, version: ARTIFACT_DB_VERSION, disposable: true },
      ],
    },
    presentation: {
      ...presentation,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    },
  };
}
