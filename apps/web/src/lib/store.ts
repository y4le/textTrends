/**
 * UI state — zustand, per synthesis §8. Only handles, metadata, and bounded
 * results live here; corpus arrays and texts stay worker-side.
 *
 * Multi-series intent (owner feedback round 5, Codex-consulted design):
 * the input is a comma-separated comparison of up to MAX_SERIES terms. Each
 * becomes a SeriesIntent with a SEMANTIC id (the folded query surface under
 * the group's match mode) — never the raw display spelling — so 'Holmes' and
 * 'hólmes' are one series. Trend results key off SeriesIntent.id in an
 * immutably-replaced map; a missing entry is impossible to confuse with
 * pending or failed because every issued series is seeded 'pending'.
 *
 * Intent discipline (UI review round 1, extended): trend intent and KWIC
 * intent carry SEPARATE epochs. Changing the compared terms or the snapshot
 * cancels and reissues both; changing only the focused series cancels and
 * reissues ONLY the KWIC query — the trend lines are still correct and must
 * not flicker. A result is written only if its epoch and snapshot both still
 * match, so a slow stale query can never relabel itself. Corpus loading is
 * idempotent in this long-lived layer (Strict Mode double-mount safe) and
 * validates each fetched source against the bundled manifest.
 */

import { create } from 'zustand';
import {
  DEFAULT_INDEX_RECIPE,
  foldKey,
  tokenKey,
  type NumericTrend,
  type TermGroupSpec,
} from '@texttrends/core';
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

export const MAX_SERIES = 5;
export const BINS = 40;

const MATCH = { case: 'folded' as const, diacritics: 'folded' as const };
const LOCALE = 'en';

export interface SeriesIntent {
  /** Semantic identity: the folded query surface — not the display spelling. */
  readonly id: string;
  /** The first-seen user spelling, preserved for display. */
  readonly label: string;
  /** Fixed visual slot (color + dash) — stable for the life of the intent. */
  readonly styleSlot: number;
}

export type SeriesTrendState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly trend: NumericTrend }
  | { readonly status: 'error'; readonly message: string };

export interface KwicState {
  readonly seriesId: string;
  readonly state:
    | { readonly status: 'pending' }
    | { readonly status: 'ready'; readonly total: number; readonly rows: readonly KwicRowView[] }
    | { readonly status: 'error'; readonly message: string };
}

export type TrendView = 'series' | 'by-book';

/** Comma-separated comparison → ordered semantic series (first spelling wins).
 *  More than MAX_SERIES distinct series is an explicit refusal, not a silent
 *  truncation. Exported for fixtures. */
export function parseSeries(input: string):
  | { readonly series: readonly SeriesIntent[]; readonly error: null }
  | { readonly series: null; readonly error: string } {
  const series: SeriesIntent[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim();
    if (label === '') continue;
    // Same normalization chain the worker's resolver applies — the semantic
    // id must equal what the query will actually match on.
    const id = foldKey(tokenKey(label, DEFAULT_INDEX_RECIPE), MATCH, LOCALE);
    if (series.some((s) => s.id === id)) continue;
    series.push({ id, label, styleSlot: series.length });
  }
  if (series.length > MAX_SERIES) {
    return { series: null, error: `Compare up to ${MAX_SERIES} terms` };
  }
  return { series, error: null };
}

export interface AppState {
  snapshot: SnapshotInfo | null;
  loadingPhase: string | null;
  loadError: string | null;
  /** Raw committed input (the draft lives in the form component). */
  input: string;
  series: readonly SeriesIntent[];
  inputError: string | null;
  focusedSeries: string | null;
  /** Seeded 'pending' per issued series — panels must not show stale arrays. */
  trends: ReadonlyMap<string, SeriesTrendState>;
  kwic: KwicState | null;
  trendView: TrendView;

  loadSherlock(): Promise<void>;
  setInput(input: string): void;
  setFocus(seriesId: string): void;
  setTrendView(view: TrendView): void;
  runQueries(): void;
}

export function createAppStore(client: ClientLike) {
  let loadStarted = false;
  let generationCounter = 0;
  let attemptToken = 0;          // ownership of the in-flight fetch loop
  let attemptGeneration = '';    // the generation the CURRENT attempt owns
  let trendEpoch = 0;
  let kwicEpoch = 0;
  let trendCancels: (() => void)[] = [];
  let kwicCancel: (() => void) | null = null;

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

    /** Group/member ids derive from the series' semantic id — evidence
     *  provenance must distinguish the compared groups. */
    const groupFor = (s: SeriesIntent): TermGroupSpec => ({
      id: `g:${s.id}`,
      members: [{ id: `m:${s.id}`, kind: 'token', surface: s.label, match: MATCH }],
      countOverlaps: false,
    });

    const runKwic = () => {
      kwicCancel?.();
      kwicCancel = null;
      const myEpoch = ++kwicEpoch;
      const { snapshot, series, focusedSeries } = get();
      // focusedSeries is canonical: setInput/setFocus maintain the invariant
      // that it names a live series whenever any series exist.
      const focused = series.find((s) => s.id === focusedSeries);
      if (!snapshot || !focused) {
        set({ kwic: null });
        return;
      }
      set({ kwic: { seriesId: focused.id, state: { status: 'pending' } } });
      const handle = client.query(snapshot.snapshot, {
        op: 'kwic',
        selection: { docs: [...snapshot.readyDocs] },
        group: groupFor(focused),
        request: {
          contextTokens: 6,
          sort: [{ at: 'doc', dir: 1 }, { at: 'pos', dir: 1 }],
          page: { offset: 0, limit: 50 },
        },
      });
      kwicCancel = handle.cancel;
      const current = () =>
        kwicEpoch === myEpoch && get().snapshot?.snapshot === snapshot.snapshot;
      void handle.result
        .then((data) => {
          if (data.op === 'kwic' && current()) {
            set({
              kwic: {
                seriesId: focused.id,
                state: { status: 'ready', total: data.total, rows: data.rows },
              },
            });
          }
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          if (message === 'cancelled' || !current()) return; // superseded — the newer epoch owns the panel
          set({ kwic: { seriesId: focused.id, state: { status: 'error', message } } });
        });
    };

    const initialSeries = parseSeries('Holmes, Moriarty').series ?? [];
    return {
      snapshot: null,
      loadingPhase: null,
      loadError: null,
      input: 'Holmes, Moriarty',
      series: initialSeries,
      inputError: null,
      // Canonical from the start: the store, not the panels, decides the
      // default focus (review round 5 — a derived fallback left the pressed
      // chip and the recorded focus disagreeing).
      focusedSeries: initialSeries[0]?.id ?? null,
      trends: new Map(),
      kwic: null,
      trendView: 'series',

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

      setInput(input) {
        const parsed = parseSeries(input);
        if (parsed.error !== null) {
          // Refused intent still supersedes the old one: cancel and clear so
          // stale lines are never displayed beside the error.
          set({ input, inputError: parsed.error, series: [], focusedSeries: null });
        } else {
          const { focusedSeries } = get();
          const stillFocused = parsed.series.some((s) => s.id === focusedSeries);
          set({
            input,
            inputError: null,
            series: parsed.series,
            // Surviving focus is preserved even if its position changed;
            // otherwise the first series becomes the actual (not implied) focus.
            focusedSeries: stillFocused ? focusedSeries : parsed.series[0]?.id ?? null,
          });
        }
        get().runQueries();
      },

      setFocus(seriesId) {
        if (get().focusedSeries === seriesId) return;
        if (!get().series.some((s) => s.id === seriesId)) return;
        set({ focusedSeries: seriesId });
        runKwic(); // KWIC intent only — trend lines are still correct
      },

      setTrendView(view) {
        set({ trendView: view }); // presentation-only: no query is reissued
      },

      runQueries() {
        const { snapshot, series } = get();
        // Trend intent changed: ALWAYS cancel superseded work, clear to
        // pending, and invalidate the epoch — even when the new intent runs
        // no query (round 2: a blank input must not relabel old evidence).
        for (const cancel of trendCancels) cancel();
        trendCancels = [];
        const myEpoch = ++trendEpoch;
        if (!snapshot || series.length === 0) {
          set({ trends: new Map() });
          runKwic(); // clears or re-targets the evidence panel consistently
          return;
        }

        const issuedSnapshot = snapshot.snapshot;
        set({
          trends: new Map(series.map((s) => [s.id, { status: 'pending' } as const])),
        });
        const current = () =>
          trendEpoch === myEpoch && get().snapshot?.snapshot === issuedSnapshot;

        for (const s of series) {
          const handle = client.query(issuedSnapshot, {
            op: 'trend',
            selection: { docs: [...snapshot.readyDocs] },
            group: groupFor(s),
            request: { coordinate: 'declared-sequence', binsPerDoc: BINS },
          });
          trendCancels.push(handle.cancel);
          const write = (state: SeriesTrendState) =>
            set((prev) => {
              const next = new Map(prev.trends); // NEVER mutate the resident map
              next.set(s.id, state);
              return { trends: next };
            });
          void handle.result
            .then((data) => {
              if (data.op === 'trend' && current()) write({ status: 'ready', trend: data.trend });
            })
            .catch((e: unknown) => {
              const message = e instanceof Error ? e.message : String(e);
              if (message === 'cancelled' || !current()) return;
              // A genuine failure must mark ITS series, not silently vanish
              // — and must not erase successful peers.
              write({ status: 'error', message });
            });
        }

        runKwic();
      },
    };
  });

  return store;
}
