# Benchmark record

## Occurrence streaming promotion gate (written before measurement)

The bounded materialization cut remains the V1 architecture unless the
adversarial `bench-occurrences` case crosses any of these thresholds in a
fresh process on the largest checked-in corpus:

- cold occurrence construction exceeds **250 ms**, because one synchronous
  construction is the residual worst-case cancellation delay;
- the phase-local sampled RSS peak grows by more than **128 MiB** over its
  post-index, post-GC baseline; or
- a cap-rejected construction takes more than **500 ms** to reach its bound.

Crossing a threshold promotes a streaming/folding redesign, including its
cache contract, into active architecture work. A cache-only or transport-only
rewrite does not satisfy the gate: `NumericOccurrences` is shared by trend,
KWIC, dispersion, Reader, and passage, so the redesign must cover all of those
consumers coherently. Run:

`node --expose-gc packages/cli/src/main.ts bench-occurrences <corpus-dir>`

The benchmark builds the corpus in a child, then runs two signalled phases:

- a successful construction selected just below the cap by repeating one
  exact token member; and
- a cap-pressure `countOverlaps: true` token + prefix + repeated-common phrase
  group around the corpus's highest-frequency type; this corpus reaches the
  typed cap, while smaller corpora may complete successfully.

The parent samples the child's Linux `/proc/<pid>/status` current RSS every
1 ms only between each phase's ready/result signals. This excludes the index
build's earlier high-water mark. The reported memory number is the largest
sampled current-RSS increase over the phase's post-GC baseline, not a
process-lifetime `maxRSS` subtraction. On platforms without Linux `/proc`, the
JSON marks phase memory unmeasured; the 128 MiB gate is then explicitly
untested and cannot support a deferral claim. Each phase also reports its cold
kernel result (or typed cap) and an explicit cache read.

### 2026-08-03 — adversarial occurrence construction, dev machine

Command: `node --expose-gc packages/cli/src/main.ts bench-occurrences text/ASOIF`

| Corpus/phase | Input | Outcome | Cold time | Phase RSS peak delta | Warm cache |
|---|---|---|---:|---:|---|
| ASOIF (5 vols), near-cap | 1,759,717 tokens; exact `have` (8,330 postings) × 24 members | 199,920 occurrences; 3,998,404-byte typed payload | 33.4 ms | +35.5 MiB (33 samples) | hit, 0.001 ms |
| ASOIF (5 vols), cap pressure | folded `the` (87,271 raw exact-form postings) + prefix + phrase | typed cap at occurrence 200,001 | 42.0 ms | +40.0 MiB (41 samples) | miss, 0.001 ms |

Both the successful near-cap construction and the cap-rejected path stay well
below their promotion thresholds: 250 ms for successful cold construction,
500 ms to reject at the cap, and 128 MiB of sampled phase-local RSS growth.
The warm column is only an explicit in-process map read: it shows that the
successful phase produced a value the harness can retain and the rejected
phase produced no value to insert. The product-level guarantee that a failed
construction neither poisons nor evicts its occurrence cache is covered
separately in `apps/web/test/query-executor.test.ts`. On this Linux machine,
the measured latency and memory therefore do **not** promote the streaming
rewrite. They do not claim responsive mid-kernel cancellation; the residual
synchronous span remains one capped computation, measured here at 42.0 ms in
the rejected case.

An earlier version of this row reported a `+0.9 MiB` delta by subtracting
process-lifetime max-RSS before/after the phase. Review correctly found that
the index build could already own the high-water mark, making that delta
incapable of measuring occurrence memory. That number and its memory-based
conclusion are superseded by the phase-signalled samples above.

## WASM promotion gate

Add a WebAssembly implementation only when all three conditions hold:

- an optimized TypeScript implementation misses a written user-facing budget;
- profiling shows that pass consumes at least roughly 25% of the affected path;
  and
- a vertical prototype improves representative end-to-end work by at least 2×
  or reduces peak memory by at least 30%.

The first plausible candidates are isolated heavy kernels such as n-grams,
MinHash/LSH, or clustering—not KWIC or basic counts. Replacing the portable
TypeScript core with Rust requires both a product need for a native core and a
successful end-to-end spike; implementation-language preference is not a gate.

Preliminary observations against the original performance hypotheses. These are two
real corpus points, not the formal 1M/10M/50M synthetic tiers (which join the suite with
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
  browser-worker measurement must confirm both before the WASM promotion gate
  can be considered, though nothing here approaches it.

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

(The benchmark project runs AFTER the functional and compact WebKit projects
complete and with one worker — enforced in playwright.config.ts itself:
`chromium-benchmark` declares dependencies on `chromium-functional` and
`webkit-compact` and pins `workers: 1`, so one `pnpm e2e` invocation preserves
the sequence and timing samples never share the machine with functional load.
`pnpm --filter @texttrends/web e2e:bench` passes `--no-deps` for a deliberate
timing-only run.)

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

## 2026-08-09 — footer passage scheduling, dev machine (Linux, headless Chromium)

The footer passage path now has a permanent non-gating browser sample in
`apps/web/e2e/timings.bench.spec.ts`. After the intentional one-time 120 ms
fine-pointer entry dwell is armed, five widely separated corpus positions are
timed on one main-thread clock from pointer sample to query post, correlated
worker result, and fresh passage DOM. The bundled six-book Sherlock corpus and
the production-shaped e2e build are used; medians remain machine-local and do
not establish a CI budget.

| Passage path | Before | After |
|---|---:|---:|
| Continued cross-page scrub, pointer → fresh DOM | 128–134 ms | **14.9 ms median** |
| After breakdown | ~127–133 ms scheduling + ~0.5–0.7 ms worker + ~1.1–1.4 ms DOM | **10.4 ms scheduling + 2.9 ms worker + 1.4 ms DOM** |

The before sample was a direct browser measurement of the former 120 ms
trailing passage debounce. The after sample is the checked-in benchmark run
after removing that redundant timer; pointer samples remain frame-coalesced and
the passage lane remains single-flight/latest-pending. The worker difference is
ordinary run-to-run/corpus-cache variation at this scale, not a kernel change.
The first hover still intentionally waits 120 ms before taking over global
focus, but no longer stacks a second 120 ms passage delay after that dwell.
