# Backlog — deferred improvements & simplifications

Running list of opportunities noticed during feature work that were not worth
stopping for. Anything here is unratified; promote items into an explicit
implementation scope (with an architecture consult when non-trivial) before
executing. Date each entry; delete entries when done or when work absorbs them.

## Process rule

While building a slice: if an improvement is small, in-path, and low-risk
(high ROI), do it in the same commit series; otherwise record it here and move
on.

## Open items

- **2026-07-29 · simplification residue** — small locality and normalization
  improvements (assertExactRecord throwing tier, brand-helper normalization,
  beginAtSnapshot, shared mono-button style, and similar cleanup). Treat these
  as opportunistic in-path fixes only when a feature touches the same file.
- **2026-08-09 · query authoring follow-ups** — a corpus-aware composer could
  offer vocabulary-backed suggestions and bounded precommit hit estimates,
  but first needs an explicit bounded vocabulary query. Quote-to-phrase
  tokenization likewise needs tokenizer-aware semantics before it belongs in
  the term manager.
