import { describe, expect, it, vi } from 'vitest';
import { INGEST_CAPS_V0 } from '@texttrends/core';
import type { LoadedDemoCorpus } from '../src/lib/demo-corpora.ts';
import { demoLoadNotice, loadDemoCorpus } from '../src/lib/demo-loader.ts';
import {
  BUILTIN_BIBLE_ID,
  BUILTIN_QURAN_ID,
  BUILTIN_SHERLOCK_ID,
  builtinCorpusOption,
  demoCorpusFixtures,
} from '../src/lib/project.ts';
import type { AppState } from '../src/lib/app-state.ts';

function harness(fetchCorpus: () => Promise<LoadedDemoCorpus>) {
  const lease = Symbol('demo lease');
  const state = {
    projectSession: null,
    commandError: null,
    clearCommandError: vi.fn(),
    replaceInputsAndTerms: vi.fn(() => ({ texts: 2, terms: 3 })),
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
  it('asks against current state after acquisition and preserves it when replacement is declined', async () => {
    let finishFetch!: (corpus: LoadedDemoCorpus) => void;
    const fetched = new Promise<LoadedDemoCorpus>((resolve) => { finishFetch = resolve; });
    const subject = harness(() => fetched);
    const confirmReplacement = vi.fn((state: AppState) => {
      expect(state.notebook.groups).toEqual([{ id: 'authored-during-download' }]);
      return false;
    });
    const loading = loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', {
      ...subject.dependencies, confirmReplacement,
    });
    expect(confirmReplacement).not.toHaveBeenCalled();
    subject.state.notebook = { groups: [{ id: 'authored-during-download' }] } as unknown as AppState['notebook'];
    finishFetch({ option: builtinCorpusOption(BUILTIN_SHERLOCK_ID)!, files: [] });
    const result = await loading;
    expect(result).toMatchObject({ cancelled: true, clearedTexts: 0, clearedTerms: 0 });
    expect(demoLoadNotice(result, 'replace')).toContain('Your workspace was kept.');
    expect(confirmReplacement).toHaveBeenCalledOnce();
    expect(subject.state.replaceInputsAndTerms).not.toHaveBeenCalled();
    expect(subject.state.resetKeynessComparison).not.toHaveBeenCalled();
    expect(subject.state.mergeStarterTerms).not.toHaveBeenCalled();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it('does not clear replacement state when the complete corpus cannot be fetched', async () => {
    const failure = new Error('offline');
    const subject = harness(async () => { throw failure; });

    await expect(loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', subject.dependencies))
      .rejects.toBe(failure);
    expect(subject.state.replaceInputsAndTerms).not.toHaveBeenCalled();
    expect(subject.library.add).not.toHaveBeenCalled();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it('clears replacement state only after fetch verification succeeds', async () => {
    let finishFetch!: (corpus: LoadedDemoCorpus) => void;
    const fetched = new Promise<LoadedDemoCorpus>((resolve) => { finishFetch = resolve; });
    const subject = harness(() => fetched);
    const loading = loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', subject.dependencies);

    expect(subject.state.replaceInputsAndTerms).not.toHaveBeenCalled();
    finishFetch({ option: builtinCorpusOption(BUILTIN_SHERLOCK_ID)!, files: [] });

    await expect(loading).resolves.toMatchObject({
      label: 'Sherlock Holmes',
      clearedTexts: 2,
      clearedTerms: 3,
    });
    expect(subject.state.replaceInputsAndTerms).toHaveBeenCalledOnce();
    expect(subject.library.add).toHaveBeenCalledOnce();
    expect(subject.operation.release).toHaveBeenCalledWith(subject.lease);
  });

  it.each(['save', 'read', 'activation'])('preserves replacement state on %s failure', async (phase) => {
    const subject = harness(async () => ({ option: builtinCorpusOption(BUILTIN_SHERLOCK_ID)!, files: [] }));
    const failure = new Error('quota or read failure');
    if (phase === 'save') subject.library.add.mockRejectedValue(failure);
    if (phase === 'read') {
      subject.library.add.mockResolvedValue([{ item: { id: 'saved' }, added: true }] as never);
      subject.library.file.mockRejectedValue(failure);
    }
    if (phase === 'activation') vi.mocked(subject.state.replaceInputsAndTerms).mockReturnValue(null);
    await expect(loadDemoCorpus(BUILTIN_SHERLOCK_ID, 'replace', subject.dependencies)).rejects.toThrow();
    if (phase !== 'activation') expect(subject.state.replaceInputsAndTerms).not.toHaveBeenCalled();
    expect(subject.state.mergeStarterTerms).not.toHaveBeenCalled();
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
