# Benchmark record

Preliminary observations against the synthesis (§6) hypotheses. These are two real
corpus points, not the formal 1M/10M/50M synthetic tiers (which join the suite with
the worker adapter) — treat extrapolations below as estimates, not evidence of a
satisfied budget.

**Method** (encoded in the harness): run
`node --expose-gc packages/cli/src/main.ts bench <dir>` (Node ≥ 22.12; no installed
`bin` yet). File contents are preloaded, so I/O is excluded; one warmup iteration is
discarded; the reported total is the **median of 3 measured iterations** (all totals
printed); per-file rows come from the final iteration. Memory is a **GC-baselined
delta**: collect after preload (baseline = sources + runtime), collect again with only
the final shard set retained, report the difference. Without `--expose-gc` the harness
prints raw samples explicitly labeled unattributable. Single process, single thread,
JIT-warmed — the steady state a long-lived worker sees on all but its first documents;
fresh-process cold starts will be slower.

## 2026-07-19 — shard-index implementation (GC-baselined harness), dev machine (Linux, Node 24)

| Corpus | Chars | Tokens | Median segment+build | Iterations (ms) | Rate | Retained-shard delta |
|---|---:|---:|---:|---|---:|---|
| Sherlock (6 vols) | 2.63M | 462k | 237 ms | 237 / 239 / 234 | ~1.95M tok/s | +2 MB heap, +7 MB arrayBuffers |
| ASOIF (5 vols) | 9.54M | 1.76M | 859 ms | 873 / 859 / 833 | ~2.05M tok/s | ~0 MB heap, +26 MB arrayBuffers |

Readings (preliminary):

- Warmed throughput is flat (~2M tokens/s) across a 3.6× corpus-size range;
  `Intl.Segmenter` and index build split the cost roughly evenly.
- **Retained shard memory is dominated by the typed arrays** (arrayBuffers): ~26 MB
  for 1.76M tokens ≈ 15 bytes/token, consistent with the contract's array layout.
  An earlier draft of this record attributed ~190 MB of uncollected transients to the
  shards — corrected by the GC-baselined harness after review caught the
  misattribution. (Raw process rss remains high after a run because the allocator
  retains pages; it is not shard cost.)
- Per-document times on ASOIF's novel-sized files ran 129–205 ms — so under
  progressive per-document delivery (T1), the first book of a large corpus becomes
  queryable in roughly 130–210 ms, not "tens of ms" (earlier draft overclaimed).
- Naive extrapolation to a 50M-token corpus: ~24 s of warmed single-threaded compute
  and ~750 MB of retained typed arrays — the compute is comfortable; the memory
  suggests the 50M tier will need the contract's per-document lifecycle (not all
  shards resident at once) or sharded eviction. The formal tiers plus a
  browser-worker measurement must confirm both before the §8.10 WASM tripwires are
  declared safe, though nothing here approaches them.

## 2026-07-20 — first real-browser baseline (M6 Playwright suite), dev machine (Linux, headless Chromium 149)

**Method**: the serial `chromium-benchmark` Playwright project against the
e2e-mode production build served by `vite preview` under `/textTrends/`. Clocks
are main-thread protocol-trace stamps (definitions in
`apps/web/e2e/timings.bench.spec.ts`); one local run, bundled Sherlock corpus
(6 docs, ~462k tokens). Machine-local numbers — a GitHub-runner baseline must be
collected from CI artifacts before any threshold beyond the cancel budget is
frozen (Codex M6 consult: unmeasured numbers must not become CI policy).

| Clock | Measured |
|---|---:|
| Cold begin → cache barrier (`generation-ready`, all 6 missing) | 15 ms |
| First ingest post → first book queryable (T1) | 50 ms |
| First ingest post → all 6 books ready | 419 ms |
| **Warm reopen** (begin → all-ready barrier; zero fetch, zero re-tokenization) | **93 ms** |
| Trend query post → result (bundled corpus, single terms) | 3–15 ms |
| Cancel acknowledgement p95 (20 real acknowledgements) | 0.3 ms |

(The benchmark project runs AFTER the functional project completes and with
one worker — enforced in playwright.config.ts itself: `chromium-benchmark`
declares a project dependency on `chromium-functional` and pins
`workers: 1`, so one `pnpm e2e` invocation preserves the sequence and timing
samples never share the machine with functional load. `pnpm e2e:bench`
passes `--no-deps` for a deliberate timing-only run.)

Gates now enforced in CI (semantic, deterministic): warm reload performs zero
corpus fetches and zero decode/segment/index phases and publishes exactly one
snapshot; corruption repair rebuilds only the damaged document with no fetch and
persists; ingest buffers and trend result buffers demonstrably transfer
(detached after post); a replaced generation never publishes stale state; no
main-thread task ≥ 100 ms during cold analysis + a query burst; cancel-ack
p95 < 250 ms (the phase-1 plan's stated budget — measured 0.2 ms).

**Open, tracked, deliberately not claimed** (plan M6 scope revision per the M6
consult): the formal synthetic 1M/10M/50M-token tiers have still not joined the
harness — the bundled browser corpus is ~462k tokens — and no eviction/residency
policy exists yet to measure at the 10M/50M tiers. Peak transient worker memory
(structured clone + binding copies) needs a manual Chrome trace/heap profile;
the standard Performance API cannot attribute it. These move forward with the
user-ingest milestone, where corpora larger than the bundle first become real.
