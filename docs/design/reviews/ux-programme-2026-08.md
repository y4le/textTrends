# Transient UX execution checklist

Transient execution checklist — not design authority. Superseded by `workbench-ux.md` and
`product-decisions.md`. Delete after owner review.

| # | commit | status | staged-diff review | notes |
|---:|---|---|---|---|
| 1 | `fix(terms): open quick entry from every input` | done · `34a1a7f` | `req_review_diff_236bd3eda34faf30` · approved | Pointer, touch, and keyboard share the inline path; one-shot advanced draft handoff. |
| 2 | `refactor(labels): name controls in words` | done · `3d1b626` | `req_review_diff_bbcd1cd9ee251d93` · approved | Visible language for layout, Compare actions, and Matches columns. |
| 3 | `feat(shell): add a visible Find control` | done · `ed64af2` | `req_review_diff_499fd283694446cb` · approved | Pointer-reachable Find at phone width. |
| 4 | `feat(settings): unify the settings pane` | done · `e5c0e22` | `req_review_diff_8038b7c596c50cff` · approved | Display preferences, theme, shell and Reader entrance. |
| 5 | `feat(settings): host place settings in one pane` | done · `2afbdda` | `req_review_diff_30c7ab4620bdfda3` · approved | Contextual landing and Compare draft ownership; close discards consistently per `req_consult_84690c5cd85eafca`. |
| 6 | `feat(display): add the density preference` | done · `d2b846f` | `req_review_diff_722abe1163fe5e85` · approved | Three stops with one metrics authority; rendered Compact layouts retain their prior geometry. |
| 7 | `feat(display): scale data row pitch` | done · `8ecfd00` | `req_review_diff_647f0cb44eb79f04` · approved | Matches keeps its corpus anchor; Vocabulary keeps its first fully visible row; Compare remains measured. |
| 8 | `feat(terms): make the compact rail legible` | done · `afa4cf3` | `req_review_diff_e92346897dcfd2f7` · approved | Two complete names at 390px, a live range cue, painted overflow edges, and pointer-aware target floors. |
| 9 | `feat(compare): favour identity in compact rows` | done · `2c04416` | `req_review_diff_ed31deb2a54d7cb5` · approved | Complete compact term identity, retained comparison bars, and exact lift in the accessible name and row detail. |
| 10 | `feat(inputs): foreground import and collapse acquisition` | done · `4be1a6e` | `req_review_diff_c193b1288dfaa91b` · approved | Empty/corpus states, trust line, asymmetric verbs, save-only library path, and coarse target floors. |
| 11 | `feat(matches): show corpus-edge context bands` | done · `519a201` | `req_review_diff_001783d0ebcabdfc` · approved | Centred geometry is frozen; painted edge bands have equivalent accessible descriptions. |
| 12 | `feat(filters): filter literally by default` | done · `74f6138` | `req_review_diff_9bf54142896ed542` · approved | Literal/regex contract, exact migration, compact fit, and pointer/keyboard focus split per `req_consult_758335124003a436`. |

## Ratified decisions this programme implements

- One Settings pane with Display → This place → Help & method, reached without URL/history changes.
- Device-local density/theme preferences remain separate from workspace-local analytical settings.
- Compact matches today's geometry; Standard becomes the default; analytical encodings do not scale.
- Reader prose and RSVP type are excluded from UI density; Reader chrome may scale and refit.
- Terms stay fixed while corpus-edge context fills otherwise empty Matches space.
- Literal vocabulary filtering is the default; regex remains an explicit advanced mode.
- Architecture freeze: Parley request `req_consult_09d491e1a04c6012`.

## Execution result

- Twelve focused implementation commits were reviewed from immutable staged
  snapshots by pinned Claude Opus; requested corrections were re-staged and
  re-reviewed before commit.
- `pnpm typecheck` and `pnpm test` pass in the combined working tree: 1,356
  tests pass and one is skipped. The commit-only snapshot intentionally omits
  concurrent RSVP work; Opus confirmed its RSVP-only type/test failures are
  identical to the commit-12 base and that the filter slice is delta-neutral.
- The compact Vocabulary suite passes 20/20 across Chromium and WebKit after
  Opus caught a 320×568 table-port regression. The corrected field stays full
  width and the sort controls remain reachable.
- Durable authority is now recorded in `workbench-ux.md` and
  `product-decisions.md`. This file remains transient and can be deleted after
  owner review.

## Owner review checklist

- [ ] In Terms, activate Add by pointer, touch, and keyboard; each path opens
  the same inline quick-entry field and preserves an advanced draft once.
- [ ] At 320–390px, confirm visible **Find**, **Settings**, **Add**, and
  **Manage** language; confirm at least two complete term names, the range cue,
  and horizontal-overflow edge fades.
- [ ] Open global Settings and confirm Display → This place → Help & method.
  Open Trend settings and the Compare gear and confirm they enter the same pane
  at the right form, close/Escape restore focus, and Back history is unchanged.
- [ ] Move UI density through Compact, Standard, and Comfortable at regular and
  compact widths. Confirm table/Terms pitch changes while plots, barcodes,
  Reader prose, and RSVP type do not; Matches and Vocabulary retain their
  reading anchors.
- [ ] In compact Compare, confirm the full term remains readable, the comparison
  bar remains, and exact lift is available in the accessible name and detail.
- [ ] In empty Inputs, confirm Import and analyze is primary, samples/catalog
  are subordinate, and the local-processing trust line is adjacent. With a
  corpus, confirm options collapse and Save to library does not activate text.
- [ ] In Matches, inspect the first and last occurrence: corpus-edge bands name
  the real token distance without moving rows, and a screen reader receives one
  equivalent description rather than the painted duplicate.
- [ ] In Vocabulary, confirm literal `ALP` matches case variants, literal `[` is
  valid, regex is explicit and case-sensitive, invalid regex retains the last
  valid rows, × retains mode, pointer toggles return to typing, and keyboard
  Space retains checkbox focus.
- [ ] Save/reload the Vocabulary filter and open legacy regex/prefix fixtures;
  confirm migration to regex mode and that subsequent workspace output contains
  only `{ mode, query }`.
