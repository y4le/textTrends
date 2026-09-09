# Hidden query measurement

This is an observational baseline of the current eager policy, using the checked-in
nine-text Sherlock sample and five fresh Chromium browser contexts. The benchmark
runs serially with no retries. It uses the production-shaped E2E build and existing
passive protocol trace; no scheduling flag or production instrumentation is added.

```sh
pnpm --filter @texttrends/web exec playwright test hidden-queries.bench.spec.ts --project=chromium-benchmark --no-deps
```

The import scenario clicks the Sherlock sample in Inputs and immediately opens
Trends. Measure click to the first rendered trend path, query counts by operation,
and successful query post-to-result latency. After all requests have delivered or
been cancelled, measure each subsequent Vocabulary and Compare tab click to its
rendered table. The range scenario prepares Compare's selection-versus-rest mode,
returns to Trends, clears the old selection, and commits a new keyboard range.
Measure Enter to its first rendered selected trend overlay and the subsequent
Vocabulary/Compare switches. Each measured window clears the trace and rejects
ring overflow. JSON artifacts retain the traces, per-operation counts and timings.

Post-to-result latency includes message transfer, worker queueing, execution and
main-thread delivery. It is **not worker CPU time**. Latencies overlap and must not
be summed to estimate cost. Cancelled requests are counted separately and excluded
from successful latency distributions. Inventory counts combine shared baseline,
range inventory and Compare headers: the passive trace does not distinguish these
purposes. Shared baseline Inventory supplies token extents to Inputs, Reader,
position history and comparison complements, so it is not disposable hidden work.

The rendering probe uses a MutationObserver and animation-frame check, timestamps
on the browser's performance clock, and a layout visibility check. It measures a
rendering opportunity, not physical pixels on a display. Import timing includes
sample fetch/admission and opening Trends. Tab timing includes lazy module loading
on its first visit; range tab visits are warm. Main-thread automation poll delays
are excluded from the recorded clocks. The range is deliberately small (31 tokens)
and does not stand in for large selection or large-corpus tiers.

Before taking measurements, the decision rule is: retain scheduling unless a
controlled deferred variant improves median active-view result latency by both
50 ms and 15%, with no median later-tab regression above 100 ms, and preserves
all query/restore/cancellation contracts. A future comparison must interleave at
least five eager/deferred pairs on the same fixture. This baseline alone cannot
establish causal savings, and therefore cannot justify a scheduling change.

## Local sample, September 7, 2026

Linux aarch64, Node 24.14.1, Chromium 149.0.7827.0; five serial fresh contexts,
no failures or trace overflow. The [recorded samples](measurements/hidden-queries-2026-09-07.json)
identify the exact measured product tree. These are local observations, not CI
latency budgets or larger-corpus claims.

| Rendering clock | Median | Min–max |
| --- | ---: | ---: |
| Import click → first Trends path | 875.6 ms | 803.0–1080.7 ms |
| First Vocabulary visit after import | 309.4 ms | 305.1–310.8 ms |
| First Compare visit after import | 306.9 ms | 306.2–307.6 ms |
| Range commit → selected Trends overlay | 122.8 ms | 111.4–135.8 ms |
| Warm Vocabulary visit after range | 15.3 ms | 9.9–16.5 ms |
| Warm Compare visit after range | 10.6 ms | 10.3–11.8 ms |

Counts were identical in all five repetitions. The latency columns below pool
successful post-to-result intervals across the repetitions; median uses the mean
of the central pair for even samples, and p95 uses nearest rank.
At the sample sizes here (5, 10 and 15), that p95 is the maximum observed value;
the table labels it as max rather than implying a separate tail estimate.

| Window / operation | Issued per repetition | Cancelled per repetition | Successful intervals | Median / max |
| --- | ---: | ---: | ---: | ---: |
| Import / Inventory (all purposes) | 25 | 22 | 15 | 147.3 / 266.9 ms |
| Import / Vocabulary | 9 | 8 | 5 | 207.5 / 330.4 ms |
| Import / Compare rankings | 16 | 14 | 10 | 206.9 / 326.3 ms |
| Range / Inventory (all purposes) | 3 | 0 | 15 | 50.8 / 162.9 ms |
| Range / Vocabulary | 1 | 0 | 5 | 99.8 / 136.6 ms |
| Range / Compare rankings | 2 | 0 | 10 | 125.9 / 163.6 ms |

**Decision: keep eager scheduling.** Import produces 25 hidden ranking requests,
22 superseded before successful delivery. That is a useful candidate for a
controlled experiment, but cancelled requests do not reveal how much worker
computation was avoided or spent. The roughly 300 ms first-visit rendering cost
also remains after queries settle, while warm visits are much faster; query
scheduling alone cannot be assumed to remove that cost. The next investigation
should separate first-visit module/rendering delay from query delay and compare
an explicitly deferred policy under the decision rule above.

## First-place module readiness, September 8, 2026

The follow-up `cold-place.bench.spec.ts` separates module evaluation, the
place's first React render, the first region mutation, the target table/path's
DOM insertion, and a visible layout opportunity. Resource timings record each
new JS request. Each tab window asserts zero analysis requests; warm controls
revisit all three places. The source timing marks are guarded by `__TT_E2E__`
and the production bundle checker rejects their marker strings.

The initial five-context probe found Vocabulary/Compare modules ready in
24.4/17.1 ms median, while their table DOM arrived in 307.5/307.5 ms. The
installed React 19.2.7 source delays Suspense retry-lane commits until 300 ms
after the latest fallback commit. Early render marks followed by the delayed
DOM, with no tab queries, identify this fallback retry path as the cause of
the plateau. Trends had a second pair of nested lazy boundaries and reached
its first chart DOM in 342.9 ms median.

Place modules now resolve explicitly and publish readiness through component
state. Warm visits synchronously read a resolved module cache; concurrent
loads share one promise, rejected promises are evicted, and an effect-local
liveness guard prevents an obsolete load from replacing a newer destination.
The semantic place section and focus target remain mounted during loading.
Load failures still reach the existing error boundary. Dynamic import retry
also depends on the browser's module cache; the Reload app action remains the
recovery for cached network/evaluation failures.

Trends statically imports its chart and distribution into the lazy place
chunk, removing the redundant inner boundaries. Reader, utility panes and the
place descendant fallback retain Suspense. Query scheduling remains eager.

Five interleaved pairs alternated legacy/explicit order on the same working
tree, changing only the App and TrendsPlace module-loading policy. Each run
rebuilt the production-shaped artifact and used a fresh context. Local tests
were sequential; external host workload remained uncontrolled and is recorded
alongside the [paired samples](measurements/cold-place-2026-09-08.json).

| Click → visible layout median | Suspense modules | Explicit readiness |
| --- | ---: | ---: |
| Cold Trends | 357.3 ms | 141.3 ms |
| Cold Vocabulary | 311.9 ms | 66.9 ms |
| Cold Compare | 310.8 ms | 34.2 ms |
| Warm Trends | 89.4 ms | 59.4 ms |
| Warm Vocabulary | 27.5 ms | 19.0 ms |
| Warm Compare | 11.0 ms | 15.6 ms |

The cold improvement holds without prefetching; warm Compare's median changed
by 4.6 ms in this sample. These are local observations, not new CI latency
budgets. The explicit readiness path is adopted; eager analysis scheduling is
unchanged. Faster navigation also exposed a Matches remount requesting a
24-row default window before measuring its 30-row viewport. Its scroll owner
now waits for positive measured height; the existing navigation-only test
continues to require zero new queries after initial viewport acquisition.
