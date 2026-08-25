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
| 9 | `feat(compare): favour identity in compact rows` | in progress | pending | Preserve complete term identity before statistics. |
| 10 | `feat(inputs): foreground import and collapse acquisition` | planned | pending | Empty/corpus states, trust line, asymmetric verbs. |
| 11 | `feat(matches): show corpus-edge context bands` | planned | pending | Keep the centre fixed; expose start/end distance at the edges. |
| 12 | `feat(filters): filter literally by default` | planned | pending | Workspace migration and explicit advanced regex mode. |

## Ratified decisions this programme implements

- One Settings pane with Display → This place → Help & method, reached without URL/history changes.
- Device-local density/theme preferences remain separate from workspace-local analytical settings.
- Compact matches today's geometry; Standard becomes the default; analytical encodings do not scale.
- Reader prose and RSVP type are excluded from UI density; Reader chrome may scale and refit.
- Terms stay fixed while corpus-edge context fills otherwise empty Matches space.
- Literal vocabulary filtering is the default; regex remains an explicit advanced mode.
- Architecture freeze: Parley request `req_consult_09d491e1a04c6012`.

## Design-doc amendments owed at the end

- Record the Settings ownership, entry, focus, persistence, and history contracts.
- Record the density metric table and exclusions.
- Record compact Terms/Compare disclosure rules and Matches edge-band semantics.
- Record Inputs acquisition states and vocabulary filter migration.
