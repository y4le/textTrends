# Findings responsive implementation plan

Status: implementation decision, 2026-07-30

Architecture consultation: Claude Opus through Parley, artifact
`art_sha256_0c48ef8b891cd8ce58bd37181c01c4b65ae1c58cb3d63290c6c35da2c58403af`
(`req_consult_7bc1a93afca80c30`).

## Decision

Findings is a bounded research log, not a dashboard or card feed. It presents
durable records in citation order and keeps every mutation explicit. The
redesign does not change `research-state/1` or `ShareLinkV1`.

The log has a maximum reading measure of 78 characters and this DOM order:

1. conditional research/project attention;
2. Saved ranges;
3. Pinned evidence, always including `n of 8 pinned`;
4. Anchors needing review, when present;
5. Sharing;
6. Incoming shared state;
7. Research/project record; and
8. Method.

Wide screens keep Method resident. Regular and compact screens expose the same
Method through the existing governed Method sheet. Wide layout does not turn
the log into a multi-column card grid.

## Ownership and files

- `lib/findings-view.ts` owns pure row projections, hostile target parsing,
  deterministic DOM identities, staleness, and share-review summaries.
- `lib/project-save-view.ts` is the one presentation authority for project
  durability.
- `components/findings/FindingsLog.tsx` composes store state, record order,
  layers, and responsive presentation.
- `components/findings/RecordRows.tsx` renders citation-like lists.
- `components/findings/RecordDetail.tsx` renders additive record detail.
- `components/findings/ShareReview.tsx` owns the local share draft and explicit
  review/replace surface.
- `components/findings/ResearchRecord.tsx` renders research/project
  persistence and conflict actions.
- `places/FindingsPlace.tsx` only composes `FindingsLog`.

The old `ResearchPanel` and `PinnedPane` are removed after their responsibilities
move. Domain-free `FormLayer`, `SheetFrame`, and row-detail primitives remain
domain-free.

## Saved range law

A saved range row shows its name, document, and 1-based character span.
Activating it opens additive detail; it does not reveal excerpt text in the
base log.

- **preview passage** compiles the durable character anchor on a dedicated
  latest-wins lane, records a session-only row check, and issues at most one
  passage read. It never changes linked scope or durable research state.
- **use as linked range** compiles the same anchor, records the row check, and
  explicitly adopts the resulting token range as analysis scope.
- **remove** deletes the durable range and its session check.

`SelectionCheck` is session-only. Checks clear on snapshot/project replacement,
research restoration, or row removal. Failure belongs to the affected row, not
the saved-range authoring form.

## Pin and anchor law

Every pin row shows document title, 1-based token, first note line, captured
track identities, and staleness. Its detail may show the captured excerpt,
marks, exact identities, and full note. The current live passage may differ
from the captured excerpt, so **show current passage** and **open in Reader**
are separate verbs.

Removing the final pin returns focus to the pinned-evidence group heading.
Pins and pending/error captures count toward the limit. Restore issues do not
consume a live slot.

An anchor needing review shows its exact durable character range and reason.
Missing-document and text-mismatch records do not offer speculative preview or
retry. They offer removal and a route to Corpus repair.

## Share review law

A `#s=` boot route always opens the Findings base with no Evidence layer. It
prefills a local draft but never imports automatically.

Review decodes the draft and runs document matching before Replace. It states
group, document, and anchor counts plus matched and unmatched documents. The
survivor statement is exact:

> Replacing keeps your pinned evidence and replaces the notebook, active
> tracks, saved ranges, and view settings.

Invalid drafts are alerts and cannot be replaced. Compact review uses the
existing full-height `FormLayer` with sticky actions, inert background, focus
containment, and draft preservation across Back/Escape/Cancel. Regular and
wide review is inline. Replace is the only import action and pops the review
surface. A generated-share error is never rendered or copied as a link.

## Project and research persistence

Findings owns **Save project** and its status. Corpus retains project creation,
file import/drop, loading a saved project, document/source status, persistence,
reattachment, repair, and command errors. When a user project is dirty or a
save is non-idle, Corpus shows a short pointer to Findings rather than a second
save control. The built-in project is read-only, while research persistence
still applies.

Research conflicts retain explicit Reload and Overwrite actions. The attention
band precedes records so conflict/error states cannot be buried.

## Current-state Method register

Findings Method is a current-state register, not an event log. It records:

- saved-range count, exact anchors, and checks performed in this session;
- `n of 8` pins, document/token, captured tracks, and staleness;
- restore issues and reasons;
- the share policy;
- research persistence phase and conflict revision; and
- project kind, revision, dirty state, and save phase.

Its governed TSV columns are:

`kind | id | name_or_note | document | char_start | char_end | text_hash | token | captured_tracks | status`

Rows are saved ranges, live pins, then restore issues. Captured excerpt text is
excluded.

The register explicitly states its limits: there is no event history; saved
records do not retain place, focus, cursor, or live selection; range checks
clear with the snapshot; and result copy excludes captured source text.

## Responsive and accessibility acceptance

The compact journey is bound to WebKit and checks 320- and 390-pixel widths:

- no body horizontal overflow;
- all actionable controls at least 44 CSS pixels on coarse input;
- exact text inputs at least 16 CSS pixels;
- share FormLayer inertness, sticky actions, focus containment, draft
  preservation, and zero analysis queries;
- zero/capacity pin states;
- saved-range preview moving focus to Evidence without changing scope;
- last-pin focus return; and
- stable layout through presentation-class changes.

Functional acceptance proves one compile plus at most one passage for preview,
explicit apply changing scope, per-row failures, quarantine behavior, matching
before Replace, pin survival, `#s=` routing, project-save relocation, Corpus
repair routing, and the Findings Method register/TSV.

## Principled deferrals

General **Return to this** is not represented honestly by current durable
contracts: place, focus, reader cursor, and live selection are deliberately not
stored. Saved ranges therefore offer **use as linked range**; pins offer
**show current passage** and **open in Reader**. General return remains deferred
until a versioned recorded-place contract exists.

There is no provenance event history. The delivered Method view is explicitly
a current-state register. There is also no file export in this phase: the
delivered outputs are the governed Method copy actions and source-free share
links.
