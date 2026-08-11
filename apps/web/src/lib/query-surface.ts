import type { Place } from './places.ts';
import {
  notebookRows,
  type NotebookRowVM,
} from './notebook-view.ts';
import type { NotebookGroupV1 } from './notebook.ts';
import type { SeriesTrendState } from './store.ts';

export type QueryEditorTarget =
  | {
      readonly surface: 'query-editor';
      readonly mode: 'manage';
      readonly groupId?: string;
      readonly create?: boolean;
    };

export interface QuerySurfaceVM {
  readonly usesQueryEncoding: boolean;
  readonly rows: readonly NotebookRowVM[];
}

export function termFocusControlId(groupId: string): string {
  return `term-focus-${encodeURIComponent(groupId)}`;
}

/** Only places whose visible marks carry series encodings own a compact key. */
export function placeUsesQueryEncoding(place: Place): boolean {
  return place === 'trends' || place === 'concordance';
}

/**
 * Total parser for the presentation-only layer target. Browser history keeps
 * only its opaque layer id; this richer target remains in the store registry.
 */
export function queryEditorTarget(value: unknown): QueryEditorTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.surface !== 'query-editor') return null;
  if (candidate.mode === 'manage') {
    return {
      surface: 'query-editor',
      mode: 'manage',
      ...(typeof candidate.groupId === 'string' && candidate.groupId !== ''
        ? { groupId: candidate.groupId }
        : {}),
      ...(candidate.create === true ? { create: true } : {}),
    };
  }
  return null;
}

/**
 * One view-model authority feeds both the rail and the compact key. Counts
 * continue to come from notebookRows, so responsive composition cannot
 * reinterpret pending, selected, partial, or zero-hit results.
 */
export function querySurfaceView(args: {
  readonly place: Place;
  readonly groups: readonly NotebookGroupV1[];
  readonly activeGroupIds: ReadonlySet<string>;
  readonly soloGroupId: string | null;
  readonly styleSlots: ReadonlyMap<string, number>;
  readonly trends: ReadonlyMap<string, SeriesTrendState>;
  readonly selectedTrends?: ReadonlyMap<string, SeriesTrendState>;
  readonly hasSelection?: boolean;
  readonly hasSnapshot: boolean;
  readonly partialCorpus: boolean;
}): QuerySurfaceVM {
  return {
    usesQueryEncoding: placeUsesQueryEncoding(args.place),
    rows: notebookRows(args),
  };
}
