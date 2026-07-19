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
