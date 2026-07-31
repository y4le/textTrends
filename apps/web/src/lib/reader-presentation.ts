import type { WidthClass } from './presentation.ts';

export const READER_MODES = ['peek', 'study', 'full'] as const;
export type ReaderMode = (typeof READER_MODES)[number];

export const DEFAULT_READER_MODE: ReaderMode = 'study';

export interface ReaderComposition {
  readonly open: boolean;
  /** The layer-bound preference. A width transform never rewrites it. */
  readonly requested: ReaderMode;
  /** The presentation this width can honestly render. */
  readonly mode: ReaderMode;
  readonly slot: 'evidence' | 'place' | 'workbench' | 'viewport' | null;
  readonly showScope: boolean;
  readonly showLens: boolean;
  readonly showQuery: boolean;
  readonly showPlace: boolean;
  readonly showEvidence: boolean;
  readonly showMethod: boolean;
  readonly modeControls: boolean;
  readonly dockPages: boolean;
}

const modeSet = new Set<string>(READER_MODES);

export function readerMode(value: unknown): ReaderMode {
  return typeof value === 'string' && modeSet.has(value)
    ? value as ReaderMode
    : DEFAULT_READER_MODE;
}

export function readerComposition(
  width: WidthClass,
  open: boolean,
  requested: ReaderMode,
): ReaderComposition {
  if (!open) {
    return {
      open: false,
      requested,
      mode: requested,
      slot: null,
      showScope: true,
      showLens: true,
      showQuery: true,
      showPlace: true,
      showEvidence: true,
      showMethod: true,
      modeControls: false,
      dockPages: false,
    };
  }

  if (width === 'compact') {
    return {
      open: true,
      requested,
      mode: 'full',
      slot: 'viewport',
      showScope: false,
      showLens: false,
      showQuery: false,
      showPlace: false,
      showEvidence: false,
      showMethod: false,
      modeControls: false,
      dockPages: true,
    };
  }

  const mode = width === 'regular' && requested === 'peek'
    ? 'study'
    : requested;
  return {
    open: true,
    requested,
    mode,
    slot: mode === 'peek'
      ? 'evidence'
      : mode === 'study'
        ? 'place'
        : 'workbench',
    showScope: true,
    showLens: true,
    showQuery: true,
    showPlace: mode === 'peek',
    showEvidence: mode === 'study',
    showMethod: true,
    modeControls: true,
    dockPages: false,
  };
}
