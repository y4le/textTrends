# Internal design index

Each contract has one home. User workflows and interface facts live in the
[README's documentation index](../../README.md#documentation); these notes
explain implementation boundaries, deciding reasons, and change gates.
Executable types, validators, and tests resolve disagreements with prose.

| Change | Read first |
| --- | --- |
| Extraction, identity, coordinates, protocol, persistence semantics | [Analysis contract](analysis-contract.md) |
| Formula, denominator, statistical result, deterministic ranking | [Statistical methods](statistics.md) |
| Runtime ownership, persistence lifecycle, navigation, stylesheet cascade | [Application composition](architecture/application-composition.md) |
| Portable workspace files, restoration transaction, settings, other tabs | [Workspace backup](workspace-backup.md) |
| Inputs, Terms, places, Find, settings, responsive shell | [Workbench UX](workbench-ux.md) |
| Matches merge, sparse axis, virtualization, shared cursor | [Continuous Matches](continuous-matches.md) |
| Fitted Read, Atlas, source navigation, chrome | [Reader](spatial-reader.md) |
| Speed framing, pacing, source continuation, package boundary | [Speed reader](rsvp-reader.md) |
| Tour, contextual notes, guide navigation and persistence | [Guided learning](guided-learning.md) |
| Performance claim or engine redesign | [Benchmarks](benchmarks.md) |
| Public distribution, corpus exclusion, licensing | [Publication inventory](corpus-inventory.md) and [source provenance](../../text/README.md) |
| Project artwork | [Card SVG](card-svg.md) |
| Unfinished work or proposed scope | [Roadmap](current-roadmap.md) |

## Maintenance

Keep current behavior and its deciding reason in the owning contract. Keep
unimplemented work in the roadmap with its prerequisite or decision still
needed. Update both when work ships; do not retain a completed execution plan
as a second specification.

User docs separate learning, task guidance, reference, and explanation by reader
need. Add a page only when its purpose or audience warrants one, and route to
it from the README. Internal docs need precise boundaries rather than a matching
folder taxonomy. Name controls by their accessible label; include the glyph
when a control has no visible text (for example, Add term, the `+` control).
Prefer links to types and tests over copied interfaces, UI
scripts, or lists of every control.

Retain dated measurements with method, fixture, and scope. Remove obsolete
screenshots, line-number reviews, review receipts, and delivery ledgers after
their unresolved findings and durable decisions have been incorporated. Git
history retains those records; an archive folder would keep a second,
contradictory documentation set in circulation.
