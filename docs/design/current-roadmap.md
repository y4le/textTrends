# Roadmap

The current tree has one browser-local library/workspace, bounded worker
analysis, five workbench places, full-corpus Matches, Read/Atlas/Speed, guided
learning, and CI-backed Pages deployment. Source acquisition, workspace-save
feedback, damaged-record recovery, and Reader chrome consolidation are
implemented.
Portable [workspace backup and restore](workspace-backup.md) includes original
library sources, active workspace intent, and display/reading settings.
The [design index](README.md) owns their current contracts; this page contains
only remaining work and explicit deferrals (reconciled October 1, 2026).
The September review's dated [measurements](measurements/review-scale-2026-10-01.md)
record verification and its limits; the owning contracts below remain the
specifications.

## Publication and validation

- Resolve the [publication inventory](corpus-inventory.md): choose clean public
  export or history rewrite, exclude private sources and generated derivatives,
  update dependent builds/tests, and add repository licensing and notices.
  No publication cut or license choice is implied by documentation cleanup.
- Validate formal browser tiers and attributable worker/IndexedDB memory on
  representative sources. The [synthetic engine measurements](benchmarks.md#synthetic-engine-scale-september-8-2026)
  now cover 1M/10M with shipped caps and a separate 50M cap override, with
  transient/retained process memory. Shipped caps reject the 50M fixture;
  engine-only observations do not establish browser-tier support.
- Validate the tour with new readers and perform physical-device and
  screen-reader checks. Automated compact WebKit coverage is narrower evidence.

## Product opportunities

These are candidates for scoped work, not shipped behavior or a delivery order.

| Opportunity | Required decision or evidence |
| --- | --- |
| Result export | Choose complete-result versus displayed-row scope; include methods, filters, document ids/titles, corpus identity, and completeness. Tested provenance formatters have no production consumer. |
| Visible measurement captions | Reflect active bins/denominator/smoothing; label Compare's log₂ scale and independent rankings. |
| Compact results | Test a smaller initial destination list with Show more and clearer Company filtering; simplify initial Vocabulary columns without losing analytical access. |
| Large Inputs/library management | Extend existing literal library search with active-text search, sort, multiselect, and bulk activation/deactivation; expose selection counts. Temporary sort must not rewrite declared order. |
| Storage feedback | Add per-acquisition phase progress, quota pressure, and diagnostic filters while retaining the single lease and recoverable partial saves. |
| Input summaries | Resident term cells can yield document frequency; cumulative growth can yield order-dependent new types. Do not call either text-exclusive vocabulary. |
| Query suggestions | Add a bounded corpus-aware vocabulary query before suggestions or precommit hit estimates. Quote-to-phrase behavior needs tokenizer semantics. |
| Additional guides | Build a corpus, Matches/source, Compare two texts, Vocabulary filters, Read/Atlas, and Speed; prioritize from observed need. |
| Second-tab feedback | Restore epochs reject stale writers after replacement; broader proactive notice/write ownership remains open within the ordinary last-write-wins model. |

## Architecture follow-ups

Reader, Compare, and Vocabulary queries now have focused controllers inside the
single composed runtime. Trends issuance has shared typed helpers; query delivery
correlates live operation and snapshot identities. Inputs acquisition and App
utility/shortcut lifetimes have focused hooks, as does Speed playback. Preserve
initialization, lane-specific policies, shared geometry publication and disposal
when these owners change; a generic query registry is not a design goal.

The [hidden-query baseline](hidden-query-measurement.md) now records import and
range-change traffic, successful request-to-result clocks, and later tab rendering.
The paired module-readiness experiment removed the cold Suspense retry plateau
without changing eager scheduling. A controlled deferred-query comparison remains
conditional on query latency; tab-render savings do not establish scheduling savings.

Treat small normalization/locality cleanup and recurring UI primitives as
in-path work when a feature touches their owners. Do not preserve old helper
names as an unverified task list. Keep tests on behavior and boundaries rather
than incidental component names or exact CSS strings.

The September review's remaining medium/low claims still require validation
against their live owners before becoming work. The completed correctness and
scale sequence does not establish that every finding in that review is closed.

## Deferred designs

| Design | Gate or deciding reason |
| --- | --- |
| Streaming/folding occurrences | Promote only when the [written latency/RSS/cap gates](benchmarks.md#occurrence-streaming-promotion-gate) fail; redesign the shared consumer/cache contract together. |
| WASM or native core | Requires profiled budget failure and representative end-to-end improvement under the [promotion gate](benchmarks.md#wasm-promotion-gate). |
| Continuous Read | Decide paragraph outline versus estimated height; establish deep-jump, resize-anchor, memory, long-task, cross-window selection, and native-find baselines. Keep fitted Read until the replacement passes. |
| Reference prose | Follows Continuous Read and a residency benchmark; active text alone publishes the cursor, reference does not follow by locked scrolling, and two readable measures must fit. |
| Dedicated Atlas query | Only if resident density/residency fails the Reader gates; use bounded visible-document projection, not invented main-thread detail. |
| Cursor pinning, colon commands, footer RSVP | Earlier proposals remain unimplemented; justify a visible pointer/keyboard/touch contract before adding modes. Reader Speed already has its own domain. |
| Further Speed behavior | Clause rests, dedicated regression keys, context during playback, and alternative pacing require separate evidence and source/interaction decisions. |
| Independent Speed package release | The reusable seam exists; publishing needs versioning, compiled output, licensing, and a release contract. |
| New inventory fields | Token-length distributions, sentence quartiles, per-text growth, and shared/exclusive types require bounded versioned evidence and fixtures; they cannot be inferred from current totals. |
| New statistical methods | Syllable readability needs a language resource and error profile; Delta/Cosine Delta and Poisson bursts need method fixtures and query contracts. Unit-based collocation kernels exist without a collocation operation/UI. |
| Lexical overlap/density and language suggestions | Compare each text with the rest; name method/resource/token-class policy. Resolve common-word provenance before using it as method evidence; never silently retokenize from a language guess. |

Reader is a full-page destination with the workbench unmounted; dialog
semantics and a focus trap for a nonexistent background remain rejected.
Barcode gesture ownership stays in the trend surface until a second consumer
needs shared policy. Dynamic-programming destination selection is unnecessary
for an independently ranked reading list; reconsider if the objective becomes
set-level coverage, variable windows, or a shared token budget.
