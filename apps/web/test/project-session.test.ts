import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_INDEX_RECIPE, type SourceDescriptorV1 } from '@texttrends/core';
import { canonicalRecipeHashes } from './support/spec-fixtures.ts';
import type { GenerationDocSpecV4 } from '../src/shared/analysis-contract.ts';
import type {
  GenerationReady,
  IngestProgress,
  SnapshotInfo,
  SourceReadyInfo,
} from '../src/lib/client.ts';
import type { LocalLibraryFile } from '../src/lib/local-library.ts';
import {
  ProjectSession,
  type ProjectSessionClient,
  type ProjectSessionDeps,
  type SessionState,
} from '../src/lib/project-session.ts';
import type { ProjectDataV1 } from '../src/lib/project.ts';

let TXT_HASH = '';
let INDEX_HASH = '';
beforeAll(async () => {
  const hashes = await canonicalRecipeHashes();
  TXT_HASH = hashes.txtRecipeHash;
  INDEX_HASH = hashes.indexRecipeHash;
});

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface OpenEntry {
  readonly generation: string;
  readonly docs: readonly GenerationDocSpecV4[];
  readonly resolve: (result: GenerationReady) => void;
  cancelled: boolean;
}

class FakeClient implements ProjectSessionClient {
  private snapshotListener: ((info: SnapshotInfo) => void) | null = null;
  private ingestErrorListener: ((generation: string, message: string, doc?: string) => void) | null = null;
  private sourceReadyListener: ((info: SourceReadyInfo) => void) | null = null;
  private restartListener: ((fatal: boolean) => void) | null = null;
  readonly opens: OpenEntry[] = [];
  readonly ingests: { generation: string; doc: string; bytes: ArrayBuffer; job: number }[] = [];
  private job = 0;

  onSnapshot(listener: (info: SnapshotInfo) => void): void { this.snapshotListener = listener; }
  onProgress(_listener: (progress: IngestProgress) => void): void {}
  onIngestError(listener: (generation: string, message: string, doc?: string) => void): void { this.ingestErrorListener = listener; }
  onSourceReady(listener: (info: SourceReadyInfo) => void): void { this.sourceReadyListener = listener; }
  onRestart(listener: (fatal: boolean) => void): void { this.restartListener = listener; }
  openGeneration(generation: string, docs: readonly GenerationDocSpecV4[]): { result: Promise<GenerationReady>; cancel: () => void } {
    let resolve!: (result: GenerationReady) => void;
    const result = new Promise<GenerationReady>((done) => { resolve = done; });
    const entry: OpenEntry = { generation, docs, resolve, cancelled: false };
    this.opens.push(entry);
    return { result, cancel: () => { entry.cancelled = true; } };
  }
  ingest(generation: string, doc: string, bytes: ArrayBuffer): { job: number } {
    const job = ++this.job;
    this.ingests.push({ generation, doc, bytes, job });
    return { job };
  }
  lastOpen(): OpenEntry { return this.opens[this.opens.length - 1]!; }
  jobFor(generation: string, doc: string): number {
    const ingest = [...this.ingests].reverse().find((entry) => entry.generation === generation && entry.doc === doc);
    if (ingest === undefined) throw new Error(`no ingest for ${doc}`);
    return ingest.job;
  }
  snapshot(info: SnapshotInfo): void { this.snapshotListener?.(info); }
  sourceReady(info: SourceReadyInfo): void { this.sourceReadyListener?.(info); }
  ingestError(generation: string, message: string, doc?: string): void { this.ingestErrorListener?.(generation, message, doc); }
  restart(fatal: boolean): void { this.restartListener?.(fatal); }
}

const hashFor = (seed: string): string => seed.repeat(64).slice(0, 64);

function libraryFile(name: string, size: number, seed: string): LocalLibraryFile & { reads: number } {
  const contentHash = hashFor(seed);
  const file: LocalLibraryFile & { reads: number } = {
    name,
    size,
    type: 'text/plain',
    lastModified: 0,
    format: 'txt',
    contentHash,
    library: `txt:${contentHash}`,
    reads: 0,
    async arrayBuffer() {
      file.reads += 1;
      return new ArrayBuffer(size);
    },
  };
  return file;
}

function emptyProject(): ProjectDataV1 {
  return {
    id: 'library',
    order: [],
    docs: [],
    indexRecipe: DEFAULT_INDEX_RECIPE,
    indexRecipeHash: INDEX_HASH,
  };
}

function makeSession(initial: ProjectDataV1, files: readonly LocalLibraryFile[] = [], overrides: Partial<ProjectSessionDeps> = {}) {
  const client = new FakeClient();
  const byId = new Map(files.map((file) => [file.library, file]));
  let id = 0;
  const session = new ProjectSession(initial, {
    client,
    libraryFiles: {
      async get(library) {
        const file = byId.get(library);
        if (file === undefined) throw new Error('missing library source');
        return file;
      },
    },
    newDocId: () => `doc-${++id}`,
    ...overrides,
  });
  const states: SessionState[] = [];
  session.subscribe((state) => states.push(state));
  return { session, client, states };
}

function readyInfo(generation: string, doc: string, job: number, file: LocalLibraryFile): SourceReadyInfo {
  const source: SourceDescriptorV1 = {
    kind: 'text',
    hash: file.contentHash,
    byteLength: file.size,
    format: 'txt',
    encoding: { detected: 'utf-8', hadReplacementChars: false },
  };
  return {
    job,
    generation,
    doc,
    source,
    extractionRecipeHash: TXT_HASH,
    text: hashFor('t'),
    textLengthUtf16: 5,
    decoderReplacementCount: 0,
    suspiciousControlCount: 0,
  };
}

async function prepareImport(session: ProjectSession, client: FakeClient, files: readonly LocalLibraryFile[]) {
  session.appendFiles(files);
  await settle();
  const open = client.lastOpen();
  open.resolve({
    generation: open.generation,
    snapshot: null,
    readyDocs: [],
    missingDocs: open.docs.map((doc) => doc.doc),
  });
  await settle();
  return { open, docs: open.docs.map((doc) => doc.doc) };
}

async function finalizeImport(session: ProjectSession, client: FakeClient, files: readonly LocalLibraryFile[]) {
  const prepared = await prepareImport(session, client, files);
  for (let index = 0; index < prepared.docs.length; index += 1) {
    const doc = prepared.docs[index]!;
    client.sourceReady(readyInfo(prepared.open.generation, doc, client.jobFor(prepared.open.generation, doc), files[index]!));
  }
  client.snapshot({ generation: prepared.open.generation, snapshot: 'snapshot', readyDocs: prepared.docs, missingDocs: [] });
  await settle();
  return prepared;
}

describe('generation and source resolution', () => {
  it('settles an emptied library generation without waiting for a snapshot event', async () => {
    const file = libraryFile('a.txt', 10, 'a');
    const { session, client, states } = makeSession(emptyProject(), [file]);
    const { docs } = await finalizeImport(session, client, [file]);
    session.removeDocuments(docs);
    const open = client.lastOpen();
    expect(open.docs).toEqual([]);
    open.resolve({ generation: open.generation, snapshot: null, readyDocs: [], missingDocs: [] });
    await settle();

    expect(session.getState().snapshot).toBeNull();
    expect(session.getState().analysis).toEqual({ phase: 'ready' });
    expect(states.at(-1)?.analysis).toEqual({ phase: 'ready' });
  });

  it('does not publish empty-ready while a new import is still staging', async () => {
    const files = [libraryFile('a.txt', 10, 'a'), libraryFile('b.txt', 11, 'b')];
    const { session, client, states } = makeSession(emptyProject(), files);
    const { docs } = await finalizeImport(session, client, [files[0]!]);
    session.removeDocuments(docs);
    const emptyOpen = client.lastOpen();
    const stateMark = states.length;

    session.appendFiles([files[1]!]);
    emptyOpen.resolve({ generation: emptyOpen.generation, snapshot: null, readyDocs: [], missingDocs: [] });
    await settle();

    expect(states.slice(stateMark).some((state) => state.analysis.phase === 'ready')).toBe(false);
    expect(session.getState().imports).toHaveLength(1);
    expect(session.getState().analysis.phase).toBe('loading');
  });

  it('finalizes an import only after source-ready and snapshot publication, in either order', async () => {
    const file = libraryFile('a.txt', 10, 'a');
    const first = makeSession(emptyProject(), [file]);
    const prepared = await prepareImport(first.session, first.client, [file]);
    const doc = prepared.docs[0]!;
    first.client.sourceReady(readyInfo(prepared.open.generation, doc, first.client.jobFor(prepared.open.generation, doc), file));
    expect(first.session.getState().project.data.docs).toHaveLength(0);
    first.client.snapshot({ generation: prepared.open.generation, snapshot: 's', readyDocs: [doc], missingDocs: [] });
    expect(first.session.getState().project.data.docs.map((item) => item.doc)).toEqual([doc]);

    const second = makeSession(emptyProject(), [file]);
    const reverse = await prepareImport(second.session, second.client, [file]);
    const reverseDoc = reverse.docs[0]!;
    second.client.snapshot({ generation: reverse.open.generation, snapshot: 's', readyDocs: [reverseDoc], missingDocs: [] });
    expect(second.session.getState().project.data.docs).toHaveLength(0);
    second.client.sourceReady(readyInfo(reverse.open.generation, reverseDoc, second.client.jobFor(reverse.open.generation, reverseDoc), file));
    expect(second.session.getState().project.data.docs.map((item) => item.doc)).toEqual([reverseDoc]);
  });

  it('preserves selection order under reverse completion and ignores stale jobs', async () => {
    const files = [libraryFile('a.txt', 10, 'a'), libraryFile('b.txt', 11, 'b')];
    const { session, client } = makeSession(emptyProject(), files);
    const prepared = await prepareImport(session, client, files);
    const [a, b] = prepared.docs;
    client.sourceReady(readyInfo(prepared.open.generation, a!, client.jobFor(prepared.open.generation, a!) + 99, files[0]!));
    client.snapshot({ generation: prepared.open.generation, snapshot: 's', readyDocs: [b!, a!], missingDocs: [] });
    client.sourceReady(readyInfo(prepared.open.generation, b!, client.jobFor(prepared.open.generation, b!), files[1]!));
    expect(session.getState().project.data.order).toEqual([b!]);
    client.sourceReady(readyInfo(prepared.open.generation, a!, client.jobFor(prepared.open.generation, a!), files[0]!));
    expect(session.getState().project.data.order).toEqual([a!, b!]);
  });

  it('reads finalized misses from the library and reports identity drift', async () => {
    const file = libraryFile('a.txt', 10, 'a');
    const normal = makeSession(emptyProject(), [file]);
    const { docs } = await finalizeImport(normal.session, normal.client, [file]);
    normal.client.restart(false);
    const reopen = normal.client.lastOpen();
    reopen.resolve({ generation: reopen.generation, snapshot: null, readyDocs: [], missingDocs: [docs[0]!] });
    await settle();
    expect(normal.client.ingests.at(-1)).toMatchObject({ generation: reopen.generation, doc: docs[0] });

    const bad = makeSession(emptyProject(), [file], {
      libraryFiles: { get: async () => ({ ...file, contentHash: hashFor('z') }) },
    });
    const imported = await finalizeImport(bad.session, bad.client, [file]);
    bad.client.restart(false);
    const badOpen = bad.client.lastOpen();
    const before = bad.client.ingests.length;
    badOpen.resolve({ generation: badOpen.generation, snapshot: null, readyDocs: [], missingDocs: [imported.docs[0]!] });
    await settle();
    expect(bad.client.ingests).toHaveLength(before);
    expect(bad.session.getState().sources[imported.docs[0]!]!.phase).toBe('error');
  });
});

describe('library corpus mutations', () => {
  it('removes an in-flight active document when its catalog source is deleted', async () => {
    const file = libraryFile('a.txt', 10, 'a');
    const { session, client } = makeSession(emptyProject(), [file]);
    const prepared = await prepareImport(session, client, [file]);
    session.removeDocuments(prepared.docs);
    expect(session.getState().imports).toEqual([]);
    expect(session.getState().project.data.order).toEqual([]);
    expect(client.lastOpen().docs).toEqual([]);
  });

  it('keeps metadata local, reopens for language/order, and removes a batch once', async () => {
    const files = [libraryFile('a.txt', 10, 'a'), libraryFile('b.txt', 11, 'b')];
    const { session, client } = makeSession(emptyProject(), files);
    const { docs } = await finalizeImport(session, client, files);
    const opens = client.opens.length;
    session.editMeta(docs[0]!, { title: 'Renamed' });
    expect(client.opens).toHaveLength(opens);
    session.setLanguage(docs[0]!, 'fr');
    expect(client.opens).toHaveLength(opens + 1);
    session.reorder([docs[1]!, docs[0]!]);
    expect(client.opens).toHaveLength(opens + 2);
    session.removeDocuments(docs);
    expect(client.opens).toHaveLength(opens + 3);
    expect(session.getState().project.data.order).toEqual([]);
  });

  it('does not finalize a terminal ingest failure and clears decoder diagnostics on reopen', async () => {
    const file = libraryFile('a.txt', 10, 'a');
    const { session, client } = makeSession(emptyProject(), [file]);
    const prepared = await prepareImport(session, client, [file]);
    const doc = prepared.docs[0]!;
    client.sourceReady({
      ...readyInfo(prepared.open.generation, doc, client.jobFor(prepared.open.generation, doc), file),
      decoderReplacementCount: 2,
      suspiciousControlCount: 3,
    });
    client.ingestError(prepared.open.generation, 'failed', doc);
    client.snapshot({ generation: prepared.open.generation, snapshot: 's', readyDocs: [doc], missingDocs: [] });
    expect(session.getState().imports[0]!.status).toBe('failed');
    expect(session.getState().project.data.docs).toHaveLength(0);
    expect(session.getState().extractionDiagnostics[doc]).toEqual({
      detectedEncoding: 'utf-8',
      hadReplacementChars: false,
      decoderReplacementCount: 2,
      suspiciousControlCount: 3,
    });
    session.removeImport(doc);
    expect(session.getState().extractionDiagnostics[doc]).toBeUndefined();
  });
});
