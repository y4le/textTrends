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

- **2026-07-29 · docs** — Add a short *current-roadmap* document. Today a
  reader must reconcile aspirational contracts (analysis-contract.md),
  executed plans with superseded banners, explicit deferrals, and code to
  learn what exists. (Both halves of the roadmap audit flagged this.)
- **2026-07-29 · docs** — README overstates present-tense capabilities
  (keyness comparison, character sheets) and keeps the stale "total rewrite in
  progress" framing. Full rewrite is owner-gated Track P3; the false
  present-tense claims could be narrowed sooner.
- **2026-07-29 · simplification residue** — simplification-plan.md §"Still
  open" R2/R3/R5 micro-items (assertExactRecord throwing tier, lowerBound
  home, brand-helper normalization, beginAtSnapshot, structureKeyFor, shared
  mono-button style, TrendPanel trio, CatalogPanel abort cleanup, …). Owner
  declared simplification done; treat these as opportunistic in-path fixes
  only, when a slice touches the same file.
- **2026-07-29 · checkpoint** — simplification-plan D3/G2/G3 are staged
  "pending the first new QueryOp" — slice 3 (inventory/freq-list) triggers
  them; fold into that slice's plan rather than rediscovering.
