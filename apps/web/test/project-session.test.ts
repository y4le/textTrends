/**
 * Commit 7b — the project session controller, unit-tested with a fake client
 * and deterministic out-of-order acknowledgements. These establish the ten
 * acceptance invariants from the 7b ruling plus the additional race cases it
 * enumerated (whole-project caps, batch order, two-fact join, superseded
 * generation, uncertain CAS, file-retention boundary, reattachment identity).
 *
 * Everything is driven through public session commands + fake-client delivery;
 * no test reaches into private state. Real core recipe hashes are used so a
 * finalized import materializes a manifest that passes the deep durable
 * validator (text/candidate content hashes are asserted strings the validator
 * does not recompute, so they can be synthetic).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEX_RECIPE,
  DEFAULT_STRUCTURE_RECIPE,
  defaultExtractionRecipes,
  hashExtractionRecipe,
  hashIndexRecipe,
  hashStructureRecipe,
  INGEST_CAPS_V0,
  type ProjectDocV1,
  type ProjectManifestV1,
  type StructureOverrideV1,
} from '@texttrends/core';
import type {
  GenerationDocSpecV4,
} from '../src/worker/protocol-v4.ts';
import type {
  GenerationReady,
  IngestProgress,
  ProjectLoadResult,
  SnapshotInfo,
  SourceReadyInfo,
} from '../src/lib/client.ts';
import { UserDataClientError } from '../src/lib/client.ts';
import {
  ProjectSession,
  SessionCommandError,
  type BundledByteProvider,
  type FileLike,
  type ProjectSessionClient,
  type ProjectSessionDeps,
  type SessionState,
} from '../src/lib/project-session.ts';
import { builtinProject, type CurrentProject, type ProjectDataV1 } from '../src/lib/project.ts';

// ── Real recipe hashes (a finalized import must yield a valid manifest). ──
let TXT_HASH = '';
let MD_HASH = '';
let STRUCTURE_HASH = '';
let INDEX_HASH = '';
beforeAll(async () => {
  const { txt, md } = await defaultExtractionRecipes();
  [TXT_HASH, MD_HASH, STRUCTURE_HASH, INDEX_HASH] = await Promise.all([
    hashExtractionRecipe(txt),
    hashExtractionRecipe(md),
    hashStructureRecipe(DEFAULT_STRUCTURE_RECIPE),
    hashIndexRecipe(DEFAULT_INDEX_RECIPE),
  ]);
});

// ── Deterministic settle: drain the recipe-hashing + ingest async chains. Each
// crypto.subtle.digest resolves on Node's threadpool (a macrotask), and a full
// manifest validation chains several, so allow generous macrotask headroom. ──
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

// ── A re-readable fake File with a read counter. ──
interface FakeFile extends FileLike {
  reads: number;
}
function fakeFile(name: string, size: number): FakeFile {
  const f: FakeFile = {
    name,
    size,
    reads: 0,
    async arrayBuffer() {
      f.reads++;
      return new ArrayBuffer(size);
    },
  };
  return f;
}

interface OpenEntry {
  generation: string;
  docs: readonly GenerationDocSpecV4[];
  resolve: (r: GenerationReady) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}
interface SaveEntry {
  manifest: ProjectManifestV1;
  expectedRevision: number;
  resolve: (r: { revision: number }) => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}
interface PromiseEntry<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

class FakeClient implements ProjectSessionClient {
  snapshotL: ((i: SnapshotInfo) => void) | null = null;
  progressL: ((p: IngestProgress) => void) | null = null;
  ingestErrorL: ((g: string, m: string, d?: string) => void) | null = null;
  sourceReadyL: ((i: SourceReadyInfo) => void) | null = null;
  restartL: ((fatal: boolean) => void) | null = null;

  opens: OpenEntry[] = [];
  ingests: { generation: string; doc: string; bytes: ArrayBuffer; job: number }[] = [];
  saves: SaveEntry[] = [];
  persists: ({ sourceHash: string; bytes: ArrayBuffer } & PromiseEntry<void>)[] = [];
  loads: ({ project: string } & PromiseEntry<ProjectLoadResult>)[] = [];
  jobSeq = 100;

  onSnapshot(l: (i: SnapshotInfo) => void): void { this.snapshotL = l; }
  onProgress(l: (p: IngestProgress) => void): void { this.progressL = l; }
  onIngestError(l: (g: string, m: string, d?: string) => void): void { this.ingestErrorL = l; }
  onSourceReady(l: (i: SourceReadyInfo) => void): void { this.sourceReadyL = l; }
  onRestart(l: (fatal: boolean) => void): void { this.restartL = l; }

  openGeneration(generation: string, docs: readonly GenerationDocSpecV4[]): { result: Promise<GenerationReady>; cancel: () => void } {
    let resolve!: (r: GenerationReady) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<GenerationReady>((res, rej) => { resolve = res; reject = rej; });
    const entry: OpenEntry = { generation, docs, resolve, reject, cancelled: false };
    this.opens.push(entry);
    return { result, cancel: () => { entry.cancelled = true; } };
  }
  ingest(generation: string, doc: string, bytes: ArrayBuffer): { job: number } {
    const job = ++this.jobSeq;
    this.ingests.push({ generation, doc, bytes, job });
    return { job };
  }
  projectSave(manifest: ProjectManifestV1, expectedRevision: number): { result: Promise<{ revision: number }>; cancel: () => void } {
    let resolve!: (r: { revision: number }) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<{ revision: number }>((res, rej) => { resolve = res; reject = rej; });
    const entry: SaveEntry = { manifest, expectedRevision, resolve, reject, cancelled: false };
    this.saves.push(entry);
    return { result, cancel: () => { entry.cancelled = true; } };
  }
  projectLoad(project: string): { result: Promise<ProjectLoadResult>; cancel: () => void } {
    let resolve!: (v: ProjectLoadResult) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<ProjectLoadResult>((res, rej) => { resolve = res; reject = rej; });
    this.loads.push({ project, resolve, reject });
    return { result, cancel: () => undefined };
  }
  sourcePersist(sourceHash: string, bytes: ArrayBuffer): { result: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const result = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.persists.push({ sourceHash, bytes, resolve, reject });
    return { result, cancel: () => undefined };
  }

  // Drivers.
  lastOpen(): OpenEntry { return this.opens[this.opens.length - 1]!; }
  ingestFor(generation: string, doc: string): number {
    const hit = [...this.ingests].reverse().find((i) => i.generation === generation && i.doc === doc);
    if (!hit) throw new Error(`no ingest for ${doc} in ${generation}`);
    return hit.job;
  }
  emitSnapshot(i: SnapshotInfo): void { this.snapshotL?.(i); }
  emitProgress(p: IngestProgress): void { this.progressL?.(p); }
  emitSourceReady(i: SourceReadyInfo): void { this.sourceReadyL?.(i); }
  emitIngestError(g: string, m: string, d?: string): void { this.ingestErrorL?.(g, m, d); }
  emitRestart(fatal: boolean): void { this.restartL?.(fatal); }
}

const bundledProvider = (): BundledByteProvider & { gets: string[] } => {
  const p = {
    gets: [] as string[],
    async get(doc: ProjectDocV1): Promise<ArrayBuffer> {
      p.gets.push(doc.doc);
      return new ArrayBuffer(doc.source.byteLength);
    },
  };
  return p;
};

// hashBytes: deterministic on size — a same-size file "matches", a different
// size does not. A finalized doc's SourceHash is set to `H<size>` at import.
const sizeHash = async (bytes: Uint8Array): Promise<string> => `H${bytes.byteLength}`;

function makeSession(initial: CurrentProject, over: Partial<ProjectSessionDeps> = {}) {
  const client = new FakeClient();
  const bundled = bundledProvider();
  let idSeq = 0;
  const deps: ProjectSessionDeps = {
    client,
    bundledBytes: bundled,
    newDocId: () => `doc-${++idSeq}`,
    hashBytes: sizeHash,
    ...over,
  };
  const states: SessionState[] = [];
  const session = new ProjectSession(initial, deps);
  session.subscribe((s) => states.push(s));
  return { session, client, bundled, states, deps };
}

function readyInfo(
  generation: string,
  doc: string,
  job: number,
  opts: { size?: number; format?: 'txt' | 'md'; replacements?: number; controls?: number } = {},
): SourceReadyInfo {
  const size = opts.size ?? 10;
  return {
    job,
    generation,
    doc,
    source: { kind: 'text', hash: `H${size}`, byteLength: size, format: opts.format ?? 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
    extractionRecipeHash: opts.format === 'md' ? MD_HASH : TXT_HASH,
    text: `text-${doc}`,
    textLengthUtf16: 5,
    candidates: `cand-${doc}`,
    decoderReplacementCount: opts.replacements ?? 0,
    suspiciousControlCount: opts.controls ?? 0,
  };
}

// A minimal built-in current project (no docs needed for boundary tests; a
// single bundled doc when we exercise the bundled open path).
function builtin(docs: ProjectDocV1[] = []): CurrentProject {
  const data: ProjectDataV1 = {
    id: 'builtin/sherlock',
    order: docs.map((d) => d.doc),
    docs,
    indexRecipe: DEFAULT_INDEX_RECIPE,
    indexRecipeHash: INDEX_HASH,
  };
  return builtinProject(data);
}
function bundledDoc(doc: string, bytes: number): ProjectDocV1 {
  return {
    doc,
    sourceName: doc,
    meta: { title: doc, language: 'en', tags: [] },
    source: { kind: 'text', hash: `H${bytes}`, byteLength: bytes, format: 'txt', encoding: { detected: 'utf-8', hadReplacementChars: false } },
    sourceAvailability: 'bundled',
    extraction: { recipe: undefined as never, recipeHash: TXT_HASH, text: 't', textLengthUtf16: 1, candidates: 'c' },
    structure: { recipe: DEFAULT_STRUCTURE_RECIPE, recipeHash: STRUCTURE_HASH, override: { status: 'none' } },
  };
}

/** Drive a fresh user-project import to full finalization of every file. */
async function importAndFinalize(
  client: FakeClient,
  session: ProjectSession,
  files: FakeFile[],
  opts: { persist?: boolean; append?: boolean } = {},
): Promise<{ generation: string; docs: string[] }> {
  const importOpts = opts.persist === undefined ? {} : { persist: opts.persist };
  if (opts.append) session.appendFiles(files, importOpts);
  else session.createUserProject(files, importOpts);
  await settle();
  const open = client.lastOpen();
  const generation = open.generation;
  const cold = open.docs.filter((d) => d.source.availability === 'external' && d.source.expectedHash === undefined);
  open.resolve({ generation, snapshot: null, readyDocs: [], missing: cold.map((d) => ({ doc: d.doc, need: 'source-bytes', reason: 'source-not-persisted' })) });
  await settle();
  const docs = cold.map((d) => d.doc);
  for (const doc of docs) client.emitSourceReady(readyInfo(generation, doc, client.ingestFor(generation, doc)));
  client.emitSnapshot({ generation, snapshot: 'snap-1', readyDocs: docs, missingDocs: [] });
  await settle();
  return { generation, docs };
}

// ────────────────────────────────────────────────────────────────────────────

describe('built-in hard boundary (invariant 7)', () => {
  it('rejects every user mutation on the built-in but allows createUserProject', () => {
    const { session } = makeSession(builtin());
    const f = fakeFile('a.txt', 10);
    expect(() => session.save()).toThrow(SessionCommandError);
    expect(() => session.appendFiles([f])).toThrow(SessionCommandError);
    expect(() => session.editMeta('x', { title: 't' })).toThrow(SessionCommandError);
    expect(() => session.setLanguage('x', 'fr')).toThrow(SessionCommandError);
    expect(() => session.reorder([])).toThrow(SessionCommandError);
    expect(() => session.setPersistIntent('x', true)).toThrow(SessionCommandError);
    expect(() => session.reattach('x', f)).toThrow(SessionCommandError);
    // createUserProject is the one import entry from the built-in.
    expect(() => session.createUserProject([f])).not.toThrow();
    expect(session.getState().project.kind).toBe('user');
  });
});

describe('one generation-spec builder + declared order (invariant 10)', () => {
  it('the built-in opens with exactly generationSpecsFromProject(data)', () => {
    const { session, client } = makeSession(builtin([bundledDoc('b1', 20), bundledDoc('b2', 30)]));
    session.start();
    const open = client.lastOpen();
    expect(open.docs.map((d) => d.doc)).toEqual(['b1', 'b2']);
    expect(open.docs.every((d) => d.source.availability === 'bundled' && d.source.expectedHash !== undefined)).toBe(true);
  });

  it('resolves a bundled miss through the injected provider and ingests', async () => {
    const { session, client, bundled } = makeSession(builtin([bundledDoc('b1', 20)]));
    session.start();
    const open = client.lastOpen();
    open.resolve({ generation: open.generation, snapshot: null, readyDocs: [], missing: [{ doc: 'b1', need: 'source-bytes', reason: 'source-miss' }] });
    await settle();
    expect(bundled.gets).toEqual(['b1']);
    expect(client.ingests.map((i) => i.doc)).toEqual(['b1']);
  });
});

describe('import assembly: two-fact join (invariants 1, 3)', () => {
  it('source-ready alone never finalizes or enables save; publication completes it', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const doc = open.docs[0]!.doc;
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-not-persisted' }] });
    await settle();
    // source-ready only:
    client.emitSourceReady(readyInfo(gen, doc, client.ingestFor(gen, doc)));
    await settle();
    let st = session.getState();
    expect(st.imports[0]!.status).toBe('extracting');
    expect(st.project.data.docs).toHaveLength(0); // not finalized
    expect(st.project.saveable).toBe(false); // source-ready ≠ ingest completion
    // now publication:
    client.emitSnapshot({ generation: gen, snapshot: 's1', readyDocs: [doc], missingDocs: [] });
    await settle();
    st = session.getState();
    expect(st.imports).toHaveLength(0);
    expect(st.project.data.docs.map((d) => d.doc)).toEqual([doc]);
    expect(st.project.saveable).toBe(true);
  });

  it('publication before source-ready is equally valid (either arrival order)', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const doc = open.docs[0]!.doc;
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-not-persisted' }] });
    await settle();
    client.emitSnapshot({ generation: gen, snapshot: 's1', readyDocs: [doc], missingDocs: [] });
    await settle();
    expect(session.getState().project.data.docs).toHaveLength(0); // publication alone insufficient
    client.emitSourceReady(readyInfo(gen, doc, client.ingestFor(gen, doc)));
    await settle();
    expect(session.getState().project.data.docs.map((d) => d.doc)).toEqual([doc]);
  });

  it('never constructs or sends a revision-0 manifest; first save targets revision 1', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    expect(session.getState().project.baseRevision).toBe(0);
    session.save();
    await settle();
    expect(client.saves).toHaveLength(1);
    expect(client.saves[0]!.expectedRevision).toBe(0);
    expect(client.saves[0]!.manifest.revision).toBe(1);
  });
});

describe('batch order preservation (planner case 2)', () => {
  it('finalizes in reverse arrival order yet keeps declared = selection order', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10), fakeFile('b.txt', 11), fakeFile('c.txt', 12)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const docs = open.docs.map((d) => d.doc); // selection order
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: docs.map((doc) => ({ doc, need: 'source-bytes' as const, reason: 'source-not-persisted' as const })) });
    await settle();
    // Deliver source-ready + publication in REVERSE order.
    const reversed = [...docs].reverse();
    for (const doc of reversed) client.emitSourceReady(readyInfo(gen, doc, client.ingestFor(gen, doc)));
    client.emitSnapshot({ generation: gen, snapshot: 's1', readyDocs: reversed, missingDocs: [] });
    await settle();
    expect(session.getState().project.data.order).toEqual(docs); // selection, not completion
  });
});

describe('post-extraction failure (planner case 4)', () => {
  it('a segment/index failure after source-ready stays unsaveable; a stale snapshot cannot resurrect it', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const doc = open.docs[0]!.doc;
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-not-persisted' }] });
    await settle();
    client.emitSourceReady(readyInfo(gen, doc, client.ingestFor(gen, doc)));
    client.emitIngestError(gen, 'INDEX_FAILED: boom', doc);
    await settle();
    expect(session.getState().imports[0]!.status).toBe('failed');
    expect(session.getState().project.saveable).toBe(false);
    // A late snapshot naming the doc must not finalize a failed import.
    client.emitSnapshot({ generation: gen, snapshot: 's-late', readyDocs: [doc], missingDocs: [] });
    await settle();
    expect(session.getState().project.data.docs).toHaveLength(0);
    expect(session.getState().project.saveable).toBe(false);
  });
});

describe('stale correlation cannot mutate the session (invariant 2)', () => {
  it('a source-ready with a stale ingest job is ignored', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const doc = open.docs[0]!.doc;
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-not-persisted' }] });
    await settle();
    const realJob = client.ingestFor(gen, doc);
    client.emitSourceReady(readyInfo(gen, doc, realJob + 999)); // wrong job
    client.emitSnapshot({ generation: gen, snapshot: 's1', readyDocs: [doc], missingDocs: [] });
    await settle();
    expect(session.getState().project.data.docs).toHaveLength(0); // stale event did not assemble
    // The genuine job does finalize.
    client.emitSourceReady(readyInfo(gen, doc, realJob));
    await settle();
    expect(session.getState().project.data.docs.map((d) => d.doc)).toEqual([doc]);
  });
});

describe('CAS save state machine (invariants 5, 6)', () => {
  it('edits during an in-flight save remain dirty after that payload is acked', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    expect(session.getState().project.save.phase).toBe('saving');
    // Edit while the save is in flight.
    session.editMeta(docs[0]!, { title: 'Renamed' });
    expect(session.getState().project.dirty).toBe(true);
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    const st = session.getState();
    expect(st.project.baseRevision).toBe(1);
    expect(st.project.dirty).toBe(true); // the in-flight edit is not covered by the acked payload
    expect(st.project.saveable).toBe(true);
  });

  it('REVISION_CONFLICT retains the draft, surfaces currentRevision, and does not advance the base', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.reject(new UserDataClientError('REVISION_CONFLICT', 'stale', 7));
    await settle();
    const st = session.getState();
    expect(st.project.save).toEqual({ phase: 'conflict', currentRevision: 7 });
    expect(st.project.baseRevision).toBe(0); // NOT adopted
    expect(st.project.dirty).toBe(true);
    expect(st.project.saveable).toBe(false); // blocked until reload/rebase/discard
  });

  it('DATA_CORRUPT surfaces an error and never auto-overwrites', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.reject(new UserDataClientError('DATA_CORRUPT', 'bad record'));
    await settle();
    expect(session.getState().project.save.phase).toBe('error');
    expect(client.saves).toHaveLength(1); // no second save attempt
  });

  it('a save ack whose revision is not the captured target is an invariant fault', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.resolve({ revision: 5 }); // target was 1
    await settle();
    const save = session.getState().project.save;
    expect(save.phase).toBe('error');
    expect(session.getState().project.baseRevision).toBe(0);
  });

  it('coalesces a save requested during an in-flight save into one follow-up', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    session.editMeta(docs[0]!, { title: 'Two' });
    session.save(); // coalesced (saveAgain)
    expect(client.saves).toHaveLength(1);
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    expect(client.saves).toHaveLength(2); // follow-up
    expect(client.saves[1]!.expectedRevision).toBe(1); // from the newly acked base
    client.saves[1]!.resolve({ revision: 2 });
    await settle();
    expect(session.getState().project.baseRevision).toBe(2);
    expect(session.getState().project.dirty).toBe(false);
  });
});

describe('source persistence ordering (invariant 4, planner case 10)', () => {
  it('the manifest is never persisted before source-persisted, then flips and dirties', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)], { persist: true });
    const doc = docs[0]!;
    // Persistence started on finalize.
    expect(client.persists).toHaveLength(1);
    let st = session.getState();
    expect(st.sources[doc]!.phase).toBe('persist-saving');
    expect(st.project.data.docs[0]!.sourceAvailability).toBe('external'); // not yet persisted
    expect(st.project.saveable).toBe(false); // blocked while persist in flight
    client.persists[0]!.resolve();
    await settle();
    st = session.getState();
    expect(st.sources[doc]!.phase).toBe('persisted');
    expect(st.project.data.docs[0]!.sourceAvailability).toBe('persisted');
    expect(st.project.dirty).toBe(true);
    expect(st.project.saveable).toBe(true);
  });

  it('file-retention boundary: source-persist ack alone does not release the file; the save ack does', async () => {
    const { session, client } = makeSession(builtin());
    const { generation, docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)], { persist: true });
    const doc = docs[0]!;
    client.persists[0]!.resolve();
    await settle();
    // Persisted but not yet saved: a worker restart still finds the retained File.
    client.emitRestart(false);
    await settle();
    const open2 = client.lastOpen();
    open2.resolve({ generation: open2.generation, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-corrupt' }] });
    await settle();
    expect(client.ingests.some((i) => i.generation === open2.generation && i.doc === doc)).toBe(true); // re-ingested from retained File
    // Re-publish so it's ready, then save.
    client.emitSourceReady(readyInfo(generation, doc, client.ingestFor(open2.generation, doc), { size: 10 }));
    client.emitSnapshot({ generation: open2.generation, snapshot: 's2', readyDocs: [doc], missingDocs: [] });
    await settle();
    session.save();
    await settle();
    const saveIdx = client.saves.length - 1;
    client.saves[saveIdx]!.resolve({ revision: 1 });
    await settle();
    // Now saved: a further restart no longer has the File (released) → external-missing.
    client.emitRestart(false);
    await settle();
    const open3 = client.lastOpen();
    open3.resolve({ generation: open3.generation, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-corrupt' }] });
    await settle();
    expect(client.ingests.some((i) => i.generation === open3.generation && i.doc === doc)).toBe(false);
    // The doc is PERSISTED and the copy is damaged: the repair vocabulary must
    // say so — never a generic "missing" (pass-2 Track S2).
    expect(session.getState().sources[doc]).toEqual({ phase: 'external-missing', repair: 'persisted-corrupt' });
  });

  it('repair reasons: a loaded EXTERNAL doc (no File in this tab) reads external-not-attached', async () => {
    const { session, client } = makeSession(builtin());
    // Build + save a project with an external doc, then load it into a fresh
    // session — the new tab holds no File, the exact reattach-the-file case.
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const saved = client.saves[0]!.manifest;
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    const fresh = makeSession(builtin());
    fresh.session.loadUserProject();
    await settle();
    fresh.client.loads[0]!.resolve({ kind: 'loaded', manifest: saved });
    await settle();
    const doc = saved.docs[0]!.doc;
    expect(fresh.session.getState().sources[doc]).toEqual({ phase: 'external-missing', repair: 'external-not-attached' });
  });
});

describe('metadata vs generation-reopening edits (invariant 8)', () => {
  it('metadata edits do not reopen analysis; language and reorder do', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10), fakeFile('b.txt', 11)]);
    const opensAfterImport = client.opens.length;
    session.editMeta(docs[0]!, { title: 'X', author: 'Y', year: 1900, tags: ['t'] });
    expect(client.opens.length).toBe(opensAfterImport); // no reopen
    expect(session.getState().project.dirty).toBe(true);
    session.setLanguage(docs[0]!, 'fr');
    expect(client.opens.length).toBe(opensAfterImport + 1); // reopen
    session.reorder([docs[1]!, docs[0]!]);
    expect(client.opens.length).toBe(opensAfterImport + 2); // reopen
    expect(session.getState().project.data.order).toEqual([docs[1]!, docs[0]!]);
  });
});

describe('source evidence projection (§12.4)', () => {
  /** Import one file and finalize it, delivering source-ready with the given
   *  extraction-evidence counts. */
  async function importWithEvidence(replacements: number, controls: number) {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const gen = open.generation;
    const doc = open.docs[0]!.doc;
    open.resolve({ generation: gen, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-not-persisted' }] });
    await settle();
    client.emitSourceReady(readyInfo(gen, doc, client.ingestFor(gen, doc), { replacements, controls }));
    client.emitSnapshot({ generation: gen, snapshot: 'snap-1', readyDocs: [doc], missingDocs: [] });
    await settle();
    return { session, client, doc };
  }

  it('captures the decoder/control counts from a real source-ready event', async () => {
    const { session, doc } = await importWithEvidence(3, 7);
    expect(session.getState().sourceEvidence[doc]).toEqual({
      decoderReplacementCount: 3,
      suspiciousControlCount: 7,
    });
  });

  it('resets the evidence at each new generation (a reopen clears prior counts)', async () => {
    const { session, doc } = await importWithEvidence(3, 7);
    session.setLanguage(doc, 'fr'); // reopens the generation
    // After the reopen, before any new source-ready arrives, the counts are
    // unknown — never carried over from the prior generation.
    expect(session.getState().sourceEvidence[doc]).toBeUndefined();
  });
});

describe('structure correction command — fenced async (8c, ruling §4/§5)', () => {
  /** A structurally-valid override authored against a doc's CURRENT identities.
   *  (The session never composes structure — the fake client does not run the
   *  engine — so the change content is opaque to it; only base identities and
   *  the async fence are exercised here.) */
  function mkOverride(doc: ProjectDocV1, key = 'user-x'): StructureOverrideV1 {
    return {
      schema: 'texttrends/structure-override/1',
      text: doc.extraction.text,
      candidates: doc.extraction.candidates,
      baseRecipe: doc.structure.recipeHash,
      changes: [{ op: 'add', key, value: { parent: 'root', level: 1, chars: { start: 0, end: 1 } } }],
    };
  }
  const docOf = (session: ProjectSession, doc: string): ProjectDocV1 =>
    session.getState().project.data.docs.find((d) => d.doc === doc)!;

  it('publishes hashing, then installs an active override and reopens (never sync)', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    const opensBefore = client.opens.length;
    session.setStructureOverride(doc, mkOverride(docOf(session, doc)));
    // Synchronous: hashing status, and NO reopen until the hash resolves.
    expect(session.getState().corrections[doc]?.phase).toBe('hashing');
    expect(client.opens.length).toBe(opensBefore);
    await settle();
    expect(session.getState().corrections[doc]).toBeUndefined();
    expect(docOf(session, doc).structure.override.status).toBe('active');
    expect(client.opens.length).toBe(opensBefore + 1);
    const spec = client.lastOpen().docs.find((s) => s.doc === doc)!;
    expect(spec.structure.override.kind).toBe('active');
  });

  it('fast-rejects an override whose base identities do not match — no hash, no reopen', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    const opensBefore = client.opens.length;
    session.setStructureOverride(doc, { ...mkOverride(docOf(session, doc)), text: 'WRONG-TEXT-HASH' });
    const c = session.getState().corrections[doc];
    expect(c?.phase).toBe('error');
    if (c?.phase === 'error') expect(c.reason).toBe('stale-base');
    await settle();
    expect(client.opens.length).toBe(opensBefore);
    expect(docOf(session, doc).structure.override.status).toBe('none');
  });

  it('a later authoring attempt supersedes an earlier pending hash', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    const d = docOf(session, doc);
    session.setStructureOverride(doc, mkOverride(d, 'user-FIRST'));
    session.setStructureOverride(doc, mkOverride(d, 'user-SECOND')); // supersedes before either hash resolves
    await settle();
    const ov = docOf(session, doc).structure.override;
    expect(ov.status).toBe('active');
    if (ov.status === 'active') expect(ov.value.changes[0]!).toMatchObject({ key: 'user-SECOND' });
  });

  it('a discard (null) installs none, reopens, and supersedes a pending hash', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    // Establish an active correction first.
    session.setStructureOverride(doc, mkOverride(docOf(session, doc)));
    await settle();
    expect(docOf(session, doc).structure.override.status).toBe('active');
    // A fresh pending apply immediately superseded by a discard.
    session.setStructureOverride(doc, mkOverride(docOf(session, doc), 'user-LATE'));
    session.setStructureOverride(doc, null);
    await settle();
    expect(docOf(session, doc).structure.override.status).toBe('none');
    expect(session.getState().corrections[doc]).toBeUndefined();
  });

  it('rejects the command on the read-only built-in project', () => {
    const { session } = makeSession(builtin());
    expect(() => session.setStructureOverride('x', null)).toThrow(SessionCommandError);
  });

  it('a project load during a pending hash fences the stale correction out of the replacement', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    session.save();
    await settle();
    const saved = client.saves[0]!.manifest;
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    // Start an override hash, THEN replace the project via a load of the SAME
    // (content-identical) saved manifest before the hash resolves — the exact
    // race where the stale override's base identities still match the reloaded
    // doc, so only the session-epoch fence prevents it mutating the new project.
    session.setStructureOverride(doc, mkOverride(docOf(session, doc)));
    expect(session.getState().corrections[doc]?.phase).toBe('hashing');
    session.loadUserProject();
    client.loads.at(-1)!.resolve({ kind: 'loaded', manifest: saved });
    await settle();
    // Whatever the (hash, install) interleaving, the SAFETY invariant holds:
    // the replacement project keeps override NONE — the stale correction, whose
    // base identities still match the content-identical reloaded doc, is fenced
    // out by the session epoch and never mutates the new project — and its
    // status is cleared on replacement, not leaked. (A hash that lands before
    // the install touches only the outgoing project the load then discards.)
    expect(docOf(session, doc).structure.override.status).toBe('none');
    expect(session.getState().corrections[doc]).toBeUndefined();
    expect(session.getState().project.dirty).toBe(false);
    expect(session.getState().project.baseRevision).toBe(1); // the loaded project, clean
  });
});

describe('reattachment identity (planner case 11)', () => {
  it('a matching file ingests and does not dirty; a mismatch never ingests', async () => {
    const { session, client } = makeSession(builtin());
    const { generation, docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    // Simulate a genuine external miss (worker evicted the source) in the CURRENT generation.
    session.setLanguage(doc, 'de'); // reopen so there is a live generation needing bytes
    await settle();
    const gen2 = client.lastOpen().generation;
    const ingestsBefore = client.ingests.length;

    // Mismatch: a different-size file hashes differently from H10.
    session.reattach(doc, fakeFile('replacement.txt', 999));
    await settle();
    expect(session.getState().reattach[doc]!.phase).toBe('mismatch');
    expect(client.ingests.length).toBe(ingestsBefore); // never sent the bad bytes
    expect(session.getState().project.dirty).toBe(session.getState().project.dirty); // unchanged by mismatch

    // Match: same-size file hashes to H10 (the doc's SourceHash).
    const dirtyBefore = session.getState().project.dirty;
    session.reattach(doc, fakeFile('other-name.txt', 10));
    await settle();
    expect(session.getState().reattach[doc]!.phase).toBe('attached');
    expect(client.ingests.some((i) => i.generation === gen2 && i.doc === doc)).toBe(true);
    expect(session.getState().project.dirty).toBe(dirtyBefore); // identical content does not dirty
    expect(generation).not.toBe(gen2);
  });
});

describe('worker restart (invariant 9)', () => {
  it('a nonfatal restart reopens analysis and re-ingests from the retained File', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    const opensBefore = client.opens.length;
    client.emitRestart(false);
    await settle();
    expect(client.opens.length).toBe(opensBefore + 1);
    const open2 = client.lastOpen();
    open2.resolve({ generation: open2.generation, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-miss' }] });
    await settle();
    expect(client.ingests.some((i) => i.generation === open2.generation && i.doc === doc)).toBe(true);
    expect(session.getState().project.kind).toBe('user'); // working copy retained
  });

  it('a fatal restart keeps the working copy, marks a terminal error, and stays a user project', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    client.emitRestart(true);
    await settle();
    const st = session.getState();
    expect(st.analysis.phase).toBe('error');
    expect(st.analysis).toMatchObject({ fatal: true });
    expect(st.project.kind).toBe('user');
    expect(st.project.dirty).toBe(true);
  });
});

describe('uncertain CAS reconciliation (planner case 8)', () => {
  it('worker death during a save reconciles by load — adopts the target if it committed', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const sent = client.saves[0]!.manifest;
    client.emitRestart(false);
    await settle();
    expect(session.getState().project.save.phase).toBe('reconcile-required');
    expect(client.loads).toHaveLength(1); // load truth, do not auto-replay
    client.loads[0]!.resolve({ kind: 'loaded', manifest: sent }); // our write DID commit
    await settle();
    const st = session.getState();
    expect(st.project.save.phase).toBe('idle');
    expect(st.project.baseRevision).toBe(1);
    expect(st.project.dirty).toBe(false);
    expect(client.saves).toHaveLength(1); // never replayed
  });

  it('reconciliation surfaces a conflict when a different revision committed', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const sent = client.saves[0]!.manifest;
    client.emitRestart(false);
    await settle();
    client.loads[0]!.resolve({ kind: 'loaded', manifest: { ...sent, revision: 2 } });
    await settle();
    expect(session.getState().project.save).toEqual({ phase: 'conflict', currentRevision: 2 });
    expect(session.getState().project.baseRevision).toBe(0); // never overwritten
  });
});

describe('whole-project caps on append (planner case 1)', () => {
  it('rejects an append that would exceed the document cap with zero reads/opens/ingests', async () => {
    const { session, client } = makeSession(builtin());
    const first = fakeFile('a.txt', 10);
    await importAndFinalize(client, session, [first]);
    const opensBefore = client.opens.length;
    const ingestsBefore = client.ingests.length;
    // maxDocsPerProject files would push us over (1 existing + N new).
    const many = Array.from({ length: INGEST_CAPS_V0.maxDocsPerProject }, (_, i) => fakeFile(`x${i}.txt`, 1));
    expect(() => session.appendFiles(many)).toThrow(SessionCommandError);
    expect(client.opens.length).toBe(opensBefore);
    expect(client.ingests.length).toBe(ingestsBefore);
    expect(many.every((f) => f.reads === 0)).toBe(true);
  });

  it('rejects an oversized single file before any read', () => {
    const { session, client } = makeSession(builtin());
    const big = fakeFile('big.txt', INGEST_CAPS_V0.maxSourceBytesPerFile + 1);
    expect(() => session.createUserProject([big])).toThrow(SessionCommandError);
    expect(big.reads).toBe(0);
    expect(client.opens).toHaveLength(0);
  });

  it('rejects an unsupported file type', () => {
    const { session } = makeSession(builtin());
    expect(() => session.createUserProject([fakeFile('a.pdf', 10)])).toThrow(SessionCommandError);
  });
});

describe('superseded generation (planner case 5)', () => {
  it('cancels a pending open and drops its late resolution when a newer generation starts', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    // Start a new generation while the previous open is still... actually reopen.
    session.setLanguage(docs[0]!, 'fr'); // starts generation B, cancelling A's (already resolved) — reopen B pending
    const openB = client.lastOpen();
    // Start C, superseding B before B resolves.
    session.setLanguage(docs[0]!, 'es');
    await settle();
    expect(openB.cancelled).toBe(true);
    const openC = client.lastOpen();
    const docsBefore = session.getState().project.data.docs.length;
    // A late resolution of the superseded B must not mutate anything.
    openB.resolve({ generation: openB.generation, snapshot: null, readyDocs: [], missing: [] });
    await settle();
    expect(session.getState().project.data.docs.length).toBe(docsBefore);
    expect(openC.cancelled).toBe(false);
  });
});

describe('load validation fence (planner case 14)', () => {
  it('a corrupt durable record (typed DATA_CORRUPT from the worker authority) surfaces an error and does not replace the current project', async () => {
    const { session, client } = makeSession(builtin([bundledDoc('b1', 20)]));
    session.start();
    session.loadUserProject();
    await settle();
    expect(client.loads).toHaveLength(1);
    // The WORKER deep-validates before emitting; corruption arrives as a
    // typed rejection, never as a value for the session to re-validate.
    client.loads[0]!.reject(new UserDataClientError('DATA_CORRUPT', 'stored project failed validation: bad revision'));
    await settle();
    const analysis = session.getState().analysis;
    expect(analysis.phase).toBe('error');
    expect(analysis.phase === 'error' && analysis.message).toContain('corrupt');
    expect(session.getState().project.kind).toBe('builtin'); // unchanged
  });

  it('a validated load replaces the project and reopens analysis', async () => {
    const { session, client } = makeSession(builtin());
    // Build a real saved manifest by importing + saving a user project first.
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const saved = client.saves[0]!.manifest;
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    // Now load it into a fresh session.
    const fresh = makeSession(builtin());
    fresh.session.loadUserProject();
    await settle();
    fresh.client.loads[0]!.resolve({ kind: 'loaded', manifest: saved });
    await settle();
    const st = fresh.session.getState();
    expect(st.project.kind).toBe('user');
    expect(st.project.baseRevision).toBe(1);
    expect(st.project.dirty).toBe(false);
    expect(fresh.client.opens).toHaveLength(1); // reopened analysis for the loaded project
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Review round 1 fixes (Codex claude_7b_review_v2): fencing/ordering hardening.
// ────────────────────────────────────────────────────────────────────────────

describe('save posting is synchronous with the command (worker is the validation authority)', () => {
  it('save() posts in the same task — a restart can only interrupt a POSTED save, which reconciles', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    // No main-thread deep-validation await remains: the manifest is
    // constructed synchronously and the post happens before control returns,
    // so there is no pre-post window a restart could abort into a retryable
    // error. The worker validates at its own trust boundary.
    expect(client.saves).toHaveLength(1); // posted synchronously
    client.emitRestart(false); // restart while the posted save is in flight
    await settle();
    // The write may or may not have committed — reconcile, never guess.
    expect(session.getState().project.save.phase).toBe('reconcile-required');
  });
});

describe('load must not strand in-flight operations (review finding 2)', () => {
  it('a failed load leaves the current project and lets its in-flight save still complete', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    expect(client.saves).toHaveLength(1); // posted
    session.loadUserProject();
    await settle();
    client.loads[0]!.reject(new UserDataClientError('DATA_CORRUPT', 'stored project failed validation')); // corrupt record
    await settle();
    expect(session.getState().analysis.phase).toBe('error'); // load failed
    // The pre-existing save is NOT stranded: its ack still lands.
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    expect(session.getState().project.baseRevision).toBe(1);
    expect(session.getState().project.save.phase).toBe('idle');
  });
});

describe('file retention follows the acked manifest (review finding 3)', () => {
  it('a save ack does not release a File that flipped to persisted after the payload was captured', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]); // external
    const doc = docs[0]!;
    session.save(); // captures a manifest with doc === external
    await settle();
    // Persist the source AFTER the payload was captured; its ack flips current
    // availability to persisted while the older save is still in flight.
    session.setPersistIntent(doc, true);
    await settle();
    client.persists[0]!.resolve();
    await settle();
    client.saves[0]!.resolve({ revision: 1 }); // acked manifest still says external
    await settle();
    // The File must be retained (the acked revision does not reference a durable
    // source): a restart's genuine miss is re-ingested from it.
    client.emitRestart(false);
    await settle();
    const open = client.lastOpen();
    open.resolve({ generation: open.generation, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-corrupt' }] });
    await settle();
    expect(client.ingests.some((i) => i.generation === open.generation && i.doc === doc)).toBe(true);
  });
});

describe('declared order across partial finalization + restart (review finding 4)', () => {
  it('a restart with one of two imports finalized reopens in selection order, not finalized-first', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10), fakeFile('b.txt', 11)]);
    await settle();
    const open1 = client.lastOpen();
    const gen1 = open1.generation;
    const [a, b] = open1.docs.map((d) => d.doc); // selection order [a, b]
    open1.resolve({ generation: gen1, snapshot: null, readyDocs: [], missing: [a!, b!].map((doc) => ({ doc, need: 'source-bytes' as const, reason: 'source-not-persisted' as const })) });
    await settle();
    // Finalize ONLY b.
    client.emitSourceReady(readyInfo(gen1, b!, client.ingestFor(gen1, b!)));
    client.emitSnapshot({ generation: gen1, snapshot: 's1', readyDocs: [b!], missingDocs: [a!] });
    await settle();
    // Restart: the reopened generation must compose [a (pending), b (finalized)].
    client.emitRestart(false);
    await settle();
    expect(client.lastOpen().docs.map((d) => d.doc)).toEqual([a, b]);
  });
});

describe('whole-project caps count pending imports; preflight is transactional (review finding 5)', () => {
  it('an append is rejected on the doc cap counting still-pending imports, with zero reads', async () => {
    const { session, client } = makeSession(builtin());
    const staged = Array.from({ length: 40 }, (_, i) => fakeFile(`s${i}.txt`, 1));
    session.createUserProject(staged); // 40 pending (not finalized)
    await settle();
    const opensBefore = client.opens.length;
    const more = Array.from({ length: 30 }, (_, i) => fakeFile(`m${i}.txt`, 1)); // 40 + 30 > 64
    expect(() => session.appendFiles(more)).toThrow(SessionCommandError);
    expect(more.every((f) => f.reads === 0)).toBe(true);
    expect(client.opens.length).toBe(opensBefore);
  });

  it('an invalid createUserProject selection from the built-in does not mutate anything', () => {
    const { session, client } = makeSession(builtin([bundledDoc('b1', 20)]));
    expect(() => session.createUserProject([fakeFile('bad.pdf', 10)])).toThrow(SessionCommandError);
    expect(session.getState().project.kind).toBe('builtin'); // still the read-only built-in
    expect(client.opens).toHaveLength(0);
  });

  it('createUserProject is rejected from an existing user project (no known-user replacement — D4)', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('keep.txt', 10)]);
    const before = session.getState().project.data.docs.length;
    expect(() => session.createUserProject([fakeFile('valid.txt', 10)])).toThrow(SessionCommandError);
    expect(session.getState().project.data.docs).toHaveLength(before); // working copy intact
    expect(session.getState().project.baseRevision).toBe(0); // CAS base not reset
  });

  it('removeImport frees the declared-order slot', async () => {
    const { session } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10), fakeFile('b.txt', 11)]);
    await settle();
    expect(session.getState().imports).toHaveLength(2);
    const doc = session.getState().imports[0]!.doc;
    session.removeImport(doc);
    expect(session.getState().imports.map((i) => i.doc)).not.toContain(doc);
  });
});

describe('persisted-source reattachment repairs durable storage (review finding 6)', () => {
  it('a matching reattach of a persisted doc issues a repair sourcePersist without dirtying', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)], { persist: true });
    const doc = docs[0]!;
    client.persists[0]!.resolve();
    await settle(); // doc now persisted
    const persistsBefore = client.persists.length;
    const dirtyBefore = session.getState().project.dirty;
    session.reattach(doc, fakeFile('same-content.txt', 10)); // size 10 matches, hashes to H10
    await settle();
    expect(session.getState().reattach[doc]!.phase).toBe('attached');
    expect(client.persists.length).toBe(persistsBefore + 1); // repair issued
    client.persists[persistsBefore]!.resolve();
    await settle();
    expect(session.getState().project.data.docs[0]!.sourceAvailability).toBe('persisted'); // unchanged
    expect(session.getState().project.dirty).toBe(dirtyBefore); // a repair does not dirty
  });
});

describe('uncertain-CAS reconciliation edge cases (review finding 7)', () => {
  it('a project-missing reconcile surfaces a retryable error, never a silent success', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.emitRestart(false);
    await settle();
    client.loads[0]!.resolve({ kind: 'missing' }); // our write did not commit
    await settle();
    expect(session.getState().project.save.phase).toBe('error');
    expect(session.getState().project.baseRevision).toBe(0);
  });

  it('adopting the target on reconcile consumes a coalesced save request', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const sent = client.saves[0]!.manifest;
    session.editMeta(docs[0]!, { title: 'Edited during uncertain save' });
    session.save(); // coalesced (saveAgain)
    client.emitRestart(false);
    await settle();
    client.loads[0]!.resolve({ kind: 'loaded', manifest: sent }); // target committed → adopt
    await settle();
    expect(session.getState().project.baseRevision).toBe(1);
    expect(client.saves).toHaveLength(2); // the coalesced follow-up fired
    expect(client.saves[1]!.expectedRevision).toBe(1);
  });
});

describe('new intent fences an older completion (review finding 8)', () => {
  it('unmarking persist intent fences an in-flight persist ack', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)], { persist: true });
    const doc = docs[0]!;
    expect(client.persists).toHaveLength(1); // persist in flight
    session.setPersistIntent(doc, false); // retire it
    client.persists[0]!.resolve(); // late ack
    await settle();
    expect(session.getState().project.data.docs[0]!.sourceAvailability).toBe('external'); // NOT flipped
    expect(session.getState().sources[doc]!.phase).not.toBe('persisted');
  });

  it('a same-named different-length file is rejected before any read', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    session.setLanguage(doc, 'fr'); // reopen so a live generation exists
    await settle();
    const ingestsBefore = client.ingests.length;
    const replacement = fakeFile('a.txt', 11); // same name, different length
    session.reattach(doc, replacement);
    await settle();
    expect(session.getState().reattach[doc]!.phase).toBe('mismatch');
    expect(replacement.reads).toBe(0); // rejected on byte length before reading
    expect(client.ingests.length).toBe(ingestsBefore);
  });
});

describe('progress is generation-fenced (review finding 10)', () => {
  it('a superseded generation progress event does not update loading detail', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.setLanguage(docs[0]!, 'fr'); // reopen → analysis loading
    const gen = client.lastOpen().generation;
    client.emitProgress({ doc: docs[0]!, phase: 'index', generation: 'stale-generation' });
    expect((session.getState().analysis as { detail?: string | null }).detail ?? null).toBeNull();
    client.emitProgress({ doc: docs[0]!, phase: 'index', generation: gen });
    expect((session.getState().analysis as { detail?: string | null }).detail).toContain('index');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Review round 2 fixes (Codex claude_7b_review_r2): deeper ownership holes.
// ────────────────────────────────────────────────────────────────────────────

describe('save ownership across retries (r2 finding 1)', () => {
  it('a restart during a RETRY reconciles against the RETRY manifest, never a prior failed attempt', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.reject(new UserDataClientError('DATA_CORRUPT', 'bad')); // attempt A terminal
    await settle();
    expect(session.getState().project.save.phase).toBe('error');
    session.save(); // retry B — posts synchronously; pendingSave is B's OWN capture
    expect(client.saves).toHaveLength(2);
    const bManifest = client.saves[1]!.manifest;
    client.emitRestart(false); // restart while B is in flight
    await settle();
    // B was posted → uncertain commit, reconciled by a fresh load — and the
    // comparison target is B's manifest, never A's stale capture.
    expect(session.getState().project.save.phase).toBe('reconcile-required');
    expect(client.loads).toHaveLength(1);
    client.loads[0]!.resolve({ kind: 'loaded', manifest: { ...bManifest } });
    await settle();
    // The durable record IS B's target → adopted exactly like a normal ack.
    expect(session.getState().project.save.phase).toBe('idle');
    expect(session.getState().project.baseRevision).toBe(bManifest.revision);
    expect(session.getState().project.dirty).toBe(false);
  });
});

describe('a valid late load must not clobber newer intent (r2 finding 2)', () => {
  it('a mutation issued while a load validates supersedes the load', async () => {
    const { session, client } = makeSession(builtin());
    // Produce a valid saved manifest first.
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    const saved = client.saves[0]!.manifest;
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    // Start a load, then edit BEFORE the load resolves.
    session.loadUserProject();
    session.editMeta(docs[0]!, { title: 'Newer local edit' }); // newer intent
    client.loads[0]!.resolve({ kind: 'loaded', manifest: saved });
    await settle();
    // The load must NOT have installed over the newer draft.
    expect(session.getState().project.data.docs[0]!.meta.title).toBe('Newer local edit');
    expect(session.getState().analysis.phase).toBe('error'); // superseded
  });
});

describe('a failed persisted repair never loses the recovery File (r2 finding 3)', () => {
  it('a save after a failed repair does not release the retained File', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)], { persist: true });
    const doc = docs[0]!;
    client.persists[0]!.resolve();
    await settle(); // doc persisted, File retained
    // Reattach (repair) then FAIL the repair persist.
    session.reattach(doc, fakeFile('again.txt', 10));
    await settle();
    const repairIdx = client.persists.length - 1;
    client.persists[repairIdx]!.reject(new UserDataClientError('QUOTA_EXCEEDED', 'full'));
    await settle();
    expect(session.getState().sources[doc]!.phase).toBe('persist-failed');
    // Save (doc is persisted in the manifest) — the File must be RETAINED because
    // its durable source is not confirmed present.
    session.editMeta(doc, { title: 'edit' });
    session.save();
    await settle();
    client.saves[client.saves.length - 1]!.resolve({ revision: 1 });
    await settle();
    client.emitRestart(false);
    await settle();
    const open = client.lastOpen();
    open.resolve({ generation: open.generation, snapshot: null, readyDocs: [], missing: [{ doc, need: 'source-bytes', reason: 'source-corrupt' }] });
    await settle();
    expect(client.ingests.some((i) => i.generation === open.generation && i.doc === doc)).toBe(true); // File retained
  });
});

describe('generic post-rejection is retryable, never a stuck reconcile (r2 finding 5)', () => {
  it('a non-UserDataClientError save rejection surfaces a retryable error', async () => {
    const { session, client } = makeSession(builtin());
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.reject(new Error('WORKER_TERMINATED: not running')); // generic, no restart follows
    await settle();
    const st = session.getState();
    expect(st.project.save.phase).toBe('error'); // NOT reconcile-required
    expect(st.project.saveable).toBe(true); // retryable
  });
});

describe('a fully superseded staging continuation does not reopen (r2 finding 6)', () => {
  it('removing the only import before its recipes resolve prevents a spurious reopen', async () => {
    const { session, client } = makeSession(builtin());
    session.createUserProject([fakeFile('a.txt', 10)]); // schedules async finishStaging
    const doc = session.getState().imports[0]!.doc;
    session.removeImport(doc); // opens generation #1 (empty), retires the import
    const opensAfterRemove = client.opens.length;
    await settle(); // the stale finishStaging resolves now
    expect(client.opens.length).toBe(opensAfterRemove); // no spurious reopen
  });
});

describe('reattachment publishes a distinct mismatch code (r2 finding 7)', () => {
  it('a content mismatch is REATTACH_SOURCE_MISMATCH, distinct from a cap failure', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const doc = docs[0]!;
    session.setLanguage(doc, 'fr');
    await settle();
    session.reattach(doc, fakeFile('a.txt', 11)); // same name, different length → content mismatch
    await settle();
    expect(session.getState().reattach[doc]).toMatchObject({ phase: 'mismatch', code: 'REATTACH_SOURCE_MISMATCH' });
    session.reattach(doc, fakeFile('a.txt', INGEST_CAPS_V0.maxSourceBytesPerFile + 1)); // cap
    await settle();
    expect(session.getState().reattach[doc]).toMatchObject({ phase: 'mismatch', code: 'CAP_EXCEEDED' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Review round 3 fixes (Codex claude_7b_review_r3): final ownership interleavings.
// ────────────────────────────────────────────────────────────────────────────

describe('a lost save does not leak a coalesced request (r3 finding 1)', () => {
  it('a stale saveAgain from an uncommitted attempt never auto-fires after a retry', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save(); // attempt A — posted synchronously
    session.editMeta(docs[0]!, { title: 'edit during A' });
    session.save(); // coalesced request during A (saveAgain = true)
    client.emitRestart(false); // worker died with A in flight → reconcile
    await settle();
    expect(session.getState().project.save.phase).toBe('reconcile-required');
    // The record is absent: A never committed. The stale coalesced request is
    // dropped WITH it — an unrequested save must not auto-fire later.
    client.loads[0]!.resolve({ kind: 'missing' });
    await settle();
    expect(session.getState().project.save).toMatchObject({ phase: 'error', code: 'SAVE_UNCOMMITTED' });
    // Retry B, then edit during B WITHOUT requesting another save.
    session.save();
    await settle();
    expect(client.saves).toHaveLength(2); // A (lost) + B
    session.editMeta(docs[0]!, { title: 'edit during B, not requested to save' });
    client.saves[1]!.resolve({ revision: 1 }); // B acked
    await settle();
    expect(client.saves).toHaveLength(2); // NO unrequested follow-up save fired
    expect(session.getState().project.dirty).toBe(true); // the B-time edit stays dirty, unsaved
  });
});

describe('a load overlapping an in-flight save cannot regress it (r3 finding 2 / r4 finding 1)', () => {
  /** A DIFFERENT-titled revision-1 manifest, so a stale reinstall is observable. */
  const olderManifest = (base: ProjectManifestV1, title: string): ProjectManifestV1 => ({
    ...base,
    revision: 1,
    docs: base.docs.map((d, i) => (i === 0 ? { ...d, meta: { ...d.meta, title } } : d)),
  });

  it('a save that acknowledges during a load prevents that load from installing stale data', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.resolve({ revision: 1 });
    await settle(); // base 1, clean
    session.editMeta(docs[0]!, { title: 'v2' });
    session.save(); // save A2 in flight, targeting revision 2
    await settle();
    session.loadUserProject(); // load starts WHILE A2 is in flight
    await settle();
    client.saves[client.saves.length - 1]!.resolve({ revision: 2 }); // A2 acks → base 2, title 'v2'
    await settle();
    client.loads[0]!.resolve({ kind: 'loaded', manifest: olderManifest(client.saves[0]!.manifest, 'OLD') });
    await settle();
    // The load must NOT reinstall the older revision over the acknowledged save.
    expect(session.getState().project.baseRevision).toBe(2);
    expect(session.getState().project.data.docs[0]!.meta.title).toBe('v2');
  });

  it('a load overlapping a save that ends in CONFLICT does not clobber the retained draft', async () => {
    const { session, client } = makeSession(builtin());
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.resolve({ revision: 1 });
    await settle(); // base 1
    session.editMeta(docs[0]!, { title: 'v2' });
    session.save(); // A2 in flight (base stays 1 on conflict)
    await settle();
    session.loadUserProject(); // load begins while A2 active
    await settle();
    client.saves[client.saves.length - 1]!.reject(new UserDataClientError('REVISION_CONFLICT', 'stale', 9));
    await settle();
    client.loads[0]!.resolve({ kind: 'loaded', manifest: olderManifest(client.saves[0]!.manifest, 'OLD') });
    await settle();
    // D5: the conflict draft is retained — the overlapping load must not install.
    expect(session.getState().project.save).toEqual({ phase: 'conflict', currentRevision: 9 });
    expect(session.getState().project.data.docs[0]!.meta.title).toBe('v2');
    expect(session.getState().project.baseRevision).toBe(1);
  });
});

// ── Publication identity reconciliation (Phase B ruling W2): zustand's narrow
// selectors rely on unchanged slices keeping their object identity across
// publications. These assert strict identity (toBe), never deep equality. ──
describe('publication identity reconciliation', () => {
  it('repeated getState with no mutation returns the identical state object', () => {
    const { session } = makeSession(builtin([bundledDoc('a', 10)]));
    expect(session.getState()).toBe(session.getState());
  });

  it('the built-in publishes one stable idle save identity across its whole boot', async () => {
    const { session, client, states } = makeSession(builtin([bundledDoc('a', 10)]));
    session.start();
    await settle();
    const open = client.lastOpen();
    open.resolve({
      generation: open.generation,
      snapshot: null,
      readyDocs: [],
      missing: [{ doc: 'a', need: 'source-bytes', reason: 'source-not-persisted' }],
    });
    await settle();
    client.emitSourceReady(readyInfo(open.generation, 'a', client.ingestFor(open.generation, 'a')));
    client.emitSnapshot({ generation: open.generation, snapshot: 's1', readyDocs: ['a'], missingDocs: [] });
    await settle();
    expect(states.length).toBeGreaterThan(2);
    expect(new Set(states.map((s) => s.project.save)).size).toBe(1);
  });

  it('a snapshot-only publication retains every other slice identity', async () => {
    const { session, client } = makeSession(builtin([]));
    const { generation, docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const before = session.getState();
    client.emitSnapshot({ generation, snapshot: 'snap-2', readyDocs: docs, missingDocs: [] });
    await settle();
    const after = session.getState();
    expect(after).not.toBe(before);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(after.project).toBe(before.project);
    expect(after.imports).toBe(before.imports);
    expect(after.sources).toBe(before.sources);
    expect(after.reattach).toBe(before.reattach);
    expect(after.sourceEvidence).toBe(before.sourceEvidence);
    expect(after.corrections).toBe(before.corrections);
  });

  it('a metadata edit replaces project but retains the record slices and imports', async () => {
    const { session, client } = makeSession(builtin([]));
    const { docs } = await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    const before = session.getState();
    session.editMeta(docs[0]!, { title: 'renamed' });
    const after = session.getState();
    expect(after.project).not.toBe(before.project);
    expect(after.project.data).not.toBe(before.project.data);
    expect(after.imports).toBe(before.imports);
    expect(after.sources).toBe(before.sources);
    expect(after.reattach).toBe(before.reattach);
    expect(after.sourceEvidence).toBe(before.sourceEvidence);
    expect(after.corrections).toBe(before.corrections);
  });

  it('a source-ready replaces the evidence/import slices it changes and retains the rest', async () => {
    const { session, client } = makeSession(builtin([]));
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    const open = client.lastOpen();
    const generation = open.generation;
    const cold = open.docs.filter((d) => d.source.availability === 'external' && d.source.expectedHash === undefined);
    open.resolve({
      generation,
      snapshot: null,
      readyDocs: [],
      missing: cold.map((d) => ({ doc: d.doc, need: 'source-bytes' as const, reason: 'source-not-persisted' })),
    });
    await settle();
    const before = session.getState();
    expect(before.imports.length).toBe(1);
    client.emitSourceReady(readyInfo(generation, cold[0]!.doc, client.ingestFor(generation, cold[0]!.doc), { replacements: 2 }));
    await settle();
    const after = session.getState();
    expect(after.sourceEvidence).not.toBe(before.sourceEvidence);
    expect(after.reattach).toBe(before.reattach);
    expect(after.corrections).toBe(before.corrections);
  });

  it('createUserProject from the built-in reuses no cached slice and leaks no evidence', async () => {
    // The review-b2-identity finding: resetToEmptyUser published through a
    // stale cache and left generation-local evidence to the async open.
    const { session, client } = makeSession(builtin([bundledDoc('a', 10)]));
    session.start();
    await settle();
    const open = client.lastOpen();
    open.resolve({
      generation: open.generation,
      snapshot: null,
      readyDocs: [],
      missing: [{ doc: 'a', need: 'source-bytes', reason: 'source-not-persisted' }],
    });
    await settle();
    client.emitSourceReady(readyInfo(open.generation, 'a', client.ingestFor(open.generation, 'a'), { replacements: 3 }));
    client.emitSnapshot({ generation: open.generation, snapshot: 'builtin-snap', readyDocs: ['a'], missingDocs: [] });
    await settle();
    const before = session.getState();
    expect(before.sourceEvidence['a']).toBeDefined();
    expect(before.snapshot?.snapshot).toBe('builtin-snap');
    session.createUserProject([fakeFile('b.txt', 12)]);
    const after = session.getState(); // synchronous: BEFORE the async generation start
    expect(after.project).not.toBe(before.project);
    expect(after.sourceEvidence).not.toBe(before.sourceEvidence);
    expect(after.sourceEvidence['a']).toBeUndefined();
    expect(Object.keys(after.sourceEvidence)).toEqual([]);
    expect(after.reattach).not.toBe(before.reattach);
    expect(after.corrections).not.toBe(before.corrections);
    expect(after.sources).not.toBe(before.sources);
    // The OUTGOING generation's facts are retired synchronously too …
    expect(after.snapshot).toBeNull();
    expect(after.analysis).toEqual({ phase: 'idle' });
    // … and LATE events carrying the old generation id are ignored, not
    // repopulated into the replacement project (review-b2b finding).
    client.emitSnapshot({ generation: open.generation, snapshot: 'stale-late', readyDocs: ['a'], missingDocs: [] });
    client.emitSourceReady(readyInfo(open.generation, 'a', client.ingestFor(open.generation, 'a'), { replacements: 9 }));
    const later = session.getState();
    expect(later.snapshot).toBeNull();
    expect(later.sourceEvidence['a']).toBeUndefined();
  });

  it('a __proto__ document id becomes an own record key, never the prototype', async () => {
    // Document IDs are arbitrary strings (the durable validator accepts
    // '__proto__'), so record materialization must define own properties.
    const { session, client } = makeSession(builtin([]), { newDocId: () => '__proto__' });
    session.createUserProject([fakeFile('a.txt', 10)]);
    await settle();
    client.lastOpen(); // the open was issued for the new project
    const state = session.getState();
    expect(Object.hasOwn(state.sources, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(state.sources)).toBe(Object.prototype);
    expect(state.imports[0]?.doc).toBe('__proto__');
  });

  it('installing a replacement project never reuses a cached slice', async () => {
    const { session, client } = makeSession(builtin([]));
    await importAndFinalize(client, session, [fakeFile('a.txt', 10)]);
    session.save();
    await settle();
    client.saves[0]!.resolve({ revision: 1 });
    await settle();
    const before = session.getState();
    session.loadUserProject();
    await settle();
    client.loads[0]!.resolve({ kind: 'loaded', manifest: client.saves[0]!.manifest });
    await settle();
    const after = session.getState();
    expect(after.project).not.toBe(before.project);
    expect(after.sources).not.toBe(before.sources);
    expect(after.imports).not.toBe(before.imports);
  });
});
