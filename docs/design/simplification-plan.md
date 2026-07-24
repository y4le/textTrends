# Simplification and architecture plan — joint review synthesis (2026-07-24)

This plan is the synthesis of a full-codebase re-review performed in parallel by four
Claude deep-dive analyses (worker layer; client/session/store; core + extractors + cli;
cross-cutting seams) and an independent Codex planner ruling, taken at branch
`simplify/architecture-cleanup` commit `375e6ae` (after Phase 0 correctness fixes and
Phase 1 format centralization). Every finding cited here was verified against the code,
not carried over from the earlier review. Guiding principle throughout (Codex):
**centralize decisions before splitting files** — ownership, contracts, and single
authorities land first; file moves come last and stay mechanical.

Line references are to `375e6ae` and will drift as phases land; they locate the
evidence, they are not the contract.

## Resolved decisions (owner, 2026-07-24)

1. **standard-ebooks `file:` dependency stays deferred.** Codex rates the
   out-of-repository `file:../../../standard_ebooks` dependency (packages/extractors,
   apps/web, lockfile) a blocking CI/hermeticity defect: a clean clone plus the CI
   frozen install cannot reproduce the local graph. Owner ruling: defer anyway; the
   library will be fixed and published right before the textTrends publication cut.
   Nothing in this plan may depend on resolving it.
2. **The idle stats surface stays.** `packages/core/src/stats/` (g2Keyness, logRatio,
   logDice, pmi, tScore, dp, dpNorm, mattr, mtld) has zero consumers but is the
   documented contract convention of docs/design/statistics.md: implemented ⇒ exported
   with hand-verified fixtures, versioned method ids referenced by future QueryOps.
   Barrel curation (F3) groups them under one labeled block; it does not trim them.
3. **`onWarning` plumbing is deleted.** The worker's `t:'warning'` channel carries
   artifact-cache health only (CACHE_UNAVAILABLE/READ_FAILED/WRITE_FAILED/CORRUPT);
   consequence is cold recomputes, never data loss (durability failures already have
   the typed `UserDataClientError` path). The unused `WorkerClient.onWarning` setter
   and listener field go; the unconditional `console.warn` fallback stays. A UI
   surface, if ever wanted, is pre-publication UX work, not cleanup.
4. **Split appetite:** D1 engine dedup and D2 `UserDataHandler` are committed; D3
   `QueryExecutor` is provisional (reassess after D1+D2); D4 further generation
   splitting is rejected; E1 `ProjectModel` extraction is rejected with a named
   re-check after Phase B; E2 `AnalysisQueryController` is a checkpoint after B6,
   not a commitment.

## Where the parallel analyses disagreed, and the resolution

- **Protocol boundary.** The Claude worker analysis refuted the original "neutral
  protocol package + domain ports" proposal: all non-worker imports of
  `worker/protocol-v4.ts` are `import type` (plus one const), so there is no runtime
  coupling to break. Codex still argued for a contract move because the wire file mixes
  domain shapes (lines 63–201) with versioned envelopes (248–291) and three type
  duplications exist across layers. Resolution: do Codex's **minimal** form (C1) —
  app-local `shared/` contract modules, pure moves and re-exports, an import-boundary
  test — and explicitly not a workspace package, not a ports framework, not a mapping
  layer.
- **Lease migration order.** Codex preferred session-first; the Claude client-layer
  analysis preferred store-first. Resolution: **store-first** — lower risk, proves the
  corrected primitive before it touches the invariant-dense save/restart/reconcile
  code.
- **Worker split shape.** Both sides independently converged: only `UserDataHandler`
  and `QueryExecutor` are real seams; the previously proposed four-way split
  (DocumentPipeline + GenerationCoordinator) is refuted because engine sections 1–5
  are one atomicity domain — claims, `transferredSourceBytes` cap accounting
  (`freezeAccepted` → `commitDocuments`), and the composition mutex are only sound
  running synchronously on shared state.

## Findings refuted from the earlier review

- `candidateReconstruction` recipe-field removal: the field is redundant as
  information but hashed into `ExtractionRecipeHash` (every persisted artifact and
  manifest key), and `upgradeStoredManifest` exists to insert it. It stays on the
  wire; its validation centralizes to the catalog (F1).
- `PLACEHOLDER_RECIPES` as dead code: it is live (import staging). The actual defect
  is the `undefined as unknown as ExtractionRecipeProvisional` escape hatch next to
  it; the fix is the C3 discriminated union, not deletion.
- Broad `idb-common` consolidation: the two stores' opposite failure policies
  (artifact: degrade to memory; user-data: typed refusal) are the design. Only
  genuinely neutral mechanics move (C1 storage contract; optionally a settle-once
  open-race helper).
- The "~50 unused core exports ⇒ dead code" framing: 94 of 197 barrel exports have no
  external consumer (verified name-by-name), but most are internally live or
  deliberate contract surface. F3 triages instead of deleting.

## Phase A — quick wins (each small, independent, no ordering constraints)

- **A1. NUL bytes.** `engine-v4.ts:1568` embeds two raw 0x00 bytes in a cache-key
  template literal — grep/rg classify the engine as a binary file and silently stop
  scanning mid-file (this corrupted searches during the review itself). Replace with
  ``\u0000`` escapes, matching the file's other composite keys (:283, :1439).
- **A2. Doc-label bug (user-visible).** `TrendPanel.tsx:63-67` derives labels by
  regexing the doc id against a hardcoded `- Arthur Conan Doyle` pattern;
  `KwicPanel.tsx:20` slices the id. User-project doc ids are `crypto.randomUUID()`,
  so imported projects render UUID fragments in chart labels, table rows, tooltips,
  scrub captions, and the concordance. Fix: `doc → meta.title` map from the session's
  project data (the `StructurePanel.tsx:58` pattern); keep a width truncation only.
- **A3. False and stale comments.** `project-session.ts:10-15` claims the session is
  "landed unused" (it is constructed in `store-instance.ts`); `idb-store.ts:4-8`
  describes the db1 name while the code defines db2; `extraction.ts:150-157` has a
  stranded "Boundary validation" jsdoc detached from its function;
  `epubExtractionRecipe`'s doc claims production staging uses it (staging uses
  `defaultExtractionRecipes` for every format). Historical commit-narrative headers in
  engine-v4/protocol-v4/store become present-tense invariants.
- **A4. Docs/CLI honesty.** README repository layout gains `packages/extractors`.
  `packages/cli` claims conformance fixtures and batch analysis but implements only
  `bench`: narrow the package/README claim to the Node benchmark/portability harness,
  drop the unused vitest devDependency and the tsconfig include of the nonexistent
  `test/` directory. No feature work to justify the old description.

## Phase B — ownership primitive, typed errors, teardown

- **B1. Fix the lease contract, then land it.** The WIP `operation-lease.ts` fits the
  fence inventory, but `OperationScope.lease()` returns the scope *revision* as the
  lease id, so two scope-only leases in one revision share an id while the id is
  documented as a monotonic correlation id (and session code compares captured ids).
  Split the contract: `OperationLease { isCurrent() }` for scope leases,
  `OwnedOperationLease extends OperationLease { id }` returned only by
  `LatestOperation.begin()` / `KeyedLatestOperation.begin(key)`. Land the corrected
  primitive with its tests as one commit.
- **B2. Typed client errors.** Replace message-string encodings with
  `WorkerClientError { code: 'CANCELLED' | 'WORKER_RESTARTED' | 'WORKER_TERMINATED'
  | 'WORKER_POST_FAILED' | 'WORKER_ERROR' }` (minted at `client.ts:276-281` and the
  restart/terminate/post sites; consumed today by six message comparisons in
  store.ts). `UserDataClientError` stays separate — its codes and `currentRevision`
  are domain data, not transport lifecycle. Worker analysis error codes ride a typed
  field instead of a `${code}: ${message}` prefix. Fakes in tests reject the typed
  error and assert the discriminant.
- **B3. Dead-vertical deletions (separate small commits, before lane migration).**
  (a) The direct `excerpt` operation end-to-end — protocol op + schema narrowing +
  engine dispatch/handler + client pending-kind/receive/API + tests; the live
  replacement is the bounded `line-excerpt` query. (b) `onWarning` per resolved
  decision 3. (c) `UserDataStore.deleteSource` — test-only, no product command.
  (d) The unreachable `UNKNOWN_OP` arm — the schema maps unknown tags to null and
  `handle()` emits PARSE_FAILED before dispatch.
- **B4. Store lease adoption + the teardown gap.** `AppRuntime.dispose()` today only
  unsubscribes and disposes the session: in-flight query handles can still mutate the
  Zustand store, the KWIC debounce timer can fire afterward, and `WorkerClient` has no
  close at all. With the store's six lanes on the lease: dispose closes the operation
  scope, clears `kwicCenterTimer`, cancels outstanding handles and the passage pending
  slot; add `WorkerClient.close()` (fence the worker epoch, reject pending promises
  with the typed error, clear maps/listeners, terminate the Worker); wire teardown at
  the composition root with a Vite HMR dispose hook. Bump-without-reissue sites become
  `invalidate()`. Tests: late settlement after dispose, queued timer after dispose,
  pending rejection + termination on close.
- **B5. Session lease adoption, lane-sized commits, highest risk in the plan.**
  Order: save/load → keyed persist/reattach → correction. Explicitly stays bespoke:
  `importToken` (entity identity in the staging two-fact join), `genAttempt`
  (externally reflected in generation ids and event correlation), `loadFence`
  (deliberately narrower than the project epoch), the posted-save
  `pendingSave.token` comparison (lease ids support it — semantics unchanged), and
  the passage pump (a one-active/one-pending scheduler, not latest-wins). Run the
  full session suite plus targeted restart/durability/override-race Playwright specs
  after each commit.
- **B6. `guardedQuery` helper.** Five store lanes repeat one skeleton
  (cancel prior → bump → precondition → capture key → issue → store cancel → guard →
  write → swallow cancellation): runKwic, runStructure, requestEditContext,
  requestLineExcerpt, and the per-series body of runQueries — ~150 duplicated lines,
  the three newest near character-identical. Build the helper on B1+B2; trend stays a
  variant; the passage pump stays out. **Checkpoint (decision 4):** after B6, decide
  E2 — extract an `AnalysisQueryController` only if store.ts still reads as two files
  trapped in one.

## Phase C — contracts and single authorities

- **C1. Neutral app-local contracts (minimal form).** `shared/analysis-contract.ts`:
  generation/override/warm-miss/query/structure/edit/excerpt DTOs, importing
  `SourceFormat` and `SourceAvailability` from core — deleting the wire's independent
  `SourceAvailability` declaration. `shared/storage-contract.ts`: `ReadResult`/
  `CacheRead` and the durable-open union — deleting the structurally-synced-by-comment
  `UserDataAccess`/`UserDataOpen` twins and the cross-store `CacheRead` import.
  `protocol-v4.ts` keeps the protocol version, wire-only codes, and envelopes.
  Components and lib stop importing `worker/` paths (`StructureEditor` takes its type
  from the store's `EditContextState`); `client.ts` re-exports what consumers need.
  An import-boundary test locks `components/` and `lib/` out of `worker/protocol-*`.
  Two green commits: types + re-exports, then consumer imports. Explicitly not a
  workspace package and not a ports framework.
- **C2. One manifest admission authority.** Deep manifest validation (which recomputes
  every recipe/override hash) currently runs in the worker on load and save *and*
  again in the session on load, reconciliation, and save. The worker is the sole
  durable-storage actor: keep upgrade + deep validation there, type the loaded result
  as `ProjectManifestV1`, delete the session's second deep pass, and let save-side
  REQUEST_INVALID map into a typed durable failure. The main thread keeps cheap
  construction invariants only. Preserve corrupt-record retention, CAS semantics, and
  uncertain-write reconciliation tests unchanged. Precedes D2.
- **C3. `PendingImport` becomes a discriminated staged/ready union**, deleting the
  `undefined as unknown as ExtractionRecipeProvisional` cast and the
  recipes/recipesReady twin fields at the identity boundary. `PLACEHOLDER_RECIPES`
  folds into the staged arm.
- **C4. One canonical JSON.** `project-session.ts:1560` defines a weaker local
  `canonicalJson` under the same name as core's strict authority; reconciliation
  imports core's instead.
- **C5. Shared primitive guards.** Six independent copies of the non-negative
  safe-integer guard and three of `isRecord` across core and web consolidate into
  `core/contract/guards.ts` (also the truer home for `exactRecord`/`exactArray`).
  Caution: the wire-schema `isRecord` excludes arrays — variants are not
  interchangeable; each boundary keeps its required strictness.
- **C6. Warning-code ownership direction.** `idb-store` imports its own warning
  vocabulary from the wire file (backwards — the user-data side correctly defines
  store codes and lets the wire be a superset). Define `StorageWarningCode` beside
  `CacheRead`; the wire aliases it.

## Phase D — worker engine, proven seams only

- **D1. Internal dedup first (committed).** One commit, ~325 lines: use the existing
  `docGate` helper at the ~15 sites that inline its exact body (the non-throwing
  `owns` checks stay); extract `classifyWarmFailure` for the two byte-identical
  warm-failure catch blocks (preserving and documenting the deliberate
  RangeError→miss divergence from `mapError`); extract `resolveStructureDoc` +
  `bindSectionRows` for the ~80 lines duplicated between `queryStructure` and
  `queryStructureEditContext`.
- **D2. `UserDataHandler` extraction (committed).** The user-data section touches only
  `userData`, `cancelledJobs`, `emit`, and one cap — no generation state, its own
  error channel and cancellation helper. Extract a ~150-line class injected with the
  durable access provider, caps, a cancellation predicate, and a narrow emitter; the
  engine keeps job bookkeeping. After C2 so the admission decision is settled.
  Black-box engine tests do not move yet.
- **D3. `QueryExecutor` extraction (provisional — reassess after D1+D2).** The query
  section's caches already live in `GenerationStateV4`, so the state design
  anticipates the seam. Cost: `GenerationStateV4` becomes a shared internal module;
  the executor takes `getGeneration`, the cancellation predicate, `emit`,
  `yieldControl`. Lean: do it, leaving the remaining engine centered purely on
  generation/ingest atomicity — but confirm the need once D1+D2 have landed.
- **D4. No further generation splitting (rejected).** Sections 1–5 are one atomicity
  domain. At most a single `GenerationRuntime` later, and only if a real feature
  forces it.

## Phase E — main thread (mostly declined)

- **E1. No `ProjectModel` split (rejected; re-check after Phase B).** Lease adoption
  deletes the five counters and four `*Stale()` helpers — most of the file's
  mechanical weight. What remains is invariant-dense policy, ~40% deliberate
  documentation, fully driven through its public surface by a 1,314-line suite.
  Extraction would thread a mutable model and publish callback through every
  collaborator: indirection without decoupling. Revisit only when adding a new lane.
- **E2. `AnalysisQueryController`: checkpoint after B6** (see there). If extracted:
  it owns the query lanes and passage pump; Zustand state shape and UI actions stay
  in store.ts; inject narrow `getState`/`publish` — no generic query framework.
- **E3. Move the built-in corpus fixture (committed, trivial).** The SHERLOCK hash
  manifest and `sherlockProjectData()` move from store.ts to `lib/builtin-project.ts`
  beside `buildBuiltinProjectData`; store-instance and the Playwright helpers import
  from there — e2e stops importing a state container for fixture metadata.

## Phase F — core layout and public surface

- **F1. Catalog-lookup centralization in extraction.ts (committed, do regardless of
  any split).** Replace the inline `format === 'epub' || format === 'html'` checks
  with the catalog's `extractionKind`; replace the per-format
  `candidateReconstruction` literals in `validateExtractionRecipe` with
  `SOURCE_FORMATS` lookups; delete `htmlExtractionRecipe` (third restatement of the
  decoder-policy literal; tests use `defaultExtractionRecipes()`); hoist one shared
  decoder-literal builder.
- **F2. Optional source-layout splits (moves only).** extract/{recipe, artifact,
  pipeline} and structure/{recipe, detect, override, artifact}, each retaining
  exactly one exported finalizer / one admission authority / one canonical override
  path. Only after the web boundaries stabilize; a later commit may adjust exports,
  never the same commit.
- **F3. Barrel curation (after F2).** Verified: 94 of 197 exports have no consumer
  outside core. Triage: delete the genuinely dead (rootOnlyStructure +
  StructureArtifactV1 + structureHash via F4; epub/htmlExtractionRecipe;
  Txt/MdExtractionRecipe aliases; demote `extractDocument` to a marked test oracle);
  un-export ~37 internally-live helpers; keep the stats surface (decision 2) under
  one labeled block; keep zero-cost type exports; merge the fragmented duplicate
  export blocks. Not a blanket delete.
- **F4. V1 structure lineage removal.** `StructureArtifactV1`/`rootOnlyStructure`/
  `structureHash` are production-dead (no persisted path can produce V1) but prop up
  core test fixtures. Port ~5 fixture files to a V2 root-only builder first, then
  collapse `ReadyStructure` to V2 and delete the trio. No persisted identity moves.
- **F5. Small twins.** Two identical `lowerBound` binary searches; two different
  `TokenRange` types under one name (rename selection's to `SelectedTokenRange`);
  `hashSourceBytes` moves beside the other hashing in `contract/hash.ts`; drop the
  `SourceDescriptorV4 = SourceDescriptorV1` pass-through alias (other version
  suffixes stay — they encode real per-shape versioning).
- **F6. Extractors polish.** The `afterPhase` hook asymmetry (the literal path gates
  only at decode→extract; both engine call sites re-gate after return, so the
  transformed path double-gates) — resolve only after a Codex consult, since
  lifecycle parity was a reviewed deliberate property; document the three different
  meanings of `suspiciousControlCount` across formats in `ExtractionEvidence`; drop
  the redundant partitions cast in epub-extract.

## Phase G — tests and e2e (follow production seams; never lead them)

- **G1. e2e duplication.** Delete the verbatim `clearArtifacts` copy in
  import.spec.ts in favor of the helpers export; helpers.ts imports
  `ARTIFACT_DB_NAME`/`USER_DATA_DB_NAME` from src instead of restating the strings.
- **G2. Shared fixture builder.** One real-hash `GenerationDocSpecV4` builder in
  `apps/web/test/support/` replaces four hand-maintained copies plus three
  recipe-hash-quad preambles; the schema test's fake-hash builder stays separate.
- **G3. Suite reorganization** happens only alongside the D/E extractions, split by
  responsibility, keeping a small composition suite per former orchestrator. The
  Playwright matrix is untouched — the real-browser specs cover transfer, IDB
  versionchange, worker restart, encodings, corruption, and race timing that unit
  tests cannot.

## Consensus non-goals

No parsers or adapter dispatch into core. No generic lease over import correlation,
the two-fact finalization join, the passage pump, or generation publication. No
four-way worker split. No generic IndexedDB repository — the artifact and user-data
failure policies stay visibly different. No new workspace package for web DTOs. No
Zustand replacement, state-machine framework, or service container. No deleting core
implementations merely for being barrel-unused. No Playwright consolidation. No
changes to artifact schemas, hashes, cache identities, cap semantics, transfer
policy, or checkpoint placement while moving code. No TrendPanel split for line
count (at most the two SVG views + scrub hook later, as navigation cleanup). No
merging the composeSnapshot/validateSnapshot vocabulary loops — the validator must
recompute, not share the builder's path. binding.ts's capability pattern and
`upgradeStoredManifest`'s verify-before-touch discipline stay.

## Verification bar

Every commit: typecheck + unit suites green. Protocol/storage/package-boundary
commits additionally require the production build (lazy-chunk facade gate). Race,
persistence, or worker-lifecycle commits require their targeted Playwright specs
before review; the full functional matrix runs at the end of each phase. Non-trivial
commits get a Codex `review-diff` per the collaboration workflow.
