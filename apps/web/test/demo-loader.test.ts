import { describe, expect, it, vi } from 'vitest';
import { INGEST_CAPS_V0 } from '@texttrends/core';
import type { LoadedDemoCorpus } from '../src/lib/demo-corpora.ts';
import { loadDemoCorpus } from '../src/lib/demo-loader.ts';
import {
  BUILTIN_BIBLE_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_SHERLOCK_ID,
  builtinCorpusOption,
  demoCorpusFixtures,
} from '../src/lib/project.ts';
import type { AppState } from '../src/lib/store.ts';

function harness(fetchCorpus: () => Promise<LoadedDemoCorpus>) {
  const lease = Symbol('demo lease');
  const state = {
    projectSession: null,
    commandError: null,
    clearCommandError: vi.fn(),
    clearActiveInputsAndTerms: vi.fn(() => ({ texts: 2, terms: 3 })),
    importFiles: vi.fn(() => true),
    resetKeynessComparison: vi.fn(),
    mergeStarterTerms: vi.fn(() => ({ added: 1, activated: 1, skipped: 0 })),
  } as unknown as AppState;
  const library = {
    add: vi.fn(async () => []),
    file: vi.fn(),
  };
  const operation = {
    claim: vi.fn(() => lease),
    release: vi.fn(),
    owns: vi.fn(() => true),
  };
  return {
    state,
    library,
    operation,
    dependencies: {
      getState: () => state,
      library,
      operation,
      fetchCorpus: fetchCorpus as typeof import('../src/lib/demo-corpora.ts').fetchDemoCorpus,
    },
    lease,
  };
}

describe('demo loader', () => {
  it('does not clear replacement state when the complete corpus cannot be fetched', async () => {
    const failure = new Error('offline');
    const subject = harness(async () => { throw failure; });

    await expect(loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', subject.dependencies))
      .rejects.toBe(failure);
    expect(subject.state.clearActiveInputsAndTerms).not.toHaveBeenCalled();
    expect(subject.library.add).not.toHaveBeenCalled();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it('clears replacement state only after fetch verification succeeds', async () => {
    let finishFetch!: (corpus: LoadedDemoCorpus) => void;
    const fetched = new Promise<LoadedDemoCorpus>((resolve) => { finishFetch = resolve; });
    const subject = harness(() => fetched);
    const loading = loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', subject.dependencies);

    expect(subject.state.clearActiveInputsAndTerms).not.toHaveBeenCalled();
    finishFetch({ option: builtinCorpusOption(BUILTIN_SHERLOCK_ID)!, files: [] });

    await expect(loading).resolves.toMatchObject({
      label: 'Sherlock Holmes',
      clearedTexts: 2,
      clearedTerms: 3,
    });
    expect(subject.state.clearActiveInputsAndTerms).toHaveBeenCalledOnce();
    expect(subject.library.add).toHaveBeenCalledOnce();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it('rejects an additive sample that cannot fit before downloading or persisting it', async () => {
    const fetchCorpus = vi.fn(async () => ({ option: builtinCorpusOption(BUILTIN_QURAN_ID)!, files: [] }));
    const subject = harness(fetchCorpus);
    const activeCount = INGEST_CAPS_V0.maxDocsPerProject - demoCorpusFixtures(BUILTIN_QURAN_ID).length + 1;
    subject.state.projectSession = {
      project: { data: { docs: Array.from({ length: activeCount }, (_, index) => ({ doc: `active-${index}` })) } },
      imports: [],
    } as unknown as AppState['projectSession'];

    await expect(loadDemoCorpus(BUILTIN_QURAN_ID, 'additive', subject.dependencies))
      .rejects.toThrow(new RegExp(`${INGEST_CAPS_V0.maxDocsPerProject}-document limit`));
    expect(fetchCorpus).not.toHaveBeenCalled();
    expect(subject.library.add).not.toHaveBeenCalled();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it('allows the Bible and Quran demos to be active together', async () => {
    const fetchCorpus = vi.fn(async () => ({ option: builtinCorpusOption(BUILTIN_QURAN_ID)!, files: [] }));
    const subject = harness(fetchCorpus);
    subject.state.projectSession = {
      project: {
        data: {
          docs: demoCorpusFixtures(BUILTIN_BIBLE_ID).map((fixture) => ({ doc: fixture.doc })),
        },
      },
      imports: [],
    } as unknown as AppState['projectSession'];

    await expect(loadDemoCorpus(BUILTIN_QURAN_ID, 'additive', subject.dependencies)).resolves.toMatchObject({
      label: 'Quran — Pickthall translation',
    });
    expect(fetchCorpus).toHaveBeenCalledOnce();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });
});
