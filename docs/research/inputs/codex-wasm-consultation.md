# Recommendation: make the core portable, but keep the first canonical implementation in TypeScript

My recommendation is **TS-first, deliberately portable, with a benchmark-gated path to coarse-grained WASM accelerators**. I would not make Rust/WASM the foundation now. I would keep the analysis package free of React, DOM, and worker assumptions; run that same package behind a Web Worker in the app and behind a thin Node CLI adapter; and design the typed contract so a Rust implementation can replace a whole operation later.

Confidence: **about 80%**. The uncertainty is concentrated at the 50M-token tier, where peak memory and high-cardinality passes could expose a real Rust advantage. It is not concentrated at ordinary-novel scale, KWIC, frequency trends, or the product's first-result path.

This is not “never Rust.” It is a sequencing decision: establish semantics and measure the actual pipeline before paying for a second language and an FFI boundary.

## 1. Realistic performance for this workload

There is no useful single “WASM speedup” number here. The pipeline has several different cost shapes:

| Stage | Likely Rust/WASM advantage | Why |
|---|---:|---|
| Decode, normalize, segment | Unknown; plausibly slower to moderately faster | TS delegates segmentation to native `Intl.Segmenter`. A Rust core would either call back into it, losing much of the point, or use ICU4X, changing segmentation behavior and paying UTF-8/UTF-16 conversion and data costs. This needs a vertical benchmark, not an assumption. |
| Vocabulary interning and index construction | Potentially meaningful at 50M; probably modest at novel scale | Rust can use packed structures and lower-overhead hash tables. But the final token, offset, and postings arrays are already unboxed typed arrays in TS; the advantage is mainly in transient allocation and dictionary construction, not the steady-state scan. |
| Frequency, dispersion, keyness, sentiment aggregation, most collocation scans | Usually modest | These are linear scans or postings traversals over compact integers. Once JS is operating on typed arrays in a hot loop, both engines are commonly limited by memory traffic. WASM can win, but a dramatic end-to-end win should not be presumed. |
| N-gram counting, MinHash/LSH, some clustering | Best candidates for a substantial win | High-cardinality hashing, allocation, pruning, and dense numeric kernels give Rust more room to improve both time and peak memory. These operations also have naturally coarse numeric inputs and outputs. |
| KWIC and reader excerpts | Little benefit; possibly a loss if put on the wrong side | The fast part is finding integer positions. The visible work is slicing the original JS string and constructing rows. The right native/WASM result is a batch of character spans, with JS materializing strings. Passing strings through WASM repeatedly would be architectural self-harm. |

For the common counting passes, I would expect anything from parity to perhaps a modest multiple in a favorable tight kernel, but I would plan the product as though the **end-to-end** improvement were small until a benchmark includes input conversion, memory copies, module startup, output materialization, and cache serialization. A 3x microbenchmark on an inner loop can readily become a 10–30% pipeline improvement if segmentation, hashing, or JS string work dominates. Conversely, an n-gram implementation that replaces large JS `Map` structures with a purpose-built table could deliver a genuinely material time and memory improvement.

The 50M tier is at least as much a memory-lifecycle problem as a language problem. At 50M tokens, just one token-ID array and one start-offset array are about 200 MB each; postings collectively contain roughly another position per token before metadata, text, vocabulary, results, and construction transients. Document partitioning, incremental disposal, cache representation, and avoiding duplicate buffers will matter more than a small instruction-throughput advantage. Adding WASM as a second owner of an existing JS index can make peak memory worse. Rust helps only if it owns the representation rather than receiving copies of it.

One argument on the table deserves qualification: lack of `SharedArrayBuffer` prevents the normal shared-memory/Rayon-style threaded WASM build on GitHub Pages, but it does not make all WASM work literally single-threaded. Independent Web Workers can each host a WASM instance and process document shards. That is the same coarse parallelism available to JS, with extra module/heaps and a merge step. So browser threading is not a decisive TS victory, but it removes one of native Rust's most attractive advantages and makes a full WASM rewrite much less compelling.

Progressive loading and IndexedDB also change the economic value of cold-path speed. If the first completed document is queryable in a few seconds and a warm reopen avoids tokenization, halving total corpus ingest may be less valuable than it sounds. Interactive recurring queries and out-of-memory failures deserve more weight than a one-time cold total.

## 2. Where the maintenance cost lands

For a solo maintainer, Rust/WASM is not merely “some Rust code.” It creates additional surfaces:

- Rust and JavaScript build toolchains, dependency updates, bundler glue, generated bindings, source maps, release artifacts, and a browser/native CI matrix.
- An ABI and ownership protocol: who allocates buffers, whether memory may grow, when JS views must be refreshed, how cancellation and progress cross the boundary, and how panics/errors become typed worker errors.
- Two debugging environments for one user action. A bad KWIC result could arise from normalization, Rust offsets, generated bindings, worker transport, JS slicing, or UI logic.
- Cache/version compatibility between Rust-produced bytes, TypeScript schemas, IndexedDB records, project exports, and native CLI files.
- Unicode offset semantics. `Intl.Segmenter` indices match JavaScript's UTF-16 string coordinate system; Rust naturally works with UTF-8 byte offsets. Either Rust must explicitly produce UTF-16 offsets or the system needs a durable mapping. Getting this wrong fails exactly the non-ASCII cases where the project wants to be principled.
- Distribution work for the native CLI: target builds, checksums, platform packaging, and possibly signing. A single binary is excellent for users, but it is not free for its maintainer.

Rust's benefits—explicit ownership, compact structures, excellent native tooling, and one lexical implementation shared by native and WASM—are real. But “one implementation guarantees identical results” is too strong. Browser and native builds can still differ through segmentation data/version, floating-point reduction order, or threaded ordering unless those are specified and tested. More importantly, wink-nlp remains JavaScript. A native Rust CLI either embeds/launches a JS runtime for that pack, omits those analyses, or gains a second NLP implementation. A full Rust lexical core therefore does not make the whole product canonical.

The stronger guarantee is a **specified analysis contract plus golden conformance fixtures**: normalization recipe, segmentation/analyzer version, offset unit, deterministic ordering, numerical tolerances, and expected outputs. That is required in either language and does more for trustworthiness than source-language identity alone.

“Exemplary” here should mean that the scientific meaning is small, readable, versioned, and tested. A dependency-free strict-TS package can satisfy that very well. Cross-language machinery introduced before it solves a measured problem would make the code more impressive-looking but less legible as a whole.

## 3. Is a WASM lexical core plus JS NLP pack livable?

It is livable only with a **coarse seam and a single clear owner of the index**. It becomes a mess if “shared token arrays” implies frequent cross-language calls or mutable joint ownership.

In one worker realm, JavaScript can view arrays backed by WebAssembly memory without copying. That still requires disciplined memory growth and lifetime rules. Across separate workers, ordinary WASM memory is not a freely transferable shared heap; copies or independent shards reappear. Persisting the index also needs an explicit byte format.

Wink is unlikely to consume the lexical core's token-ID array as its native input. It has its own text/token pipeline and annotations. The stable integration is therefore source offsets: run wink on document text, validate its boundaries against the lexical tokenizer, and attach annotations by source span or by a tested alignment table. That reconciliation exists even with a pure-TS lexical core. Replacing `Intl.Segmenter` with ICU4X adds another tokenizer and another possible disagreement; it does not remove the seam.

The good hybrid shape is:

1. JS/TS remains the orchestrator and owns raw text, recipes, progress, cancellation, cache keys, and the public typed protocol.
2. A WASM operation receives a few immutable numeric buffers and scalar parameters in one batch.
3. It returns numeric aggregates, token positions, or character-span pairs in one batch.
4. JavaScript performs string slicing, wink integration, provenance assembly, and UI transport.

That shape suits n-gram counting, MinHash, clustering math, and possibly a specialized index builder. It does not suit per-token callbacks, string-returning KWIC, or an object-oriented engine whose methods alternate between JS and WASM hundreds of times per query.

If a full Rust core is eventually chosen, it should be a vertical owner—bytes/text in, persistent index plus batched query results out—not a Rust half-index continually negotiated with JavaScript.

## 4. What a real CLI user loses with Node

A Node CLI is a real CLI, not a development consolation prize. It can stream files/stdin, use worker threads, emit JSON/CSV, run headlessly in CI, and reuse the exact TS analysis functions. For an analysis that reads tens of megabytes or more, Node startup time is irrelevant. The large corpus arrays also dwarf much of the runtime's baseline memory.

The user does lose some things relative to a native binary:

- A runtime prerequisite and its version management; installation is less pleasant for non-JavaScript researchers and locked-down/offline machines.
- A larger trust/distribution surface if installation is through npm rather than a signed standalone artifact.
- Less convenient deployment in minimal containers, HPC environments, and arbitrary shell pipelines where Node is not already standard.
- Some peak-memory control, straightforward memory mapping, and the easiest path to multicore native throughput with Rayon.
- The possibility of embedding the engine as a native library in other tools.
- Perfectly pinned segmentation behavior unless the Node/ICU version is part of the recipe. Browser versus Node `Intl.Segmenter` should be treated as conformance-tested implementations, not assumed bit-identical forever.

What the user does **not** inherently lose is correctness, reproducibility, ordinary-corpus throughput, scripting ergonomics, or batch operation. A versioned Node CLI with a lockstep analyzer version and machine-readable provenance can be a serious research tool.

The product question matters. If the CLI is a companion for automation, benchmarks, reproducible exports, and power users of the web app, Node is the better initial trade. If the CLI is intended to become an independently adopted Unix/HPC tool, installed by people with no relationship to the web app, then runtime-free distribution and native parallelism become product requirements rather than aesthetic preferences.

## 5. Concrete decision triggers

I would write these gates down before implementation so the result is not decided by language enthusiasm.

### Move one pass to WASM when all of these are true

- On the agreed mid-range reference machine, an optimized TS implementation misses a user-facing budget—for example, a recurring interactive pass exceeds about 2 seconds at 10M tokens, or an explicitly on-demand pass exceeds about 10 seconds at 50M—or its construction peak causes browser failure.
- Profiling shows the pass itself, not segmentation, transport, string construction, or rendering, is the dominant cost (roughly 25% or more of the relevant end-to-end path).
- A vertical Rust/WASM prototype, including copies/initialization and output conversion, is at least about **2x faster end-to-end** or reduces peak memory by at least **30%** on representative and adversarial corpora.
- The improvement holds in the supported browser set, not only in one engine, and the module accepts/returns coarse numeric data with exact golden-output parity.

The first candidates should be high-cardinality n-grams, MinHash/LSH, and bounded clustering kernels—not KWIC or basic frequency counts. The TS implementation can remain as the conformance oracle and fallback until the WASM path is mature.

### Move the whole lexical core to Rust when one of these product conditions exists, plus a vertical spike succeeds

- The native CLI becomes a first-class standalone product with runtime-free installation, HPC/batch use, native library consumers, or regular corpora well beyond the browser's 50M tier.
- The supported 50M browser tier repeatedly OOMs or badly misses the cold-index budget after document sharding, allocation profiling, TS data-layout work, and incremental lifecycle improvements.
- Several foundational operations—not merely experimental passes—have independently moved to WASM, so dual ownership and repeated buffer conversion are now more complex than one Rust-owned engine.
- Pinned tokenizer data and cross-environment lexical determinism become a hard requirement, and the owner is willing to replace `Intl.Segmenter` semantics with a specified ICU4X-based recipe everywhere.

Before that flip, build one end-to-end Rust slice: ingest representative Unicode text, tokenize, construct the full positional index, persist/reload it, answer frequency/phrase/KWIC-span/collocation queries, and feed the JS NLP alignment. Require something like **2x lower 50M cold time or 30–40% lower peak memory**, no regression in first-document latency, exact contract conformance, and acceptable browser bundle/startup cost. If it only wins a tight scan while complicating offsets and wink integration, do not flip.

The numerical thresholds are proposed decision policy, not claims about current performance. They should be adjusted once the Phase 0 benchmark names actual UX budgets, but the principle should remain: measure total user-visible paths and memory peaks, not isolated loops.

## 6. What I would do now

I would implement the Phase 0 contract in TypeScript and make portability visible immediately:

- Put domain types and pure analysis functions in a platform-neutral package. No React, DOM, IndexedDB, or `postMessage` inside it.
- Make segmentation an injected adapter whose output contract fixes offset units and provenance. Use `Intl.Segmenter` first; record runtime/analyzer metadata and test browser/Node fixtures.
- Keep index buffers immutable at the analysis boundary and use batched operations returning typed numeric results or spans. This is already the future WASM seam.
- Add a small Node CLI early, at least for conformance fixtures, benchmark execution, and JSON/CSV analysis. This proves portability without committing to a second toolchain.
- Benchmark by stage at 1M/10M/50M: cold and warm time, first-document time, recurring query latency, peak resident/JS/WASM memory where available, cache size, and output parity. Include high-vocabulary and non-ASCII corpora, not only novels with friendly distributions.
- Do not preemptively build Rust production code. If the 50M tier fails, prototype the hottest coarse pass first. Let that exercise validate the contract and reveal the real FFI cost before considering a full core.

So: **yes to a portable engine and a CLI; no to equating portability with Rust today**. The current architecture already has the right option value. TypeScript maximizes delivery speed and semantic clarity for the product-defining work, while the typed protocol, immutable arrays, golden fixtures, and benchmark gates preserve a credible path to Rust exactly where evidence later supports it.
