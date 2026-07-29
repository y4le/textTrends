# Slice-2 handoff — linked selection, dispersion barcode, full reader

*Written 2026-07-29 for a fresh agent picking up mid-slice. Branch
`feature/product-slices`, tip `2f42c5d`. Read this file, then
`docs/design/linked-selection-plan.md` (the recorded Codex ruling — it is the
CONTRACT; this file only tracks execution state against it).*

---

## 1. Where things stand

Slice 1 (term groups + query notebook) is **complete** — see
`docs/design/term-groups-plan.md` STATUS. Slice 2 is the second of the four
adopted product slices (`docs/research/synthesis.md` §11). Its ruling splits
it into commits **A–I**; five are landed, one is mid-review, three are unbuilt.

| Commit | What | State |
|---|---|---|
| A | Shared real-hash fixtures + engine harness; user-data suite split | **landed** `c9fe8c1` (2 rounds) |
| B | Generation-bound `QueryExecutor` extraction (the F1 gate) | **landed** `bf058fe` (1 round) |
| C | `dispersion/1` core + protocol + executor | **landed** `9f1ee54` (3 rounds) |
| D | Barcode canvas strip + mark-to-KWIC | **landed** `2f42c5d` (3 rounds) |
| G | `reader-page/1` core + protocol + executor | **STAGED, round-1 changes-requested** — see §3 |
| E | Linked token selection | **store layer built (unstaged)**, gestures/UI remain — see §4 |
| F | Pinned context pane | not started — plan §F |
| H | Full reader UI and links | not started — plan §H |
| I | Slice-2 browser acceptance | not started — plan §I |

Commit order note: the ruling's letters are its own sequence. G was pulled
forward of E/F because its core kernel was draftable in parallel; **E, F, H, I
can land in any order that respects their file dependencies** (§6).

### Verified state as of this writing

```
core:  20 files, 415 tests pass          apps/web: 24 files, 505 tests pass
typecheck: clean (pnpm -w run typecheck)  build+bundle gate: OK
playwright: 38 functional + benchmark project green (before G's staged edits)
```

---

## 2. Working-tree contents (nothing is lost — read this before `git` anything)

`git status --short` currently shows three groups. **Do not run `git checkout
--` or `git stash` without reading this.**

**STAGED — commit G's candidate** (the review in §3 refers to exactly this):
```
A  packages/core/src/ops/reader.ts          (the kernel; 458 lines)
A  packages/core/test/reader.test.ts        (20 tests)
M  packages/core/src/index.ts               (barrel exports for the reader surface)
M  apps/web/src/shared/analysis-contract.ts (reader-page op + result types)
M  apps/web/src/worker/protocol-v4-schema.ts(reader-page narrowing)
M  apps/web/src/worker/query-executor.ts    (executor.readerPage)
M  apps/web/src/worker/engine-v4.ts         (dispatch + ordinal→seriesId mapping)
M  apps/web/test/query-executor.test.ts     (engine-level reader tests)
M  apps/web/test/protocol-v4-schema.test.ts (reader-page narrowing tests)
```

**STAGED+UNSTAGED (`MM`)** — `engine-v4.ts` and `query-executor.test.ts` have
*additional* unstaged edits on top of the staged version: the review-round-1
fixes for findings 2 and 3 (base-selection enforcement + cancellation tests).
`git add` them when restaging G.

**UNSTAGED — commit E's store layer** (built during G's review):
```
 M apps/web/src/lib/store.ts        (linkedSelection + overlay lanes + actions)
 M apps/web/test/store.test.ts      (6 new linked-selection tests)
?? apps/web/src/lib/selection.ts    (pure model: TokenRangeSelectionV1, detailSelection)
?? apps/web/test/selection.test.ts  (5 tests)
```

**UNSTAGED — G round-1 fix artifact**:
```
?? apps/web/e2e/reader.bench.spec.ts  (dense-page benchmark, non-gating)
```

**`?? .claude/`** is agent worktree scratch — ignorable, not part of the work.
Two dead worktrees exist under `.claude/worktrees/agent-*`; the second
(`agent-abe029a5993086800`) belongs to an agent that died on a credits error
having done nothing but copy a baseline. Both are safe to delete.

---

## 3. IMMEDIATE NEXT TASK — commit G round 2

`parley review-diff` returned **changes-requested** on the staged G candidate.
Findings 2 and 3 are **already fixed** in the unstaged `MM` edits. Finding 1 is
**not started** and is the real work.

### Finding 1 (HIGH, OPEN) — directional pages don't round-trip

Verbatim from the reviewer:

> The claimed exact forward/backward round-trip is false once the UTF-16 cap
> creates direction-dependent page boundaries. `from` keeps its start and
> greedily shrinks the end, while `before` independently keeps its end and
> greedily shrinks the start (`reader.ts:195-233`); the emitted previous cursor
> contains only `before(currentStart)` (`reader.ts:449`). With four tokens
> having starts `[0,32766,32768,32770]` and lengths `[32765,1,1,32768]`, the
> candidate produces forward pages `[0,2)`, `[2,3)`, `[3,4)`, but `before(3)`
> produces `[1,3)`, not the prior `[2,3)`. Thus Next followed by Previous can
> change the page and re-serve token 1, contradicting the file-level invariant.
> The existing text-cap test checks only `back.tokens.end === next.tokens.start`
> (`test/reader.test.ts:193-207`), so it does not prove the claimed range
> identity. Independently maximal prefix/suffix windows cannot generally be
> mutual inverses with a boundary-only cursor; resolve the contract with richer
> served cursors or canonical page boundaries, then add an adversarial
> variable-token-length round-trip test.

The flaw is real and is a **contract** flaw, not a bug: two independently
greedy maximal windows are not mutual inverses. Do not patch it locally.

**Prescribed fix — CANONICAL PAGE BOUNDARIES.** Redefine pagination so every
cursor resolves onto ONE canonical partition of the document:

1. The partition is computed greedily **forward from token 0** under the
   effective budget: `min(maxTokens, READER_MAX_TOKENS)` tokens per page AND
   `READER_MAX_TEXT_UTF16` chars per page.
2. All three cursor kinds mean **"the canonical page containing token t"** —
   `around(t)` and `from(t)` the page containing `t`; `before(t)` the page
   containing `t-1` (i.e. the page ending at-or-after `t`). Served
   `tokens.start`/`tokens.end` are therefore always canonical boundaries, and
   `next = from(end)` / `previous = before(start)` round-trip **by
   construction** because both re-resolve onto the same partition.
3. Because a requested token may now be interior to its page rather than at
   its edge, the result must let a client see that: keep serving the exact
   `tokens` range (already present) and keep `anchor.relToken` for `around`.
   Document that `from(t)` no longer guarantees `tokens.start === t`.
4. `maxTokens` is part of the partition identity — same `maxTokens` ⇒ same
   partition. Document that clients keep it constant while paging (the
   executor and reader UI do).
5. Complexity: walk the partition from token 0 using `shard.startsUtf16` (plus
   `tokenEndChar` for final ends), binary-searching each page extent —
   O(pages·log n). The kernel stays stateless (cache nothing between calls).
6. Preserve everything else unchanged: mark slicing/clipping, `cappedBy`
   signalling, zero-track reading, member CSR provenance, fresh output arrays,
   the `READER_MAX_*` limits, and the single-oversized-token `CapError`.
   **Update the doc comments** that promise the old semantics (the file header
   and `planReaderPage`'s comment block both do).

The code to replace is the window-shaping block in `planReaderPage`,
`packages/core/src/ops/reader.ts` roughly lines 190–235 (from `// Token
budget, then mode-shaped ideal window.` through the `cappedBy` assignment).
Everything above it (validation) and below it (materialization, marks) can
stay.

**Required tests** (extend `packages/core/test/reader.test.ts`):

- **The reviewer's counterexample verbatim**: four tokens with UTF-16 lengths
  `[32765, 1, 1, 32768]` (build real text — long unbroken letter runs
  separated by spaces — and assert the shard tokenizes to exactly 4 tokens).
  Walk forward from 0 collecting page ranges; then from the last page walk
  backward via served `previous` cursors; assert the backward ranges are
  **exactly the reversed forward ranges** (range identity, not just boundary
  equality — that is what the old test got wrong), and that no token is served
  twice in either direction.
- **Seeded randomized round-trip**: ~200 tokens of deterministic pseudorandom
  lengths 1..600 chars, `maxTokens=20`. Forward walk and backward walk must
  produce identical partitions; a mixed walk (fwd, fwd, back, fwd, back…) must
  never gap or overlap.
- Keep every existing test passing, including `around` anchor retention, the
  single-oversized-token `CapError`, and mark clipping at both page edges.

### Finding 2 (MEDIUM) — FIXED, verify before restaging

The reader is a whole-corpus context surface, so a narrower wire selection
would silently filter its marks. The engine now enforces exact base-ness
(`engine-v4.ts`, in the `reader-page` branch: every snapshot doc, no ranges,
else `REQUEST_INVALID`). Regressions in `query-executor.test.ts` cover subset,
ranged, and the reviewer's `{docs: []}` silent-zero-marks case, plus a
both-docs positive control. **Open question the reviewer raised and did not
settle: whether to keep `selection` on the wire at all** (the alternative is
removing it and constructing the base selection inside the executor). Current
choice: keep it + enforce. State that choice in the round-2 scope so the
reviewer rules on it explicitly.

### Finding 3 (LOW) — FIXED, verify before restaging

Phase-tied cancellation tests added (cancel at yield ordinals 2 and 4 → job
cancelled, no result, no error) plus `apps/web/e2e/reader.bench.spec.ts`: a
node-side real-engine dense-page benchmark (60k-occurrence document, warmed
median of 7, `testInfo.attach` JSON to the retained benchmark artifact
surface, non-gating). Last run: **0.41 ms** median for a 400-token/400-mark
page. Remember to `git add` this new file.

### Round-2 procedure

```bash
# after the kernel rework
cd packages/core && npx tsc --noEmit -p tsconfig.json && npx vitest run
cd /home/yale/dev/textTrends && pnpm -w run typecheck
cd apps/web && npx vitest run && npx playwright test --project=chromium-functional
cd /home/yale/dev/textTrends && pnpm -w run build      # ends in the bundle-contract gate
git add packages/core/src/ops/reader.ts packages/core/test/reader.test.ts \
        packages/core/src/index.ts apps/web/src/shared/analysis-contract.ts \
        apps/web/src/worker/protocol-v4-schema.ts apps/web/src/worker/query-executor.ts \
        apps/web/src/worker/engine-v4.ts apps/web/test/query-executor.test.ts \
        apps/web/test/protocol-v4-schema.test.ts apps/web/e2e/reader.bench.spec.ts
parley review-diff --scope '<what changed, what to scrutinize>' --root "$PWD" --json
```

**Do NOT stage E's files** (`lib/selection.ts`, `lib/store.ts`,
`test/selection.test.ts`, `test/store.test.ts`) into G's review — keep reviews
one-commit-shaped.

---

## 4. Commit E — linked token selection

Plan §E and §2. **The store layer is done and unstaged**; the gesture and
render layers are not built.

### Done (unstaged, tested — web suite 505 includes these)

- `apps/web/src/lib/selection.ts` — pure: `TokenRangeSelectionV1`
  (`{snapshot, doc, tokens:{start,end}}`), `isValidSelection`,
  `commitRange` (inclusive endpoints → half-open, clamped, single-doc), and
  **`detailSelection`** — the ONE wire-selection builder every analytical
  detail consumer must use. 5 tests, including the ruling's named trap: a
  selection emits `docs: [doc]` + one range, because `ranges` scopes only the
  documents it names and `docs: [everything] + one range` would silently mean
  "that range in this doc **and all of every other document**".
- `apps/web/src/lib/store.ts` — `linkedSelection`, `selectedTrends`,
  `selectedDispersion` state; `selectedTrendLane`/`selectedDispersionLane`
  (separate latest-wins lanes so a brush never cancels the resident baseline);
  `runSelected()`; `setLinkedSelection(sel|null)` (validates, reissues detail
  consumers only); KWIC now issues `detailSelection(...)` with a
  same-selection lease guard; snapshot replacement clears the selection via
  `runQueries`' revalidation; `centerKwicAt` clears an incompatible range
  before centering (ruling: a deliberate occurrence activation must yield a
  concordance capable of containing it). 6 store tests pin all of this.

### Remaining for E

1. **Brush gestures** in `TrendPanel`'s `ScrubSurface`
   (`apps/web/src/components/TrendPanel.tsx`):
   - Pointer: capture on down, begin a brush only after a small movement
     threshold, clamp the endpoint to the **origin document** (crossing a book
     boundary must not create a multi-document range), commit once on
     pointer-up via `commitRange` + `setLinkedSelection`.
   - Keyboard: an **explicit, announced selection mode** (do not overload the
     existing Shift+Arrow fast scrub ambiguously) — start at the scrub cursor,
     arrows move the endpoint, Enter commits, Escape cancels.
   - **Preview is component-local state and issues NO queries** — pointer
     motion and keyboard extension must never hit the store. Only the commit
     does. A click without a drag remains the axis-pin gesture (see F).
2. **Range shading** in both chart layouts, drawn from the committed range.
3. **Selected trend overlay**: render `selectedTrends` over the intact
   baseline, **only where `binTokens > 0`** — zero-denominator bins are gaps,
   never zero-rate observations. Keep the baseline arrays and shared scale.
4. **Selected dispersion layer**: the whole-corpus strip stays as dim context;
   the selection's own dispersion renders over it (`BarcodeStrip` already
   takes a result — either a second instance/layer or an explicit overlay
   prop; keep ONE consistent path, because density mode needs a second result
   and cannot be filtered client-side).
5. **Notebook counts**: while a range is active show "N selected / M corpus"
   rather than silently relabelling the corpus total
   (`apps/web/src/lib/notebook-view.ts` owns count qualification —
   `GroupCountVM` is where a `selected` variant belongs).
6. **Browser spec** (job-correlated, per repo rule): rapid brush A→B with a
   delayed A settlement, clear-while-pending, snapshot replacement, pointer
   brush, keyboard brush, and exact KWIC containment (every row inside the
   range).

Ruling invariants to honour: one nonempty half-open single-doc range; no
queries during preview; the selected wire spec contains only that document;
baseline evidence retained; zero-denominator bins are gaps; all lanes reject
stale selection/track/snapshot results.

---

## 5. Commits F, H, I — not started

Read the plan doc sections; they are precise. Summary of the load-bearing
requirements:

**F — pinned context pane** (plan §F). Independent bounded pin intents
(**eight means eight, with a visible refusal — no FIFO eviction**), immediate
reuse of an already-serving passage, distinct pending/error/ready/remove
states, pins **capture their query semantics** (so a later semantic edit does
not silently relabel pinned evidence), duplicate location focuses the existing
pin, removed/old-snapshot pins never land. Click-to-pin is the axis click
gesture (hover-only evidence is the anti-pattern this closes). Targeted
job-correlated Playwright: click-to-pin, two overlapping pending pins,
remove-before-result, snapshot clear.

**H — full reader UI** (plan §H). A **lazy** drawer (the entry-bundle budget
is enforced by the bundle-contract gate), navigation, highlights from
`reader-page/1` marks, selection shading, and open paths from KWIC rows, the
barcode, pins, and the passage line. Reissue current-page highlights on
semantic active-track changes. Invariants: the displayed page identity always
matches the live cursor/snapshot/track projection; rapid navigation cannot
flash an old page; stale evidence cannot open against a replacement snapshot;
**source markup is never mounted**.

**I — slice-2 acceptance** (plan §I). One deterministic end-to-end journey:
multi-member group → exact barcode totals → tick into KWIC → brush a range and
prove the trend overlay, barcode layer, selected/corpus counts, and every KWIC
row are in range → pin an axis passage → open it in the reader → page
forward/back with no gap → clear the range and restore baseline behaviour.
Include keyboard-only brush and reader navigation. No live network.

Phase end (after I): full matrix — typecheck, all units, prod build + bundle
contract, full functional Playwright, then the serial benchmark project. Then
write a STATUS block into `docs/design/linked-selection-plan.md` exactly like
the one at the top of `docs/design/term-groups-plan.md`, and update the
memory file (§7).

---

## 6. How to work here (learned the hard way this session)

**Collaboration is mandatory, not optional.** Per
`~/.claude/projects/.../memory/texttrends-workflow.md`: consult Codex before a
phase, `parley review-diff` before every non-trivial commit, and land nothing
on a `changes-requested` verdict. Fourteen review rounds across slice 1 and
nine so far in slice 2 caught real defects every single time — including two
HIGHs that would have shipped silent data corruption (dispersion misreading
snapshot ordinals for subset selections) and a false contract claim (this
reader round-trip). Treat a verdict as authoritative; fix, restate precisely,
and re-review.

**Review scopes must be honest and specific.** State what changed, what to
scrutinize, every deliberate deviation from the ruling, and every verification
you actually ran. The reviewer checks claims — an overstated scope wastes a
round.

**Tests must be load-bearing.** Repeated review lesson: a test that passes
because of an unrelated fallback, or that asserts a state the action already
had, proves nothing. Observe the *mutated interval itself*, job-correlate every
browser assertion (`submitAndAwaitFreshResults` / post-mark job matching), and
verify a test fails when the production line it covers is reverted.

**Parallelism that worked** (the owner asked for it explicitly): while one
commit sits in review, build the next commit **on files the in-flight review
does not touch**. Reviews stay strictly serialized (one staged tree, clean
receipts); only implementation overlaps. Worktree subagents can draft
brand-new files (the reader kernel came that way), but budget for integration
review — an agent's deviations still need restating and ruling.

**Editing gotchas:**
- `engine-v4.ts` contains literal NUL bytes in some cache keys; Python
  `.index()`/`grep` slicing can mis-cut it. Use line-based landmarks, verify
  with `tsc` immediately, and `git checkout --` to recover (it worked twice).
- `store.ts` has several identical `runKwic(); },` tails. Anchor edits with the
  enclosing method name or you will patch the wrong action (happened once).
- The KWIC caption renders **1-based** token numbers; browser assertions on it
  must add one.
- Shell `cd` does not persist between `Bash` calls the way you expect after a
  backgrounded command — prefer absolute paths.

**Commands:**
```bash
pnpm -w run typecheck                  # all packages
pnpm -w run build                      # ends in "bundle contract: OK"
cd packages/core && npx vitest run
cd apps/web && npx vitest run
cd apps/web && npx playwright test --project=chromium-functional
cd apps/web && npx playwright test --project=chromium-benchmark
```

---

## 7. Standing owner decisions and deferred items

Unchanged, do not re-litigate:

- **Corpus rights** (ASOIF/LOTR still tracked), **Standard Ebooks
  hermeticity/npm publish**, and **LICENSE/README/deploy hardening** are P0
  publication gates but **owner-scheduled**, not slice work
  (`docs/design/corpus-inventory.md`, `simplification-plan.md` P2/P3).
- The branch is **not merged to master** — the owner merges.
- `docs/design/backlog.md` holds opportunistic items (the non-group
  `.every` hole-skipping sweep in `protocol-v4-schema.ts`, a current-roadmap
  doc, README present-tense overclaims). High-ROI in-path fixes may be taken
  during a slice; everything else waits.
- Durable notebook persistence, quote-to-phrase tokenization, and the
  corpus-aware query composer are deferred out of slice 1 by ruling; the
  composer needs a vocabulary QueryOp.
- Memory lives at
  `~/.claude/projects/-home-yale-dev-textTrends/memory/` — update
  `texttrends-slice1-term-groups.md` (it tracks slice-2 execution too, despite
  the name) and `MEMORY.md`'s index line as you go.

## 8. After slice 2

Slice 3 (**corpus inventory + book dashboard**) and slice 4 (**two-text
dueling keyness**) per `docs/research/synthesis.md` §11 and the roadmap audit
(`docs/design/backlog.md` corrected checkpoint). Both open with a fresh Codex
planner consult recorded verbatim into a new `docs/design/*-plan.md`, exactly
as slices 1 and 2 did. Slice 3 is where the stats kernels
(`g2Keyness`/`dp`/`mattr`/…) finally get their first consumers.
