# Benchmarks

These are dated local measurements with explicit fixture and method limits.
They support architectural decisions, not a guarantee for every device or a
claim that formal 10M/50M-token tiers pass. Run commands from the repo root;
[development](../development.md#measure-performance) lists the harnesses.
Historical six-volume Sherlock samples predate the current nine-volume corpus
and cannot be reproduced byte-for-byte with today's fixture.

## Hidden query scheduling

The [hidden-query measurement](hidden-query-measurement.md) records query traffic
and rendering clocks during import, selection, and later tab visits. It preserves
the eager policy and defines the evidence needed for a controlled alternative.

## Occurrence streaming promotion gate

Keep bounded materialization unless a fresh-process adversarial run on the
largest checked-in corpus crosses any threshold:

| Measurement | Promote above |
| --- | ---: |
| Successful cold occurrence construction | 250 ms |
| Phase-local sampled RSS growth over post-index/post-GC baseline | 128 MiB |
| Cap rejection | 500 ms |

Crossing promotes streaming/folding work across the shared occurrence/cache
contract for trend, Matches, dispersion, Reader, and passage. Transport-only
or cache-only changes do not remove synchronous construction delay.

```sh
node --expose-gc packages/cli/src/main.ts bench-occurrences text/ASOIF
```

The child builds the corpus, then signals separate near-cap success and
cap-pressure phases. The parent samples current Linux `/proc/<pid>/status` RSS
every millisecond only between each phase's ready/result signals. The baseline
is post-GC; this excludes the index build's earlier high-water mark. Without
Linux `/proc`, memory is marked unmeasured and cannot justify deferral.
Near-cap construction repeats an exact-token member; pressure uses overlapping
token, prefix, and common phrase members. Smaller corpora may not hit the cap.

### Occurrence sample, August 3, 2026

Linux dev machine; five ASOIF volumes, 1,759,717 tokens.

| Phase | Outcome | Cold | RSS delta | Samples | Cache read |
| --- | --- | ---: | ---: | ---: | --- |
| Exact `have`, 8,330 postings × 24 members | 199,920 occurrences; 3,998,404-byte payload | 33.4 ms | +35.5 MiB | 33 | hit, 0.001 ms |
| Folded `the` + prefix + phrase | Typed cap at raw match 200,001 | 42.0 ms | +40.0 MiB | 41 | miss, 0.001 ms |

Neither phase promotes streaming. Cache timings are only explicit harness map
reads; `query-executor.test.ts` separately proves failed construction does not
poison or evict the product cache. These results do not claim mid-kernel
cancellation; one capped synchronous computation remains the residual delay.
Earlier process-lifetime max-RSS subtraction was invalid because indexing
could own the high-water mark; only the phase-signalled samples above support
the memory conclusion.

## Trends overview kernel gates

Measure after occurrence acquisition, with five near-cap tracks and fresh
bounded scratch. These are machine-local promotion gates, not CI timings or
end-to-end latency claims. Discard the harness-reported warmups and use the
median of five iterations.

| Harness | Gate |
| --- | --- |
| `bench-company` | Median ≤100 ms; encoded output ≤8 KiB |
| `bench-destinations` | Planning ≤100 ms; winner materialization ≤5 ms; candidate scratch ≤64 KiB; encoded output ≤32 KiB |

### Overview sample, August 19, 2026

Linux dev machine, Node 24.14.1. Company uses document-valid shifted vectors
with offsets `[0,7,37,101,301]`, exercising all thirteen buckets and roughly
3.99 million directional visits. Duplicate tracks would exercise only the
overlap fast path and are not a representative timing fixture.

| Corpus | Company median / JSON | Destination planning / materialization | Scratch / JSON |
| --- | --- | --- | --- |
| Sherlock, historical 6 volumes | 42.3 ms / 3,818 B | 42.7 / 0.33 ms | 2,354 / 24,862 B |
| ASOIF, 5 volumes | 39.8 ms / 3,766 B | 59.1 / 0.28 ms | 1,965 / 24,901 B |

Destinations uses five interleaved 200,000-row tracks, permitting one million
distinct anchors and a full twelve-result/192-mark output. Mixed-script probes
measured 24.4–26.9 KiB while retaining Reader anchors and excerpt bounds. The
slowest median is 59.1 ms. The original ASOIF sample used a local non-versioned
copy; do not treat either historical row as a measurement of current source
bytes without rerunning.

## Index methodology and baseline

`bench <dir>` preloads files, excludes I/O, discards one warmup, and reports the
median of three measured runs; per-file rows come from the last run. With
`--expose-gc`, retained memory is the difference between a post-preload baseline
and post-GC retained final shards. Without it, samples are unattributable.
This measures a JIT-warmed single-thread process; fresh cold starts differ.

### Index sample, July 19, 2026

Linux dev machine, Node 24.

| Corpus | Characters / tokens | Median; iterations | Retained delta |
| --- | --- | --- | --- |
| Sherlock, historical 6 volumes | 2.63M / 462k | 237 ms; 237/239/234 | +2 MB heap, +7 MB array buffers |
| ASOIF, 5 volumes | 9.54M / 1.76M | 859 ms; 873/859/833 | ~0 MB heap, +26 MB array buffers |

Throughput was about 2M tokens/second; arrays used roughly 15 bytes/token.
Novel-sized ASOIF documents took 129–205 ms each, so first-document availability
was not “tens of milliseconds.” Uncollected transients and allocator-retained
RSS must not be attributed to retained shards. Extrapolation to 50M tokens
would be a residency hypothesis, not evidence of a satisfied budget.

## Browser methodology and gates

Playwright serves the production-shaped e2e build under `/textTrends/`.
Main-thread protocol-trace stamps define timings in
`apps/web/e2e/timings.bench.spec.ts`. Functional and compact WebKit projects
finish before the serial, no-retry benchmark project in a full local run.
CI isolates benchmarks on a separate runner. Do not run builds or functional
load concurrently with a sample in the same checkout.

Semantic gates cover zero-fetch/zero-retokenization warm reopen, one warm
snapshot, targeted corruption rebuild, buffer transfer, and stale-generation
rejection. Cancellation acknowledgment p95 must stay below 250ms; attributed
main-thread tasks must remain below the 100ms failure threshold. The 66-text,
five-exact-track Atlas gate also bounds canvas residency during first paint
and horizontal fling. At 1440px its derived structural ceiling is 15 canvases;
the original sample held 10 at first paint and 14 after fling.

### Browser samples

| Date and fixture | Recorded local result |
| --- | --- |
| July 20, 2026; Chromium 149, historical 6-volume Sherlock | Cold barrier 15ms; first book 50ms; all-ready 419ms; warm reopen 93ms; trend 3–15ms; cancellation p95 0.3ms |
| September 4, 2026; completed reliability/composition stack, Chromium benchmark project | Cold all-ready 539ms; warm reopen 186ms; cancellation p95 0.3ms; all five checks passed; no Atlas-attributed task reached 100ms in gated windows |

The September sample supersedes the pre-fix review's local timing snapshot;
it is retained evidence, not a fresh run from this documentation pass. Browser
versions, corpus revisions, and machine conditions differ across samples.
None establishes physical-device, screen-reader, or formal large-token-tier
performance. Worker transient clone/binding memory still needs attributable
trace/heap measurement; standard Performance API results alone do not provide it.

### Footer scheduling sample, August 9, 2026

Linux/headless Chromium with historical six-book Sherlock. After the intentional
120ms initial hover dwell, five distant positions were correlated on one clock
from pointer sample through query post, result, and fresh DOM. Removing the
second trailing passage debounce reduced continued scrub pointer→DOM from
128–134ms to a 14.9ms median (10.4ms scheduling, 2.9ms worker, 1.4ms DOM).
Pointer samples remained frame-coalesced and passage delivery single-flight/
latest-pending. The worker difference is sample variation, not a kernel change.
This remains a non-gating local sample.

## WASM promotion gate

Introduce WebAssembly only when an optimized TypeScript path misses a written
user-facing budget, profiling attributes at least roughly 25% of that path to
the candidate pass, and a vertical prototype improves representative end-to-end
work by at least 2× or peak memory by at least 30%. Heavy isolated future
kernels are plausible candidates; basic counts and Matches have no such case.
A native-core rewrite additionally needs a product requirement for a native
core and a successful end-to-end prototype.

## Synthetic engine scale, September 8, 2026

**Shipped caps reject the 50M-token fixture.** The 1M and 10M fixtures pass
admission with the shipped limits. The separate 50M engine run explicitly
raises only aggregate source/text caps to 512 MiB/512 Mi UTF-16 units. It does
not establish 50M-token product support or change the application caps.

```sh
node apps/web/bench/scale.mjs 1000000,10000000,50000000 /tmp/texttrends-scale.json
```

Requires Node 24 with its experimental TypeScript transform, invoked by the
parent for parameter-property support, and built workspace packages. Each
size/mode starts a fresh process running the real `WorkerEngineV4`. Source
creation is bounded to 200,000 tokens per document; documents use distinct
seeded xorshift32 streams over 1,024 four-letter ASCII words with Zipf exponent
1, sentences every 20 tokens and paragraphs every 100. The source-length
formula is checked against actual segmentation; a full-corpus Inventory
verifies the exact requested token count in every admitted run.

The harness includes source generation, extraction, indexing, incremental
binding and publication in its cold ingest clock. It uses task-queue yields,
structured-clones cache writes and discards them, and transfers query result
buffers through structuredClone. This exercises engine allocation without
keeping an artificial in-memory artifact cache. It does not time browser
message transport, IndexedDB I/O, rendering, or physical devices. Ingest and
binding are measured together; these data cannot assign individual allocation
costs to clone, verification, segmentation or index construction.

The parent samples Linux `/proc/<pid>/status` at requested 1 ms intervals only
between explicit child ready/result signals. Each phase supplies post-GC
baseline and retained `process.memoryUsage()`; peak RSS is a sampled lower
bound including that phase's work and final GC. Sampling counts are retained;
non-Linux peaks are unmeasured. RSS deltas include allocator retention and
must not be described as live object bytes. Source is generated after the
baseline, so ingest residency includes extracted text as well as indexes.

Each operation records two warmups followed by five measured repetitions.
Queries share the production executor's caches in the documented order
Inventory → Trends → dispersion → Vocabulary → Compare → Reader. Their
medians describe warm analytics; the first warmup remains in the artifact to
show cold cost. The one tracked term is vocabulary rank 901 and stays below
the occurrence cap. This does not cover frequent-term cap pressure, phrase
matching, mixed scripts, or realistic literary structure. Cold ingest has one
sample per size, not a statistical latency distribution.

| Fixture / admission | Cold ingest + bind | Sampled peak RSS | Post-GC RSS increase |
| --- | ---: | ---: | ---: |
| 1M / shipped caps | 1,548 ms | 244 MiB | 115 MiB |
| 10M / shipped caps | 8,575 ms | 622 MiB | 462 MiB |
| 50M / shipped caps | Rejected in 64 ms | 106 MiB at admission | — |
| 50M / engine override | 127,474 ms | 1,900 MiB | 1,769 MiB |

| Warm query median | 1M | 10M | 50M engine override |
| --- | ---: | ---: | ---: |
| Inventory | 21.3 ms | 103.1 ms | 563.0 ms |
| Trends | 0.4 ms | 3.0 ms | 3.1 ms |
| Dispersion | 0.6 ms | 2.1 ms | 1.3 ms |
| Vocabulary | 4.5 ms | 11.3 ms | 301.1 ms |
| Compare | 4.7 ms | 11.7 ms | 403.6 ms |
| Reader page | 0.3 ms | 0.5 ms | 0.9 ms |

[Raw phase samples](measurements/engine-scale-2026-09-08.json) record Node,
host, per-run load averages, source revision and harness hashes, seed, caps,
source size and memory fields. This capture shared the host with functional
browser tests and external work; wall times include that contention. Memory
is sampled from the benchmark child alone. These are local scaling
observations, not CI budgets or browser-tier validation. The next validation
step is attributable browser worker/IndexedDB memory on representative sources;
these data do not justify raising the product cap or replacing the engine.
