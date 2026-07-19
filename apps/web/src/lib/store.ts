/**
 * UI state — zustand, per synthesis §8. Only handles, metadata, and bounded
 * results live here; corpus arrays and texts stay worker-side.
 *
 * Intent discipline (UI review round 1): every reissue cancels the previous
 * query handles, clears results to a pending state, and stamps a
 * monotonically increasing epoch — a result is written only if BOTH its
 * epoch and its snapshot still match, so a slow stale query can never
 * relabel itself as the current term. Corpus loading is idempotent in this
 * long-lived layer (Strict Mode double-mount safe) and validates each
 * fetched source against the bundled manifest before ingesting.
 */

import { create } from 'zustand';
import type { NumericTrend } from '@texttrends/core';
import type { SnapshotInfo } from './client.ts';
import type { GenerationDocSpec, QueryResultData } from '../worker/protocol.ts';

/** Manifest with the exact staged LF byte lengths and content-hash prefixes —
 *  a 200-with-HTML-shell response must never be indexed as a book, and a
 *  fixture compares every entry against the shipped assets (round 2: the
 *  first manifest carried pre-normalization CRLF sizes and rejected all six). */
export const SHERLOCK: readonly { doc: string; bytes: number; sha256Prefix: string }[] = [
  { doc: '1 - A Study in Scarlet - Arthur Conan Doyle', bytes: 244251, sha256Prefix: 'dfee04ef99ffe3d0' },
  { doc: '2 - The Sign of the Four - Arthur Conan Doyle', bytes: 236849, sha256Prefix: '81c87d8455b08a0e' },
  { doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle', bytes: 575804, sha256Prefix: '3552d466d95a92fb' },
  { doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle', bytes: 581689, sha256Prefix: '9ee3b066f7d761ab' },
  { doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle', bytes: 360865, sha256Prefix: '6f2bd20772b2958e' },
  { doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle', bytes: 686382, sha256Prefix: '190bdeb3e25d6553' },
];

export interface KwicRowView {
  readonly doc: string;
  readonly pos: number;
  readonly left: string;
  readonly nodeText: string;
  readonly right: string;
}

/** The client surface the store consumes — injectable for race fixtures. */
export interface ClientLike {
  onSnapshot(listener: (info: SnapshotInfo) => void): void;
  onProgress(listener: (p: { doc: string; phase: string }) => void): void;
  onIngestError(listener: (generation: string, message: string) => void): void;
  beginGeneration(generation: string, docs: readonly GenerationDocSpec[]): void;
  ingest(generation: string, doc: string, bytes: ArrayBuffer): void;
  query(
    snapshot: string,
    query: unknown,
  ): { result: Promise<QueryResultData>; cancel: () => void };
}

export interface AppState {
  snapshot: SnapshotInfo | null;
  loadingPhase: string | null;
  loadError: string | null;
  term: string;
  /** null = pending/none — panels must not show stale arrays. */
  trend: NumericTrend | null;
  kwic: { total: number; rows: readonly KwicRowView[] } | null;

  loadSherlock(): Promise<void>;
  setTerm(term: string): void;
  runQueries(): void;
}

const BINS = 40;

export function createAppStore(client: ClientLike) {
  let loadStarted = false;
  let generationCounter = 0;
  let attemptToken = 0;          // ownership of the in-flight fetch loop
  let attemptGeneration = '';    // the generation the CURRENT attempt owns
  let epoch = 0;
  let activeCancels: (() => void)[] = [];

  const store = create<AppState>((set, get) => {
    client.onSnapshot((snapshot) => {
      set({ snapshot });
      get().runQueries();
    });
    client.onProgress((p) => set({ loadingPhase: `${p.phase}: ${p.doc.slice(0, 40)}` }));
    client.onIngestError((generation, message) => {
      // Only a failure from the CURRENT attempt's generation fails the
      // attempt — late stale errors from a superseded generation must not
      // corrupt a completed retry's state (round 4).
      if (generation !== attemptGeneration) return;
      attemptToken++; // invalidate the failed attempt's fetch loop
      loadStarted = false;
      set({ loadError: message });
    });

    const group = (term: string) => ({
      id: 'g1',
      members: [
        {
          id: 'm1',
          kind: 'token' as const,
          surface: term,
          match: { case: 'folded' as const, diacritics: 'folded' as const },
        },
      ],
      countOverlaps: false,
    });

    return {
      snapshot: null,
      loadingPhase: null,
      loadError: null,
      term: 'Holmes',
      trend: null,
      kwic: null,

      async loadSherlock() {
        if (loadStarted) return; // idempotent — Strict Mode double-mount safe
        loadStarted = true;
        set({ loadError: null }); // cleared once per deliberate attempt
        const token = ++attemptToken; // this loop OWNS the attempt while current
        const generation = `gen-${++generationCounter}`;
        attemptGeneration = generation;
        const base = `${import.meta.env.BASE_URL ?? '/'}corpora/sherlock/`;
        client.beginGeneration(
          generation,
          SHERLOCK.map(({ doc, bytes }) => ({ doc, language: 'en', sourceByteLength: bytes })),
        );
        for (const { doc, bytes } of SHERLOCK) {
          try {
            const response = await fetch(base + encodeURIComponent(doc));
            if (attemptToken !== token) return; // superseded while awaiting
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const buffer = await response.arrayBuffer();
            if (attemptToken !== token) return; // superseded while awaiting
            if (buffer.byteLength !== bytes) {
              throw new Error(`expected ${bytes} bytes, received ${buffer.byteLength}`);
            }
            client.ingest(generation, doc, buffer);
          } catch (e) {
            if (attemptToken !== token) return; // a superseded attempt may not mutate state
            loadStarted = false; // allow retry without a page reload
            set({
              loadError: `failed to load '${doc}': ${e instanceof Error ? e.message : String(e)}`,
            });
            return;
          }
        }
      },

      setTerm(term) {
        set({ term });
        get().runQueries();
      },

      runQueries() {
        const { snapshot, term } = get();
        // Intent changed: ALWAYS cancel superseded work, clear to pending, and
        // invalidate the epoch — even when the new intent runs no query
        // (round 2: a blank term must not relabel old evidence).
        for (const cancel of activeCancels) cancel();
        activeCancels = [];
        const myEpoch = ++epoch;
        set({ trend: null, kwic: null });
        if (!snapshot || term.trim() === '') return;

        const docs = [...snapshot.readyDocs];
        const g = group(term.trim());
        const current = () => epoch === myEpoch && get().snapshot?.snapshot === snapshot.snapshot;

        const trendQuery = client.query(snapshot.snapshot, {
          op: 'trend',
          selection: { docs },
          group: g,
          request: { coordinate: 'document-relative', binsPerDoc: BINS },
        });
        activeCancels.push(trendQuery.cancel);
        void trendQuery.result
          .then((data) => {
            if (data.op === 'trend' && current()) set({ trend: data.trend });
          })
          .catch(() => undefined); // cancelled/superseded — the newer epoch owns the panels

        const kwicQuery = client.query(snapshot.snapshot, {
          op: 'kwic',
          selection: { docs },
          group: g,
          request: {
            contextTokens: 6,
            sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
            page: { offset: 0, limit: 50 },
          },
        });
        activeCancels.push(kwicQuery.cancel);
        void kwicQuery.result
          .then((data) => {
            if (data.op === 'kwic' && current()) set({ kwic: { total: data.total, rows: data.rows } });
          })
          .catch(() => undefined);
      },
    };
  });

  return store;
}
