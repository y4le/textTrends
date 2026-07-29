/**
 * The shared WorkerEngineV4 test harness (slice-2 ruling §A seam alignment):
 * the FilterStore (hide/corrupt/hook any artifact class), the message-
 * recording engine wrapper, and the begin/ingest drivers — moved VERBATIM
 * from engine-v4.test.ts so the user-data suite can drive the same engine
 * without duplicating the seam. Behavior is unchanged.
 */

import { WorkerEngineV4, type UserDataAccess, type UserDataProvider } from '../../src/worker/engine-v4.ts';
import { InMemoryArtifactStore, type ArtifactStore, type CacheRead } from '../../src/worker/store.ts';
import { InMemoryUserDataStore } from '../../src/worker/user-data-store.ts';
import { PROTOCOL_VERSION_V4, type FromWorkerV4, type GenerationDocSpecV4 } from '../../src/worker/protocol-v4.ts';
import { DEFAULT_INDEX_RECIPE, INGEST_CAPS_V0, type IngestCapsV0 } from '@texttrends/core';

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const buf = (s: string): ArrayBuffer => utf8(s).buffer as ArrayBuffer;

export const FOLD = { case: 'folded', diacritics: 'sensitive' } as const;

/** A store that can hide any artifact class (force a miss) to construct the
 *  warm-path table deterministically, and optionally hook the first read of a
 *  class (to interleave a concurrent ingest). Delegates everything else. */
export class FilterStore implements ArtifactStore {
  hide = { text: false, shard: false, structure: false, extraction: false };
  onShardRead: (() => void | Promise<void>) | null = null;
  /** Called on every text read with the 1-based read count, so a test can
   *  interleave at a specific point (e.g. the 2nd document's read). */
  onTextRead: ((count: number) => void | Promise<void>) | null = null;
  private textReads = 0;
  resetReads() { this.textReads = 0; }
  writes = { text: 0, shard: 0, structure: 0, extraction: 0 };
  /** When set, the NEXT get{Shard,Text} reports envelope corruption, then reverts. */
  corruptShardOnce = false;
  corruptTextOnce = false;
  shardDeletes = 0;
  textDeletes = 0;
  constructor(readonly inner: InMemoryArtifactStore) {}
  async getText(h: string): Promise<CacheRead<string>> {
    this.textReads++;
    if (this.onTextRead) await this.onTextRead(this.textReads);
    if (this.corruptTextOnce) { this.corruptTextOnce = false; return { kind: 'corrupt', reason: 'stored text failed envelope validation' }; }
    return this.hide.text ? { kind: 'miss' } : this.inner.getText(h);
  }
  putText(h: string, t: string) { this.writes.text++; return this.inner.putText(h, t); }
  deleteText(h: string) { this.textDeletes++; return this.inner.deleteText(h); }
  async getShard(k: never): Promise<CacheRead<unknown>> {
    if (this.onShardRead) { const cb = this.onShardRead; this.onShardRead = null; await cb(); }
    if (this.corruptShardOnce) { this.corruptShardOnce = false; return { kind: 'corrupt', reason: 'stored record failed envelope validation' }; }
    return this.hide.shard ? { kind: 'miss' } : this.inner.getShard(k);
  }
  putShard(k: never, s: never) { this.writes.shard++; return this.inner.putShard(k, s); }
  deleteShard(k: never) { this.shardDeletes++; return this.inner.deleteShard(k); }
  async getExtraction(k: never): Promise<CacheRead<unknown>> { return this.hide.extraction ? { kind: 'miss' } : this.inner.getExtraction(k); }
  putExtraction(k: never, a: unknown) { this.writes.extraction++; return this.inner.putExtraction(k, a); }
  deleteExtraction(k: never) { return this.inner.deleteExtraction(k); }
  async getStructure(k: never): Promise<CacheRead<unknown>> { return this.hide.structure ? { kind: 'miss' } : this.inner.getStructure(k); }
  putStructure(k: never, a: unknown) { this.writes.structure++; return this.inner.putStructure(k, a); }
  deleteStructure(k: never) { return this.inner.deleteStructure(k); }
  close() { this.inner.close(); }
}

export interface Harness {
  engine: WorkerEngineV4;
  messages: FromWorkerV4[];
  transferLists: (readonly Transferable[] | undefined)[];
  store: FilterStore;
  userStore: InMemoryUserDataStore;
  setUserData(p: UserDataProvider): void;
  /** Fires on every emitted message — deliver interleaved messages here. */
  onEmit(cb: ((m: FromWorkerV4) => void) | null): void;
  /** Fires on every yieldControl checkpoint (auto mode) — interleave here. */
  onYield(cb: (() => void | Promise<void>) | null): void;
  manual(): void;
  releaseYield(): void;
  send(m: Record<string, unknown>): Promise<void>;
  handle(m: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
  last<T extends FromWorkerV4['t']>(t: T): Extract<FromWorkerV4, { t: T }>;
  all<T extends FromWorkerV4['t']>(t: T): Extract<FromWorkerV4, { t: T }>[];
  clear(): void;
}

export function harness(caps: IngestCapsV0 = INGEST_CAPS_V0, sharedStore?: FilterStore): Harness {
  const messages: FromWorkerV4[] = [];
  const transferLists: (readonly Transferable[] | undefined)[] = [];
  const store = sharedStore ?? new FilterStore(new InMemoryArtifactStore());
  const userStore = new InMemoryUserDataStore();
  let provider: UserDataProvider = () => Promise.resolve({ kind: 'ok', store: userStore } as UserDataAccess);
  let auto = true;
  let emitCb: ((m: FromWorkerV4) => void) | null = null;
  let yieldCb: (() => void | Promise<void>) | null = null;
  const pending: (() => void)[] = [];
  const engine = new WorkerEngineV4(
    store,
    () => provider(),
    (m, transfers) => { messages.push(m); transferLists.push(transfers); emitCb?.(m); },
    async () => {
      if (yieldCb) await yieldCb();
      if (!auto) await new Promise<void>((resolve) => pending.push(resolve));
    },
    caps,
  );
  return {
    engine,
    messages,
    transferLists,
    store,
    userStore,
    setUserData: (p) => { provider = p; },
    onEmit: (cb) => { emitCb = cb; },
    onYield: (cb) => { yieldCb = cb; },
    manual: () => { auto = false; },
    releaseYield: () => pending.shift()?.(),
    send: (m) => engine.handle({ v: PROTOCOL_VERSION_V4, ...m }),
    handle: (m) => engine.handle(m),
    flush: () => new Promise<void>((r) => setTimeout(r, 0)),
    last: (t) => {
      const found = [...messages].reverse().find((m) => m.t === t);
      if (!found) throw new Error(`no message of type ${t}`);
      return found as never;
    },
    all: (t) => messages.filter((m) => m.t === t) as never,
    clear: () => { messages.length = 0; },
  };
}

export async function begin(h: Harness, docs: GenerationDocSpecV4[], generation = 'g') {
  await h.send({ t: 'begin-generation', job: 1, generation, docs, indexRecipe: DEFAULT_INDEX_RECIPE });
}
export async function coldIngest(h: Harness, generation: string, doc: string, text: string, job: number) {
  await h.send({ t: 'ingest', job, generation, doc, bytes: buf(text) });
}

export const wolfGroup = { id: 'g1', members: [{ id: 'm1', kind: 'token' as const, surface: 'wolf', match: FOLD }], countOverlaps: false };
