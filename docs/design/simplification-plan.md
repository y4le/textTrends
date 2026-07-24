# Simplification and architecture — executed record and forward roadmap

Two joint Claude+Codex full-codebase passes produced and then closed out this
document. **Pass 1 (2026-07-24) planned the cleanup; it has been FULLY
EXECUTED** — twelve reviewed commits, `875e458..3b4ee78` on
`simplify/architecture-cleanup`, every commit taken through Codex
`review-diff` to looks-good or with prescribed remedies applied and confirmed
the following round. Final verification: all four typechecks, core 279 +
extractors 11 + web 332 unit tests, production build with the lazy
transformed-format chunks intact, 26/26 Chromium functional e2e.

**Pass 2 (2026-07-24, four parallel Claude analyses + an independent Codex
planner ruling over the executed tree)** concluded that the architecture
cleanup is complete: no further repo-wide simplification phase is justified.
The remainder is the forward roadmap below — publication hardening, two
semantic defects the cleaner architecture exposed, a residue sweep, one
just-in-time seam, and then feature delivery.

---

## Part I — Executed record (pass 1)

Line references in this section describe the pre-execution tree; the commits
are the record.

- ✅ **Phase A — quick wins** (`875e458`): raw NUL bytes in the engine's
  edit-context cache key (grep saw the file as binary) → source escapes;
  TrendPanel/KwicPanel doc labels derived by regexing doc ids (user projects
  rendered UUID fragments) → `meta.title` lookups with mutation-tested unit +
  e2e coverage; actively false comments fixed; README/CLI claims made honest.
- ✅ **Phase B — ownership, typed errors, teardown** (`d6a3998`, `1f77cfa`,
  `6f2c8d9`, `4b9809b`, `bd6fd91`): the operation-lease primitive landed with
  the corrected contract (only `begin()` mints an id-bearing
  `OwnedOperationLease`); `WorkerClientError{code}` + one guarded `request()`
  harness + terminal `close()` replaced every message-string error path; the
  dead excerpt vertical, unreachable `UNKNOWN_OP`, `deleteSource`, and
  `onWarning` were deleted end-to-end; the store's six epoch lanes became
  `QueryLane`s with one `issueOn` harness and full teardown
  (dispose/HMR-fenced bootstrap); the session's five counter/token fences
  became leases over one project `OperationScope` (loadFence, genAttempt, and
  importToken deliberately stayed bespoke).
- ✅ **Phase C — contracts and single authorities** (`7e5f04b`, `60ed9c3`,
  `c9c424c`): two-tier shared guards in `core/contract/guards.ts`;
  `shared/analysis-contract.ts` + `shared/storage-contract.ts` with an
  import-boundary test (the wire module is now worker-internal +
  `lib/client.ts` only); the worker became the SOLE manifest admission
  authority — `project-loaded` carries the validated `ProjectManifestV1`,
  the session's second validation passes were deleted, and saves post
  synchronously (mutation-verified engine save-gate test);
  `PendingImport` became a staged/ready union; one `canonicalJson`.
- ✅ **Phase D — engine** (`429b0a0`): the docGate/warm-failure/structure-query
  dedups (one statement of each invariant) and the `UserDataHandler`
  extraction (`worker/user-data-handler.ts`, cancellation semantics
  verbatim-preserved). Engine: 1,925 → ~1,770 lines.
- ✅ **Phases E3/F/G subset** (`20deace`, `3b4ee78`): the V1 structure lineage
  deleted with a golden `StructureHash` pin (`satisfies`-typed fixed
  artifact); format decisions centralized on the `SOURCE_FORMATS` catalog
  (derived `isLiteralFormat` guard); the SHERLOCK corpus manifest moved out
  of the state container into `lib/project.ts`; the core barrel curated from
  a fresh mechanical audit (11 value un-exports, dead aliases deleted, stats
  surface deliberately kept and labeled, `extractDocument` documented as the
  test oracle); e2e helpers import the real DB-name constants; the
  `afterPhase` hook contract documented (Codex ruling: document-only).

**Resolved owner decisions** (2026-07-24): standard-ebooks hermeticity
deferred to the publication cut; the stats surface stays; `onWarning`
plumbing deleted (console fallback stays); split appetite D1+D2 firm, D3
provisional, D4/E1 rejected, E2 checkpoint.

### Checkpoint verdicts after both passes

| Checkpoint | Pass-1 outcome | Pass-2 fresh verdict |
|---|---|---|
| D3 QueryExecutor module | provisional → declined post-D1/D2 | **Staged**: take the cheap in-file win now (private `queryTrend`/`queryKwic`/`queryPassage` methods make `query()` a ~35-line dispatcher and subsume the resolver-map dedup); extract the full executor **just in time, immediately before the first new `QueryOp`** (the stats slice) — Codex's seam sketch is in the pass-2 ruling. Not a publication blocker. |
| D4 further generation splits | rejected | **Upheld** — claims, cap accounting, composition mutex, and publication epoch re-verified as one synchronous atomicity domain. |
| E1 ProjectModel | rejected | **Upheld** — the fences now declare themselves in one 15-line lease block; what remains is ordering policy + invariant documentation driven by a 1,336-line public-surface suite. Revisit for multi-project, undo/redo, or a second controller. |
| E2 AnalysisQueryController | checkpoint → declined post-B6 | **Upheld** — `QueryLane`/`issueOn` already centralize ownership; the passage scheduler's coupling to `get`/`set` is load-bearing. Revisit only if stats introduces a genuinely reusable scheduler. |
| G2 fixture consolidation | declined | **Narrowly overturned** — share ONLY memoized valid defaults (canonical recipes + real hashes + one visible-defaults `GenerationDocSpecV4` builder); malformed/fake-hash/cap-edge fixtures stay local so the boundary violation each test makes remains visible. |
| G3 suite reorganization | declined | **Narrowly overturned** — align tests with the production seams that now exist: move user-data behavior to `user-data-handler.test.ts` (keep engine routing tests); move query semantics to `query-executor.test.ts` when D3 lands. No cosmetic session/store/Playwright splits. |

---

## Part II — Forward roadmap (pass 2)

Ordered tracks; every commit stays independently green and non-trivial
commits go through Codex `review-diff`, as before.

### Track P — publication blockers and hardening

- **P1. Corpus rights and provenance (BLOCKS the public cut; owner-led).**
  `text/README.md` already records that `ASOIF/` and `lotr/` are not public
  domain; they are tracked full-text corpora, so this is a
  repository-distribution issue including git HISTORY, not just a deployment
  question (`text/other/common_word_list.txt` also lacks a recorded source).
  Produce a corpus inventory (source, rights basis, modifications,
  distribution status); remove anything without a documented basis; choose
  ONE publication strategy — a one-time history rewrite at branch freeze, or
  a clean public export whose history never carried them. Decide now,
  execute once at the freeze. (M; high operational care, owner-controlled.)
- **P2. standard-ebooks hermeticity (BLOCKS clean CI; owner-scheduled for
  right before the publication cut).** Both `file:../../../standard_ebooks`
  dependencies must become one immutable source — preferred: a published,
  pinned `@texttrends/standard-ebooks` carrying both the extraction and
  catalog surfaces; acceptable: vendor into the workspace with provenance.
  Keep the lazy import boundary; acceptance is a sibling-free clean checkout
  passing the full matrix. (M/medium.)
- **P3. Repo/product hardening (after P1/P2):** repository LICENSE +
  corpus/dependency notices; README rewritten to the current architecture
  (supported formats, browser-local storage and repair semantics,
  privacy/network behavior); a reproducible deploy workflow with a
  base-path smoke check (today a local `vite build` is the whole deployment
  contract); a narrowly-scoped `beforeunload` warning only while the project
  is dirty or save/persist/import is in flight. (S–M/low.)

### Track S — semantic defects exposed by the cleanup (fix now)

- **S1. KWIC stale rows are unkeyed evidence.** `KwicPanel` caches the last
  ready rows in a component `useRef` keyed by nothing, and renders them —
  with the caption computed from the CURRENT center — during any pending
  query: rows from center A can sit under "nearest to" center B, and rows
  from a departed term/snapshot survive while the new query is pending. The
  store's lanes supersede correctly; the component-local cache bypasses that
  ownership discipline. Preferred S fix per the Codex ruling: delete
  `lastReady` and show the existing skeleton for every pending request. If
  stale-while-revalidate is a firm UX requirement (the ref exists for height
  stability), it becomes an M design: the STORE must carry a served-result
  identity (snapshot, center, tracks, sort, page) and the caption must
  describe the served identity — an owner UX call. Either way, add a bridge
  test: change center/terms/snapshot mid-pending and assert old rows never
  appear under the new caption.
- **S2. Durable-source corruption is misclassified and flattened.** A corrupt
  PERSISTED source (class-1 user data needing repair) is emitted as
  `CACHE_CORRUPT` — a vocabulary whose contract says "disposable cache;
  recompute" — and the session flattens external-not-attached /
  persisted-missing / persisted-corrupt / rehydrate-failed into one generic
  `external-missing`, so the UI can only say "source missing." Carry a
  closed `SourceRepairReason` through the existing warm-miss/source-status
  path (no new notification bus); classify a post-read hash mismatch as
  `persisted-corrupt`; keep retention + the existing reattachment flow; let
  the UI distinguish "reattach your file" from "the durable copy is
  damaged." Note: the IDB envelope check validates shape/length, not the
  content hash — a same-length mutation surfaces late; add the real-browser
  test that mutates persisted bytes in place, observes the repair state,
  reattaches, and warm-reopens. (M/medium; the engine test pinning
  `CACHE_CORRUPT` moves with the contract.)
- **S3. Small correctness batch (S each):** the engine's `detectedTables`
  bound uses global `INGEST_CAPS_V0` instead of injected `this.caps` (found
  independently by both passes; add a non-default-caps test); TrendPanel's
  unreachable `sequenceBases` fallback is mathematically wrong (`d*count[d]`
  is not a prefix sum) — make null an asserted invariant; the wire schema
  narrows passage tracks more loosely than KWIC tracks (empty `seriesId`
  admitted) — reuse `narrowTracks` and pin with one test; the series-chip
  tooltip claims chart focus controls the concordance (it does not).

### Track R — residue sweep and second-generation helpers

Grouped, commit-sized; none urgent, all cheap. From the four pass-2 analyses:

- **R1. Comment/dead-code residue (S, zero risk):** engine — orphaned
  `// 7. User-data lane` banner, the §12.7 doc comment displaced onto
  `resolveStructureDoc` (move to `queryStructure`), two stacked doc-comment
  pairs (`freezeAccepted`, `assertAssertedIdentity`), doubled "core's" typo,
  unused `ToWorkerV4`/`SourceFormat` imports; session — the comment naming
  the deleted `saveCounter`, the dead `AttachedSource.token` field (+its
  claim of a fence the lease now owns) → `Map<string, FileLike>`; client —
  the ingest-jobs-cleared-at-publication comment contradicting the code;
  `user-data-store.ts` importing `CacheRead` via `store.ts` instead of the
  storage contract; the `UserDataOpen`/`UserDataAccess` double alias;
  `validate.ts` dead `isSafeInt`; four vestigial `canonicalJson` casts;
  `validRoman`'s unreachable clause; the obsolete v3 narration in the schema
  header; `manifest.ts`'s header overstating main-thread ownership; the
  `msg()`/inline error-message twins (~15 sites — pick one home per side of
  the worker boundary).
- **R2. Guards/format completion (S–M):** add the throwing identity-tier
  (`assertExactRecord`) to `guards.ts` and delete `extraction.ts`'s private
  strict `isRecord`+`requireExactKeys` twins (rename any strict local that
  must remain — the name currently shadows the loose shared guard);
  barrel-export `isLiteralFormat`/`LiteralSourceFormat` (+ the catalog types
  from `formats.ts`) and use `isLiteralFormat` in
  `extractors/extract-source.ts` (it restates the catalog check the guard
  exists to centralize); delete `extraction.ts`'s transitional catalog-type
  re-export shim; move `lowerBound` to `index/build.ts` (its arrays' home —
  fixes the flagged ops→structure direction) and rewrite `tokenCharLength`'s
  hand-rolled search over it; share the structure `isInt`; normalize the two
  locally-declared brands onto `Brand<T,B>`; express the epub default recipe
  via `epubExtractionRecipe()` (one identity, one spelling); a `rangesByDoc`
  helper for the occurrences/trend twin; core `SOURCE_AVAILABILITIES` +
  `isSourceAvailability` so the manifest and wire derive membership from one
  authority (as formats already do).
- **R3. Second-generation helpers (S–M):** store — `beginAtSnapshot` (the
  six hand-repeated lease mints are the one place a new lane could get the
  guard wrong), `cancelCenterTimer`/`supersedePassage` for the copy-pasted
  pump teardown; session — `clearPerProjectRuntime` + `resetCasState` (the
  duplicated 14-line project-reset block is the file's highest drift risk);
  engine — `structureKeyFor` (twin five-field key assembly), the D3-cheap
  in-file query-method extraction (subsumes the triplicated resolver-map
  loops), `queryLineExcerpt` takes `gen` like its siblings, the dispatch
  catch emits through `emitError`; tests still importing neutral types
  through worker protocol re-exports move to the owning modules (then drop
  the engine's compatibility re-export); `KwicRowView` becomes a projection
  of core's `KwicRow` instead of a hand-copied subset.
- **R4. Boundary/config hardening (S):** extend the import-boundary test to
  the edges that are clean today but unguarded — `lib/*` (except client)
  importing non-protocol `worker/` modules, `shared/` as a leaf, the
  reverse `worker/ → lib|components` edge, dynamic-import syntax; the e2e
  helpers' `worker/idb-*` constant imports remain sanctioned (outside
  `src/`, deliberately anti-drift). Add `noUnusedLocals` to
  `tsconfig.base.json` (it would have caught the dead guard).
- **R5. Components (S):** one shared mono-button style (three byte-identical
  copies); one `titlesByDoc` helper (three implementations of the A2 fix);
  the TrendPanel trio (`strokePropsFor`, `totalTokens` passed via layout,
  `binTooltip`); CatalogPanel's abort-controller unmount cleanup (before any
  routing/modal work). Extract the SVG views into `components/trend/` only
  when chart work next touches them.
- **R6. Docs refresh (M, doc-only):** `analysis-contract.md` — extend the
  SUPERSEDED banner to the error taxonomy (`UNKNOWN_OP`/`ARTIFACT_CORRUPT`/
  `CANCELLED_RACE` are gone; `SOURCE_MISMATCH`/`EXTRACTION_MISMATCH`/
  `REQUEST_INVALID` are real), fix the dead `protocol.ts` pointer, add the
  v4-current delta for §12.8 (structure-edit-context, line-excerpt, kwic/2;
  the direct excerpt vertical is deleted); status banners on
  `ingest-structure-plan.md` (`deleteSource`, V1), `concordance-plan.md`
  (epochs → leases), `phase1-plan.md` (V1).

### Track F — feature-adjacent work (when features resume)

- **F1. Narrow test support, then the just-in-time QueryExecutor.** Before
  the first new `QueryOp`: land the narrow G2 support module (valid defaults
  only), extract `QueryExecutor` along the pass-2 seam (bind a read-only
  published generation + its query-derived caches; job ownership, snapshot
  validation, cancellation, and emission stay in the engine; never pass the
  whole engine), and move query/user-data tests to match the real seams
  (`user-data-handler.test.ts` can move now).
- **F2. Stats as ONE vertical slice (L; product-semantics risk).** The scalar
  functions stay; do not expose them raw or build a generic statistics
  engine. Pick one product question (e.g. keyness) and take it end to end:
  closed method id/version and boundary-valid request/result → harden scalar
  input validation (some accept degenerate totals producing non-finite
  results) → aggregate counting against a bound snapshot in core → the new
  `QueryOp` through `QueryExecutor` → one store lane → one UI → unit +
  browser evidence for supersession and snapshot identity.

### Contested — needs a ruling before acting

- **Snapshot vocabulary-merge sharing.** One pass-2 analysis argues
  `composeSnapshot`/`validateSnapshot` should share a `mergeVocabulary`
  helper (the validator would still recompute from resident shards); the
  pass-1 record holds the opposite as a leave-alone (the validator must not
  share the builder's code path, or a bug validates itself). Do not touch
  without an explicit Codex ruling; identity-adjacent.

### Standing non-goals (re-affirmed by pass 2)

No repo-wide cleanup phases driven by file size. No generation split
(`DocumentPipeline`/`GenerationCoordinator`). No `ProjectModel`, generic
store controller, state-machine framework, or command bus without a second
real consumer. No parsers/DOM/ZIP into core. No generic stats framework
ahead of a chosen product question. No universal fixture builder; no
Playwright consolidation. No merging the durable user-data and disposable
artifact-cache storage policies — Track S2 sharpens that distinction rather
than blurring it. No casual history rewriting — if publication requires it,
coordinate and do it exactly once at the freeze. `structure/build.ts` and
(post-R2) `extract/extraction.ts` stay whole unless a second implementation
seam appears; the optional `extract/recipe.ts` cut is endorsed but only
worth taking after R2 removes the shared locals.

### Suggested sequence

1. This doc closeout (done — you are reading it).
2. P1 provenance decision now; execution at branch freeze.
3. P2 hermetic dependency; prove the sibling-free clean checkout.
4. S1 + S3 small correctness commits; then S2's repair contract.
5. P3 publication hardening.
6. R1–R6 opportunistically, commit-sized, between the above.
7. F1 then F2 when feature work resumes.
