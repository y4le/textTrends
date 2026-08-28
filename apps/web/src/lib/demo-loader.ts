import { INGEST_CAPS_V0 } from '@texttrends/core';
import { fetchDemoCorpus } from './demo-corpora.ts';
import { libraryOperation } from './library-operation.ts';
import {
  localLibrary,
  localFileIdentity,
  type LocalLibraryAddResult,
  type LocalLibraryFile,
} from './local-library.ts';
import { demoCorpusFixtures, type BuiltinCorpusId } from './project.ts';
import type { AppState } from './store.ts';

export const LIBRARY_BUSY_NOTICE = 'Another input is being saved. Try again when it finishes.';

export type DemoLoadMode = 'additive' | 'replace';

export interface DemoLoadResult {
  readonly label: string;
  readonly saved: number;
  readonly alreadySaved: number;
  readonly activated: number;
  readonly alreadyActive: number;
  readonly termsAdded: number;
  readonly termsActivated: number;
  readonly termsSkipped: number;
  readonly clearedTexts: number;
  readonly clearedTerms: number;
}

interface DemoLibraryPort {
  add(files: Parameters<typeof localLibrary.add>[0]): Promise<readonly LocalLibraryAddResult[]>;
  file(id: string): Promise<LocalLibraryFile>;
}

interface DemoOperationPort {
  claim(): symbol | null;
  release(lease: symbol): void;
  owns(lease: symbol): boolean;
}

export interface DemoLoaderDependencies {
  readonly getState: () => AppState;
  readonly library?: DemoLibraryPort;
  readonly operation?: DemoOperationPort;
  readonly fetchCorpus?: typeof fetchDemoCorpus;
}

function activeLibraryIds(state: AppState): ReadonlySet<string> {
  const session = state.projectSession;
  if (session === null) return new Set();
  return new Set([
    ...session.project.data.docs.flatMap((doc) => doc.library === undefined ? [] : [doc.library]),
    ...session.imports.map((item) => item.library),
  ]);
}

function assertAdditiveDemoFits(id: BuiltinCorpusId, state: AppState): void {
  const session = state.projectSession;
  const activeInputs = session === null ? 0 : session.project.data.docs.length + session.imports.length;
  const active = activeLibraryIds(state);
  const additions = demoCorpusFixtures(id).filter((fixture) => (
    !active.has(localFileIdentity('txt', fixture.sourceHash))
  )).length;
  if (activeInputs + additions > INGEST_CAPS_V0.maxDocsPerProject) {
    throw new Error(`Adding this sample would exceed the ${INGEST_CAPS_V0.maxDocsPerProject}-document limit. Clear active inputs first, or open the sample from its demo URL to replace the current corpus.`);
  }
}

function firstActivatedDocument(
  state: AppState,
  acquired: readonly LocalLibraryAddResult[],
): string | null {
  const first = acquired[0]?.item.id;
  if (first === undefined || state.projectSession === null) return null;
  return state.projectSession.project.data.docs.find((doc) => doc.library === first)?.doc
    ?? state.projectSession.imports.find((item) => item.library === first)?.doc
    ?? null;
}

/** One acquisition authority for Inputs, Debug, and one-shot URL presets.
 * Replacement clears active research state only after the complete demo has
 * been fetched and verified, and never deletes reusable source bytes from the
 * local library. */
export async function loadDemoCorpus(
  id: BuiltinCorpusId,
  mode: DemoLoadMode,
  dependencies: DemoLoaderDependencies,
  signal?: AbortSignal,
): Promise<DemoLoadResult> {
  const library = dependencies.library ?? localLibrary;
  const operation = dependencies.operation ?? libraryOperation;
  const fetchCorpus = dependencies.fetchCorpus ?? fetchDemoCorpus;
  const lease = operation.claim();
  if (lease === null) throw new Error(LIBRARY_BUSY_NOTICE);

  let clearedTexts = 0;
  let clearedTerms = 0;
  try {
    if (mode === 'additive') assertAdditiveDemoFits(id, dependencies.getState());
    const demo = await fetchCorpus(id, signal);
    if (!operation.owns(lease)) throw new Error('The demo load was superseded.');

    if (mode === 'replace') {
      dependencies.getState().clearCommandError();
      const cleared = dependencies.getState().clearActiveInputsAndTerms();
      clearedTexts = cleared.texts;
      clearedTerms = cleared.terms;
      const refusal = dependencies.getState().commandError;
      if (refusal !== null) throw new Error(refusal);
    }

    const saved = await library.add(demo.files);
    if (!operation.owns(lease)) throw new Error('The demo load was superseded.');

    const active = mode === 'replace' ? new Set<string>() : activeLibraryIds(dependencies.getState());
    const acquired = saved.filter((result) => !active.has(result.item.id));
    const files = await Promise.all(acquired.map((result) => library.file(result.item.id)));
    if (!operation.owns(lease)) throw new Error('The demo load was superseded.');
    if (files.length > 0 && !dependencies.getState().importFiles(files)) {
      throw new Error(dependencies.getState().commandError ?? 'The demo texts could not be activated.');
    }

    const state = dependencies.getState();
    const firstDocument = firstActivatedDocument(state, acquired);
    if (firstDocument !== null) state.resetKeynessComparison(firstDocument);
    const terms = state.mergeStarterTerms(demo.option.defaultTerms);
    return {
      label: demo.option.label,
      saved: saved.filter((result) => result.added).length,
      alreadySaved: saved.filter((result) => !result.added).length,
      activated: acquired.length,
      alreadyActive: saved.length - acquired.length,
      termsAdded: terms.added,
      termsActivated: terms.activated,
      termsSkipped: terms.skipped,
      clearedTexts,
      clearedTerms,
    };
  } finally {
    operation.release(lease);
  }
}

export function demoLoadNotice(result: DemoLoadResult, mode: DemoLoadMode): string {
  const parts = mode === 'replace'
    ? [`Cleared ${result.clearedTexts} text${result.clearedTexts === 1 ? '' : 's'} and ${result.clearedTerms} term${result.clearedTerms === 1 ? '' : 's'}.`]
    : [];
  parts.push(
    result.activated === 0
      ? 'No new texts were activated.'
      : `${result.activated} local text${result.activated === 1 ? '' : 's'} activated.`,
  );
  if (result.alreadyActive > 0) parts.push(`${result.alreadyActive} already active.`);
  parts.push(
    result.termsAdded === 0
      ? 'Starter terms were already present or the notebook is full.'
      : `${result.termsAdded} starter term${result.termsAdded === 1 ? '' : 's'} added${result.termsActivated < result.termsAdded ? `; ${result.termsActivated} activated` : ''}.`,
  );
  return `${result.label}: ${parts.join(' ')}`;
}
