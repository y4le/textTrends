# Transient UX execution checklist

Transient execution checklist — not design authority. Superseded by `workbench-ux.md` and
`product-decisions.md`. Delete after owner review.

| # | commit | status | staged-diff review | notes |
|---:|---|---|---|---|
| 1 | `fix(terms): open quick entry from every input` | in progress | pending | Pointer, touch, and keyboard share the inline path; advanced draft handoff. |
| 2 | `refactor(labels): name controls in words` | planned | pending | Copy and accessible names only. |
| 3 | `feat(shell): add a visible Find control` | planned | pending | Pointer-reachable Find at phone width. |
| 4 | `feat(settings): unify the settings pane` | planned | pending | Display preferences, theme, shell and Reader entrance. |
| 5 | `feat(settings): host place settings in one pane` | planned | pending | Contextual landing and Compare draft ownership. |
| 6 | `feat(display): add the density preference` | planned | pending | Three stops; current pixels remain Compact. |
| 7 | `feat(display): scale data row pitch` | planned | pending | One metrics authority and semantic scroll anchors. |
| 8 | `feat(terms): make the compact rail legible` | planned | pending | Fixed rail and identifiable overflow treatment. |
| 9 | `feat(compare): favour identity in compact rows` | planned | pending | Preserve complete term identity before statistics. |
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
