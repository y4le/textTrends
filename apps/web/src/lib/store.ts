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
  PASSAGE_MAX_TOKENS,
  tokenKey,
  type NumericTrend,
  type PassageResult,
  type TermGroupSpec,
} from '@texttrends/core';
import type { GenerationReady, SnapshotInfo } from './client.ts';
import type { GenerationDocSpec, QueryResultData } from '../worker/protocol.ts';

/** Manifest with the exact staged LF byte lengths and FULL content hashes —
 *  a 200-with-HTML-shell response must never be indexed as a book, and a
 *  fixture compares every entry against the shipped assets (round 2: the
 *  first manifest carried pre-normalization CRLF sizes and rejected all six).
 *
 *  `textHash` is the authoritative expected TextHash (M5 consult): these
 *  files are UTF-8 with no ill-formed sequences, so hashText(decoded text)
 *  equals the SHA-256 of the file bytes — the fixture asserts BOTH readings
 *  agree. It is the warm-reopen identity the worker rehydrates against;
 *  a mutable doc-label → hash cache must never outrank this manifest. */
export const SHERLOCK: readonly { doc: string; bytes: number; textHash: string }[] = [
  { doc: '1 - A Study in Scarlet - Arthur Conan Doyle', bytes: 244251, textHash: 'dfee04ef99ffe3d02e5fa014180cdd37a73ae993d7f07fe097692e4d3637837d' },
  { doc: '2 - The Sign of the Four - Arthur Conan Doyle', bytes: 236849, textHash: '81c87d8455b08a0e2e9bb9eadb98bda3789431045d307d831d0e74fd978bcf5d' },
  { doc: '3 - The Adventures of Sherlock Holmes - Arthur Conan Doyle', bytes: 575804, textHash: '3552d466d95a92fb58e96bbfabbfc02370d359ac95933b5feafe4ebaf3f243b3' },
  { doc: '4 - The Memoirs of Sherlock Holmes - Arthur Conan Doyle', bytes: 581689, textHash: '9ee3b066f7d761abc5e012510cb1d4e636254976c655494a721537d695647b1d' },
  { doc: '5 - The Hound of the Baskervilles - Arthur Conan Doyle', bytes: 360865, textHash: '6f2bd20772b2958e7b6683f3e790f12d58f5c6506cbf38743dfd36318ef8262e' },
  { doc: '6 - The Return of Sherlock Holmes - Arthur Conan Doyle', bytes: 686382, textHash: '190bdeb3e25d6553c3b6d6a3ec7fb677919ba336a1feb7dd0affb06b1c9a4c57' },
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
  onRestart(listener: (fatal: boolean) => void): void;
  openGeneration(
    generation: string,
    docs: readonly GenerationDocSpec[],
    recipe: typeof DEFAULT_INDEX_RECIPE,
  ): { result: Promise<GenerationReady>; cancel: () => void };
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

/** The scrubbed reading position — document-local, view-independent. */
export interface ScrubTarget {
  readonly doc: string;
  readonly token: number;
}

/** Tokens of headroom the loaded block must keep around the target before a
 *  refetch is scheduled — inside the band, scrubbing is purely local. */
export const SCRUB_GUARD_TOKENS = 28;

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
  scrub: ScrubTarget | null;
  /** The loaded passage block — may lag the scrub target while a fetch is in
   *  flight; the panel renders the block that CONTAINS the target only. */
  passage: PassageResult | null;

  loadSherlock(): Promise<void>;
  setInput(input: string): void;
  setFocus(seriesId: string): void;
  setTrendView(view: TrendView): void;
  setScrub(target: ScrubTarget): void;
  clearScrub(): void;
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
  // Scrub scheduling: ONE active passage request plus ONE replaceable pending
  // target — pointer motion never queues and never cancel-storms the worker.
  let scrubEpoch = 0;
  let passageActiveCancel: (() => void) | null = null;
  let passagePending: ScrubTarget | null = null;

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
    client.onRestart((fatal) => {
      // The worker died: its snapshots and resident state are gone, and any
      // in-flight fetch loop now feeds a dead generation. Reset and — if a
      // replacement is live — reload; rehydration makes that a warm reopen.
      attemptToken++;
      loadStarted = false;
      set({ snapshot: null, passage: null, scrub: null });
      if (fatal) {
        set({ loadError: 'the analysis worker crashed repeatedly; reload the page to retry' });
        return;
      }
      void get().loadSherlock();
    });

    /** Group/member ids derive from the series' semantic id — evidence
     *  provenance must distinguish the compared groups. */
    const groupFor = (s: SeriesIntent): TermGroupSpec => ({
      id: `g:${s.id}`,
      members: [{ id: `m:${s.id}`, kind: 'token', surface: s.label, match: MATCH }],
      countOverlaps: false,
    });

    /** The doc's token extent, if any ready trend result carries it. */
    const docTokenCountOf = (doc: string): number | null => {
      for (const [, state] of get().trends) {
        if (state.status !== 'ready') continue;
        const d = state.trend.order.indexOf(doc);
        if (d >= 0) return state.trend.docTokenCount[d] ?? null;
      }
      return null;
    };

    /** Would a fetch centered at `token` produce the block we already hold? */
    const blockServes = (passage: PassageResult, target: ScrubTarget): boolean => {
      if (passage.doc !== target.doc) return false;
      const { start, end } = passage.tokens;
      if (target.token < start || target.token >= end) return false;
      const tc = docTokenCountOf(target.doc);
      if (tc !== null && !passage.truncatedByCharCap) {
        // Exact: the block a refetch would serve (same construction as the
        // kernel) — identical block means the fetch is pure waste.
        const es = Math.max(0, Math.min(target.token - (PASSAGE_MAX_TOKENS >> 1), tc - PASSAGE_MAX_TOKENS));
        const ee = Math.min(tc, es + PASSAGE_MAX_TOKENS);
        if (es === start && ee === end) return true;
      }
      // Guard band: local navigation until the target nears a block edge.
      const lo = start === 0 ? start : start + SCRUB_GUARD_TOKENS;
      const hi = end - SCRUB_GUARD_TOKENS;
      return target.token >= lo && target.token < hi;
    };

    const pumpPassage = () => {
      if (passageActiveCancel !== null) return; // active request finishes first
      const target = passagePending;
      if (!target) return;
      passagePending = null;
      const { snapshot, series } = get();
      if (!snapshot || series.length === 0) return;
      const issuedEpoch = scrubEpoch;
      const issuedSnapshot = snapshot.snapshot;
      const handle = client.query(issuedSnapshot, {
        op: 'passage',
        request: {
          doc: target.doc,
          centerToken: target.token,
          maxTokens: PASSAGE_MAX_TOKENS,
          tracks: series.map((s) => ({ seriesId: s.id, group: groupFor(s) })),
        },
      });
      passageActiveCancel = handle.cancel;
      const current = () =>
        scrubEpoch === issuedEpoch && get().snapshot?.snapshot === issuedSnapshot;
      /** Only the CURRENT owner of the active slot may clear it and pump —
       *  a structurally superseded request's late settlement must not free
       *  the slot out from under its replacement. */
      const settleOwnership = () => {
        if (passageActiveCancel !== handle.cancel) return false;
        passageActiveCancel = null;
        return true;
      };
      void handle.result
        .then((data) => {
          if (!settleOwnership()) return;
          if (data.op === 'passage' && current()) set({ passage: data.passage });
          pumpPassage(); // a newer target may be parked in the pending slot
        })
        .catch((e: unknown) => {
          if (!settleOwnership()) return;
          const message = e instanceof Error ? e.message : String(e);
          if (message !== 'cancelled' && current()) {
            // A rejected center (stale geometry) or failed read: drop the
            // scrub rather than display a block that does not match it.
            set({ passage: null, scrub: null });
            passagePending = null;
            return;
          }
          pumpPassage();
        });
    };

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
      scrub: null,
      passage: null,

      async loadSherlock() {
        if (loadStarted) return; // idempotent — Strict Mode double-mount safe
        loadStarted = true;
        set({ loadError: null }); // cleared once per deliberate attempt
        const token = ++attemptToken; // this loop OWNS the attempt while current
        const generation = `gen-${++generationCounter}`;
        attemptGeneration = generation;
        const base = `${import.meta.env.BASE_URL ?? '/'}corpora/sherlock/`;
        // Warm-open (M5): assert each doc's authoritative TextHash so the
        // worker rehydrates whatever it has persisted, then AWAIT the
        // generation-ready barrier — bytes are fetched ONLY for its misses.
        let ready: GenerationReady;
        try {
          // Constructed INSIDE the boundary: a synchronous client fault must
          // fail this attempt visibly, not escape loadSherlock unhandled.
          const open = client.openGeneration(
            generation,
            SHERLOCK.map(({ doc, bytes, textHash }) => ({
              doc,
              language: 'en',
              sourceByteLength: bytes,
              expectedText: textHash,
            })),
            DEFAULT_INDEX_RECIPE,
          );
          ready = await open.result;
        } catch (e) {
          if (attemptToken !== token) return; // superseded while awaiting
          loadStarted = false;
          set({
            loadError: `failed to open the corpus: ${e instanceof Error ? e.message : String(e)}`,
          });
          return;
        }
        if (attemptToken !== token) return;
        const manifest = new Map(SHERLOCK.map((entry) => [entry.doc, entry]));
        for (const miss of ready.missing) {
          const entry = manifest.get(miss.doc);
          if (!entry) continue; // not a doc this manifest declared
          const { doc, bytes } = entry;
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

      setScrub(target) {
        const prev = get().scrub;
        if (prev && prev.doc === target.doc && prev.token === target.token) return;
        set({ scrub: target });
        const { passage } = get();
        if (passage && blockServes(passage, target)) return; // purely local move
        passagePending = target; // replaceable slot — motion never queues
        pumpPassage();
      },

      clearScrub() {
        // Presentational hide only — the loaded block stays as a warm cache
        // for the next scrub; pending work is dropped.
        passagePending = null;
        set({ scrub: null });
      },

      runQueries() {
        const { snapshot, series } = get();
        // Trend intent changed: ALWAYS cancel superseded work, clear to
        // pending, and invalidate the epoch — even when the new intent runs
        // no query (round 2: a blank input must not relabel old evidence).
        for (const cancel of trendCancels) cancel();
        trendCancels = [];
        const myEpoch = ++trendEpoch;
        // The loaded passage block and any in-flight/pending fetch belong to
        // the OLD series set / snapshot — marks would be stale evidence. The
        // scrub POSITION is kept; a fresh block is fetched below if possible.
        scrubEpoch++;
        passageActiveCancel?.();
        passageActiveCancel = null;
        passagePending = null;
        set({ passage: null });
        if (!snapshot || series.length === 0) {
          set({ trends: new Map(), scrub: null });
          runKwic(); // clears or re-targets the evidence panel consistently
          return;
        }
        const scrub = get().scrub;
        if (scrub) {
          passagePending = scrub;
          pumpPassage();
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
