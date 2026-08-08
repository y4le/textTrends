# Backlog — deferred improvements & simplifications

Running list of opportunities noticed during feature work that were not worth
stopping for. Anything here is unratified; promote items into a plan doc (with
a Codex consult when non-trivial) before executing. Date each entry; delete
entries when done or when a plan doc absorbs them.

## Process rule

While building a slice: if an improvement is small, in-path, and low-risk
(high ROI), do it in the same commit series; otherwise record it here and move
on.

## Open items

- **2026-07-29 · simplification residue** — simplification-plan.md §"Still
  open" R2/R3/R5 micro-items (assertExactRecord throwing tier, lowerBound
  home, brand-helper normalization, beginAtSnapshot, structureKeyFor, shared
  mono-button style, …). Owner
  declared simplification done; treat these as opportunistic in-path fixes
  only, when a slice touches the same file.
- **2026-07-29 · checkpoint (CORRECTED by the slice-2 ruling)** — the first
  new QueryOp is slice 2's `dispersion/1` (the barcode had no public
  occurrence result), so F1 QueryExecutor extraction + the narrow G2 fixture
  support land INSIDE slice 2 (plan: docs/design/linked-selection-plan.md,
  commits A–B) before either new operation. D3/G3 remain assessed there.
